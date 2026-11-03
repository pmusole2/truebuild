import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
    canonicalJson,
    LIMITS,
    STEP_MOTION_PROMPT_VERSION,
    stepMotionRequestSchema,
    stepMotionCacheContent,
    stepMotionResultSchema,
    type StepMotionRequest,
    type StepMotionResult,
} from '@truebuild/contracts'
import { stepMotionTextBytes, type MetaProvider } from '../providers/meta-provider'
import { STEP_MOTION_POLICY } from './ai-policy'
import { AuthenticationError, type SharedKeyAuth } from './auth'
import { BudgetError, ConcurrencyGate } from './budget'
import { createDeadline, RequestStoppedError } from './deadline'
import {
    exactModelFiles,
    ModelBodyError,
    modelFileBytes,
    readModelMultipart,
    withinModelDeadline,
} from './model-multipart'
import { validateAndNormalizeImages, type ObservationImage } from './media'
import type { BackgroundWork } from './screens/service'

const EMPTY: StepMotionResult = { scene: null }
/** Completed entries are bounded; at most two additional entries can be in flight. Restarts/replicas have separate caches. */
const CACHE_LIMIT = 1024
interface CacheEntry {
    pending: Promise<StepMotionResult>
    completed: boolean
}
class BeforeMotionDispatch extends Error {
    constructor(readonly failure: unknown) {
        super('not_dispatched')
    }
}

/** Standard rates, USD per million tokens: https://dev.meta.ai/docs/pricing-rate-limits (2026-11-03). */
export function estimatedStepMotionCostUsd(usage: {
    inputTokens?: number
    cachedTokens?: number
    outputTokens?: number
}): number | null {
    const { inputTokens, outputTokens, cachedTokens = 0 } = usage
    if (inputTokens === undefined || outputTokens === undefined) return null
    if (
        ![inputTokens, outputTokens, cachedTokens].every((count) => Number.isSafeInteger(count) && count >= 0) ||
        cachedTokens > inputTokens
    )
        return null
    return ((inputTokens - cachedTokens) * 4 + cachedTokens * 0.2 + outputTokens * 20) / 1_000_000
}

export function stepMotionCacheKey(request: StepMotionRequest, promptVersion = STEP_MOTION_PROMPT_VERSION): string {
    return createHash('sha256')
        .update(canonicalJson([promptVersion, stepMotionCacheContent(request)]))
        .digest('hex')
}

async function figure(request: StepMotionRequest, image: ObservationImage): Promise<ObservationImage> {
    let pipeline = sharp(image.bytes, { limitInputPixels: LIMITS.imagePixels })
    if (request.figureBox !== null) {
        const [x, y, width, height] = request.figureBox
        const left = Math.floor(x * image.width)
        const top = Math.floor(y * image.height)
        pipeline = pipeline.extract({
            left,
            top,
            width: Math.max(1, Math.min(image.width - left, Math.ceil(width * image.width))),
            height: Math.max(1, Math.min(image.height - top, Math.ceil(height * image.height))),
        })
    }
    const { data, info } = await pipeline
        .resize({
            width: STEP_MOTION_POLICY.maxImageEdge,
            height: STEP_MOTION_POLICY.maxImageEdge,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true })
    return { bytes: data, width: info.width, height: info.height, mimeType: 'image/jpeg' }
}

