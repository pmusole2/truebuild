import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
    canonicalJson,
    LIMITS,
    STEP_MOTION_PROMPT_VERSION,
    stepMotionRequestSchema,
    stepMotionResultSchema,
    type StepMotionRequest,
    type StepMotionResult,
} from '@truebuild/contracts'
import type { MetaProvider } from '../providers/meta-provider'
import { PIECES_DEADLINE_MS } from './ai-policy'
import { AuthenticationError, type SharedKeyAuth } from './auth'
import { BudgetError, ConcurrencyGate } from './budget'
import { createDeadline, RequestStoppedError } from './deadline'
import { exactModelFiles, ModelBodyError, modelFileBytes, readModelMultipart } from './model-multipart'
import { validateAndNormalizeImages, type ObservationImage } from './media'
import type { BackgroundWork } from './screens/service'

const EMPTY: StepMotionResult = { scene: null }
/** No eviction within this process. Restarts/replicas have separate caches; the device marker survives restarts. */
const CACHE_LIMIT = 1024
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

export function stepMotionCacheKey(
    request: Pick<StepMotionRequest, 'manualHash' | 'stepId' | 'readingLanguage'>,
    promptVersion = STEP_MOTION_PROMPT_VERSION,
): string {
    return createHash('sha256')
        .update(canonicalJson([request.manualHash, request.stepId, request.readingLanguage, promptVersion]))
        .digest('hex')
}

async function figure(request: StepMotionRequest, image: ObservationImage): Promise<ObservationImage> {
    if (request.figureBox === null) return image
    const [x, y, width, height] = request.figureBox
    const left = Math.floor(x * image.width)
    const top = Math.floor(y * image.height)
    const { data, info } = await sharp(image.bytes, { limitInputPixels: LIMITS.imagePixels })
        .extract({
            left,
            top,
            width: Math.max(1, Math.min(image.width - left, Math.ceil(width * image.width))),
            height: Math.max(1, Math.min(image.height - top, Math.ceil(height * image.height))),
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
}): (request: Request) => Promise<Response> {
    const cache = new Map<string, Promise<StepMotionResult>>()
    const calls = new ConcurrencyGate(2, 0)
    return async (request): Promise<Response> => {
        const deadline = createDeadline(105_000, request.signal)
        try {
            options.auth.authenticate(request)
            if (options.runtimeMode !== 'meta' || !options.provider?.generateStepMotion)
                return Response.json({ status: 'unavailable', code: 'unconfigured' }, { status: 503 })
            const { metadata, files } = await readModelMultipart(
                request,
                stepMotionRequestSchema,
                LIMITS.requestBytes,
                deadline,
                1_048_576,
            )
            const fileName = `page:${metadata.page.pageId}`
            exactModelFiles(files, [fileName], false)
            const key = stepMotionCacheKey(metadata)
            let pending = cache.get(key)
            if (pending === undefined) {
                if (cache.size >= CACHE_LIMIT)
                    return Response.json({ status: 'unavailable', code: 'cache_capacity' }, { status: 503 })
                const release = calls.tryAcquire()
                if (!release) return Response.json({ status: 'unavailable', code: 'busy' }, { status: 503 })
                // Store the promise synchronously before any image work or dispatch: concurrent callers share one attempt.
                pending = (async (): Promise<StepMotionResult> => {
                    let releaseWork: (() => void) | undefined
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
                        const generation = await options.work.run(
                            { deadlineMs: PIECES_DEADLINE_MS, signal: deadline.signal },
                            () => {
                                dispatched = true
                                return options.provider!.generateStepMotion!(
                                    { request: metadata, image: cropped },
                                    deadline.signal,
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
                            cache.delete(key)
                            throw new BeforeMotionDispatch(error)
                        }
                        // An unknown/invalid outcome is terminal for this key, including a cancelled first caller.
                        return EMPTY
                    } finally {
                        releaseWork?.()
                        release()
                    }
                })()
                cache.set(key, pending)
            }
            const result = await pending
            deadline.checkpoint()
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