export function createStepMotionHandler(options: {
    auth: SharedKeyAuth
    provider: Pick<MetaProvider, 'generateStepMotion'> | null
    runtimeMode: 'meta' | 'fixture'
    work: BackgroundWork
    /** Allows a small bounded cache in tests; production keeps the default completed-result limit. */
    cacheLimit?: number
}): (request: Request) => Promise<Response> {
    const cacheLimit = options.cacheLimit ?? CACHE_LIMIT
    if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 1 || cacheLimit > CACHE_LIMIT)
        throw new Error('invalid_cache_limit')
    const cache = new Map<string, CacheEntry>()
    const calls = new ConcurrencyGate(2, 0)
    const trimCompleted = (): void => {
        const completed = [...cache].filter(([, entry]) => entry.completed)
        for (const [key] of completed.slice(0, Math.max(0, completed.length - cacheLimit))) cache.delete(key)
    }
    return async (request): Promise<Response> => {
        const deadline = createDeadline(105_000, request.signal)
        try {
            options.auth.authenticate(request)
            const { metadata, files } = await readModelMultipart(
                request,
                stepMotionRequestSchema,
                LIMITS.requestBytes,
                deadline,
                1_048_576,
            )
            if (new URL(request.url).searchParams.get('cacheOnly') === '1' && metadata.cacheOnly !== true)
                throw new BeforeMotionDispatch(new ModelBodyError(400))
            const fileName = `page:${metadata.page.pageId}`
            exactModelFiles(files, metadata.cacheOnly ? [] : [fileName], false)
            const key = stepMotionCacheKey(metadata)
            let entry = cache.get(key)
            if (metadata.cacheOnly && entry === undefined)
                return Response.json(
                    { status: 'unavailable', code: 'cache_miss' },
                    { status: 404, headers: { 'cache-control': 'no-store' } },
                )
            if (entry === undefined) {
                if (options.runtimeMode !== 'meta' || !options.provider?.generateStepMotion)
                    return Response.json(
                        { status: 'unavailable', code: 'unconfigured', notDispatched: true },
                        { status: 503 },
                    )
                if (
                    Buffer.byteLength(JSON.stringify(metadata), 'utf8') > STEP_MOTION_POLICY.maxContextBytes ||
                    stepMotionTextBytes(metadata) > STEP_MOTION_POLICY.maxTextBytes
                )
                    throw new BeforeMotionDispatch(new ModelBodyError(400))
                const release = calls.tryAcquire()
                if (!release)
                    return Response.json({ status: 'unavailable', code: 'busy', notDispatched: true }, { status: 503 })
                // Store the promise synchronously before any image work or dispatch: concurrent callers share one attempt.
                const pending = (async (): Promise<StepMotionResult> => {
                    let releaseWork: (() => void) | undefined
                    let generationDeadline: ReturnType<typeof createDeadline> | undefined
                    let dispatched = false
                    try {
                        const bytes = await modelFileBytes(
                            files,
                            fileName,
                            metadata.page.mimeType,
                            LIMITS.imageBytes,
                            deadline,
                        )
                        const [image] = await validateAndNormalizeImages(
                            [{ ...metadata.page, bytes }],
                            deadline.signal,
                            1,
                        )
                        const cropped = await figure(metadata, image!)
                        deadline.checkpoint()
                        releaseWork = await options.work.acquire(deadline.signal)
                        deadline.checkpoint()
                        // Once admitted, work has its own finite lifetime. A disconnected reader cannot erase a paid result.
                        generationDeadline = createDeadline(STEP_MOTION_POLICY.deadlineMs)
                        const generation = await options.work.run(
                            { deadlineMs: STEP_MOTION_POLICY.deadlineMs, signal: generationDeadline.signal },
                            () => {
                                deadline.checkpoint()
                                dispatched = true
                                return options.provider!.generateStepMotion!(
                                    { request: metadata, image: cropped },
                                    generationDeadline!.signal,
                                )
                            },
                        )
                        const parsed = stepMotionResultSchema.safeParse(generation.value)
                        const result = parsed.success ? parsed.data : EMPTY
                        const accepted =
                            parsed.success &&
                            generation.telemetry.model === 'muse-wonder-1.0' &&
                            generation.telemetry.effort === 'high' &&
                            (result.scene === null ||
                                (result.scene.stepId === metadata.stepId &&
                                    result.scene.movers.every(
                                        (mover) =>
                                            mover.actionIndex === null || mover.actionIndex < metadata.actions.length,
                                    )))
                        console.info(
                            JSON.stringify({
                                event: 'step_motion_generation',
                                promptVersion: STEP_MOTION_PROMPT_VERSION,
                                accepted,
                                model: generation.telemetry.model,
                                effort: generation.telemetry.effort,
                                usage: generation.telemetry.usage,
                                estimatedCostUsd: estimatedStepMotionCostUsd(generation.telemetry.usage),
                            }),
                        )
                        return accepted ? result : EMPTY
                    } catch (error) {
                        if (!dispatched) {
                            throw new BeforeMotionDispatch(error)
                        }
                        // Provider failure or its own deadline is terminal; reader cancellation never enters this branch.
                        return EMPTY
                    } finally {
                        generationDeadline?.dispose()
                        releaseWork?.()
                        release()
                    }
                })()
                const started: CacheEntry = { pending, completed: false }
                cache.set(key, started)
                // Reinsert on completion so iteration is completion order, rather than request or access order.
                void pending.then(
                    () => {
                        if (cache.get(key) !== started) return
                        started.completed = true
                        cache.delete(key)
                        cache.set(key, started)
                        trimCompleted()
                    },
                    () => {
                        if (cache.get(key) === started) cache.delete(key)
                    },
                )
                entry = started
            }
            const result = await withinModelDeadline(entry.pending, deadline)
            return Response.json(result, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            const notDispatched = error instanceof BeforeMotionDispatch
            const failure = notDispatched ? error.failure : error
            const status =
                failure instanceof AuthenticationError
                    ? 401
                    : failure instanceof ModelBodyError
                      ? failure.status
                      : failure instanceof BudgetError
                        ? 429
                        : 503
            const code =
                failure instanceof AuthenticationError
                    ? 'unauthorized'
                    : failure instanceof ModelBodyError
                      ? 'invalid_input'
                      : failure instanceof BudgetError
                        ? 'budget_exhausted'
                        : failure instanceof RequestStoppedError
                          ? failure.reason
                          : 'provider_error'
            return Response.json(
                { status: 'unavailable', code, ...(notDispatched ? { notDispatched: true } : {}) },
                { status },
            )
        } finally {
            deadline.dispose()
        }
    }
}
