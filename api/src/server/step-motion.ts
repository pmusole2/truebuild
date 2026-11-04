import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
    canonicalJson,
    clampStepMotionBevels,
    dropDegenerateStepMotionShapes,
    LIMITS,
    STEP_MOTION_PROMPT_VERSION,
    stepMotionCacheIdentity,
    stepMotionRequestSchema,
    stepMotionResultSchema,
    type StepMotionRequest,
    type StepMotionResult,
} from '@truebuild/contracts'
import {
    MetaProviderError,
    stepMotionTextBytes,
    type MetaProvider,
    type ScreenGeneration,
} from '../providers/meta-provider'
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
import { stepMotionOverlapIssues } from './step-motion-geometry'

const EMPTY: StepMotionResult = { scene: null }
/** Completed entries are bounded; at most two additional entries can be in flight. Restarts/replicas have separate caches. */
const CACHE_LIMIT = 1024
/** Process-wide UTC-day ceiling on paid dispatches to this endpoint. Cache hits, refusals and failed admissions never count. */
export const STEP_MOTION_DAILY_LIMIT = 300
const DAY_MS = 86_400_000
/** A cited figure smaller than this on either side is sent with more surrounding page, so its text stays readable. */
const MIN_FIGURE_EDGE = 256
/** A cited figure covering less of the page than this is grown to it, after the minimum edge. */
const MIN_FIGURE_AREA = 0.04

interface CacheEntry {
    pending: Promise<StepMotionResult>
    completed: boolean
    /** The content identity this entry answers; a metadata-only lookup reaches the entry through it. */
    contentKey: string
}
class BeforeMotionDispatch extends Error {
    constructor(readonly failure: unknown) {
        super('not_dispatched')
    }
}

/** UTC-day ceiling on paid dispatches. Only the dispatch boundary reserves, and a failed attempt is never refunded. */
class StepMotionDailyCap {
    #day = -1
    #dispatched = 0

    constructor(
        readonly limit: number,
        private readonly now: () => number,
    ) {
        if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid_step_motion_daily_limit')
    }

    available(): boolean {
        const day = Math.floor(this.now() / DAY_MS)
        if (day !== this.#day) {
            this.#day = day
            this.#dispatched = 0
        }
        return this.#dispatched < this.limit
    }

    /** Check and increment in one synchronous step, so concurrent callers can never exceed the ceiling. */
    reserve(): void {
        if (!this.available()) throw new BudgetError()
        this.#dispatched += 1
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

const sha256Hex = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

/** Content identity: the verified raw page, its crop and every text input. Pixels are not part of it. */
export function stepMotionContentKey(request: StepMotionRequest, promptVersion = STEP_MOTION_PROMPT_VERSION): string {
    return sha256Hex(stepMotionCacheIdentity(request, promptVersion))
}

/** Full key: the content identity plus the SHA-256 of the exact JPEG bytes the model received. */
export function stepMotionCacheKey(
    request: StepMotionRequest,
    imageSha256: string,
    promptVersion = STEP_MOTION_PROMPT_VERSION,
): string {
    return sha256Hex(canonicalJson([promptVersion, stepMotionContentKey(request, promptVersion), imageSha256]))
}

export interface FigureWindow {
    left: number
    top: number
    width: number
    height: number
}

/**
 * The pixels sent for a cited figure. A region under 256 px on either side, or under 4% of the page, grows about its
 * centre until both hold. It shifts inside the page rather than shrinking, and a page under 256 px is sent whole.
 */
export function figureWindow(
    figureBox: readonly [number, number, number, number] | null,
    page: { width: number; height: number },
): FigureWindow {
    const whole: FigureWindow = { left: 0, top: 0, width: page.width, height: page.height }
    if (figureBox === null || Math.min(page.width, page.height) < MIN_FIGURE_EDGE) return whole
    const [x, y, width, height] = figureBox
    const left = Math.floor(x * page.width)
    const top = Math.floor(y * page.height)
    const region: FigureWindow = {
        left,
        top,
        width: Math.max(1, Math.min(page.width - left, Math.ceil(width * page.width))),
        height: Math.max(1, Math.min(page.height - top, Math.ceil(height * page.height))),
    }
    const needed = Math.max(MIN_FIGURE_EDGE * MIN_FIGURE_EDGE, Math.ceil(page.width * page.height * MIN_FIGURE_AREA))
    if (region.width >= MIN_FIGURE_EDGE && region.height >= MIN_FIGURE_EDGE && region.width * region.height >= needed)
        return region
    const edgeWidth = Math.max(region.width, MIN_FIGURE_EDGE)
    const edgeHeight = Math.max(region.height, MIN_FIGURE_EDGE)
    const scale = Math.max(1, Math.sqrt(needed / (edgeWidth * edgeHeight)))
    let grownWidth = Math.min(page.width, Math.ceil(edgeWidth * scale))
    let grownHeight = Math.min(page.height, Math.ceil(edgeHeight * scale))
    // A side already at the page edge hands its missing area to the other side, which stays within the page.
    if (grownWidth === page.width)
        grownHeight = Math.min(page.height, Math.max(grownHeight, Math.ceil(needed / grownWidth)))
    else if (grownHeight === page.height)
        grownWidth = Math.min(page.width, Math.max(grownWidth, Math.ceil(needed / grownHeight)))
    const centreX = region.left + region.width / 2
    const centreY = region.top + region.height / 2
    return {
        left: Math.min(page.width - grownWidth, Math.max(0, Math.round(centreX - grownWidth / 2))),
        top: Math.min(page.height - grownHeight, Math.max(0, Math.round(centreY - grownHeight / 2))),
        width: grownWidth,
        height: grownHeight,
    }
}

/** The shorter side of every frame sent to the model is at least this long. */
const MIN_MODEL_SHORT_EDGE = 512

/**
 * The size of a frame sent to the model, aspect kept. The shorter side is always at least 512 px, so the scale is the
 * larger of the shorter-side floor and the policy edge budget: a normal large page is downsampled to the edge, and a
 * narrow crop is enlarged. Null when that frame would exceed the pixel budget, so the image is refused, never narrowed.
 */
export function modelFrameSize(width: number, height: number): { width: number; height: number } | null {
    const budget = Math.min(1, STEP_MOTION_POLICY.maxImageEdge / Math.max(width, height))
    const floor = MIN_MODEL_SHORT_EDGE / Math.min(width, height)
    const scale = Math.max(budget, floor)
    const frame = { width: Math.round(width * scale), height: Math.round(height * scale) }
    return frame.width * frame.height <= LIMITS.imagePixels ? frame : null
}

async function figure(request: StepMotionRequest, image: ObservationImage): Promise<ObservationImage> {
    const window = figureWindow(request.figureBox, image)
    let pipeline = sharp(image.bytes, { limitInputPixels: LIMITS.imagePixels })
    if (request.figureBox !== null) pipeline = pipeline.extract(window)
    const frame = modelFrameSize(window.width, window.height)
    // Too large to keep the shorter side at 512 px within the budget: refused before any dispatch, never sent narrower.
    if (frame === null) throw new ModelBodyError(413)
    const { data, info } = await pipeline
        .resize({ width: frame.width, height: frame.height, fit: 'fill' })
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true })
    return { bytes: data, width: info.width, height: info.height, mimeType: 'image/jpeg' }
}

/** Reads the uploaded original, proves it is the claimed page, then crops it. Nothing here can dispatch or be paid. */
async function verifiedFigure(
    request: StepMotionRequest,
    files: Map<string, File>,
    fileName: string,
    deadline: ReturnType<typeof createDeadline>,
): Promise<ObservationImage> {
    try {
        const bytes = await modelFileBytes(files, fileName, request.page.mimeType, LIMITS.imageBytes, deadline)
        if (sha256Hex(bytes) !== request.page.contentHash) throw new ModelBodyError(400)
        const [image] = await validateAndNormalizeImages([{ ...request.page, bytes }], deadline.signal, 1)
        return await figure(request, image!)
    } catch (error) {
        throw new BeforeMotionDispatch(error)
    }
}

type SceneRejection = 'schema' | 'model' | 'effort' | 'step_id' | 'action_index' | 'declined' | 'overlap'

/** The short code a generated result is refused for, or null when usable. Only codes are logged, never model text. */
function sceneRejection(
    parsed: ReturnType<typeof stepMotionResultSchema.safeParse>,
    telemetry: { model: string | null; effort: string | null },
    request: StepMotionRequest,
): SceneRejection | null {
    if (!parsed.success) return 'schema'
    if (telemetry.model !== STEP_MOTION_POLICY.model) return 'model'
    if (telemetry.effort !== STEP_MOTION_POLICY.effort) return 'effort'
    const scene = parsed.data.scene
    if (scene === null) return 'declined'
    if (scene.stepId !== request.stepId) return 'step_id'
    if (scene.movers.some((mover) => mover.actionIndex !== null && mover.actionIndex >= request.actions.length))
        return 'action_index'
    return null
}

export function createStepMotionHandler(options: {
    auth: SharedKeyAuth
    provider: Pick<MetaProvider, 'generateStepMotion'> | null
    runtimeMode: 'meta' | 'fixture'
    work: BackgroundWork
    /** A disabled endpoint answers 404 before authentication, body reads, quota or model work. Default: enabled. */
    enabled?: boolean
    /** Process-wide UTC-day ceiling on paid dispatches to this endpoint. Default: STEP_MOTION_DAILY_LIMIT. */
    dailyLimit?: number
    /** Clock for the UTC-day boundary; tests inject one. */
    clock?: () => number
    /** Allows a small bounded cache in tests; production keeps the default completed-result limit. */
    cacheLimit?: number
}): (request: Request) => Promise<Response> {
    const enabled = options.enabled ?? true
    const cacheLimit = options.cacheLimit ?? CACHE_LIMIT
    if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 1 || cacheLimit > CACHE_LIMIT)
        throw new Error('invalid_cache_limit')
    const dailyCap = new StepMotionDailyCap(options.dailyLimit ?? STEP_MOTION_DAILY_LIMIT, options.clock ?? Date.now)
    const cache = new Map<string, CacheEntry>()
    /** Content identity to the full key of its newest entry, so a metadata-only lookup can find the verified scene. */
    const byContent = new Map<string, string>()
    const calls = new ConcurrencyGate(2, 0)
    const forget = (key: string): void => {
        const entry = cache.get(key)
        if (entry === undefined) return
        cache.delete(key)
        if (byContent.get(entry.contentKey) === key) byContent.delete(entry.contentKey)
    }
    const trimCompleted = (): void => {
        const completed = [...cache].filter(([, entry]) => entry.completed)
        for (const [key] of completed.slice(0, Math.max(0, completed.length - cacheLimit))) forget(key)
    }
    return async (request): Promise<Response> => {
        if (!enabled)
            return Response.json(
                { status: 'unavailable', code: 'not_found', notDispatched: true },
                { status: 404, headers: { 'cache-control': 'no-store' } },
            )
        const deadline = createDeadline(105_000, request.signal)
        let releaseImageWork: (() => void) | undefined
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
            const contentKey = stepMotionContentKey(metadata)
            if (metadata.cacheOnly === true) {
                exactModelFiles(files, [], false)
                const cachedKey = byContent.get(contentKey)
                const cached = cachedKey === undefined ? undefined : cache.get(cachedKey)
                if (cached === undefined)
                    return Response.json(
                        { status: 'unavailable', code: 'cache_miss' },
                        { status: 404, headers: { 'cache-control': 'no-store' } },
                    )
                const result = await withinModelDeadline(cached.pending, deadline)
                return Response.json(result, { headers: { 'cache-control': 'no-store' } })
            }
            const fileName = `page:${metadata.page.pageId}`
            exactModelFiles(files, [fileName], false)
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
            releaseImageWork = calls.tryAcquire() ?? undefined
            if (!releaseImageWork)
                return Response.json({ status: 'unavailable', code: 'busy', notDispatched: true }, { status: 503 })
            // Full uploads, including cache hits, need an image slot to prove their bytes.
            // The metadata-only recovery path above stays outside this two-entry gate.
            const cropped = await verifiedFigure(metadata, files, fileName, deadline)
            const key = stepMotionCacheKey(metadata, sha256Hex(cropped.bytes))
            let entry = cache.get(key)
            if (entry === undefined) {
                // A cache hit never reaches here, so only a new paid attempt is checked against the daily ceiling.
                if (!dailyCap.available()) throw new BeforeMotionDispatch(new BudgetError())
                const release = releaseImageWork
                releaseImageWork = undefined
                // Store the promise synchronously before dispatch: concurrent callers share one attempt.
                const pending = (async (): Promise<StepMotionResult> => {
                    let releaseWork: (() => void) | undefined
                    let generationDeadline: ReturnType<typeof createDeadline> | undefined
                    let dispatched = false
                    try {
                        releaseWork = await options.work.acquire(deadline.signal)
                        deadline.checkpoint()
                        // Once admitted, work has its own finite lifetime. A disconnected reader cannot erase a paid result.
                        generationDeadline = createDeadline(STEP_MOTION_POLICY.deadlineMs)
                        const log = (generation: ScreenGeneration, rejection: SceneRejection | null): void => {
                            console.info(
                                JSON.stringify({
                                    event: 'step_motion_generation',
                                    promptVersion: STEP_MOTION_PROMPT_VERSION,
                                    accepted: rejection === null,
                                    ...(rejection === null ? {} : { reason: rejection }),
                                    model: generation.telemetry.model,
                                    effort: generation.telemetry.effort,
                                    usage: generation.telemetry.usage,
                                    estimatedCostUsd: estimatedStepMotionCostUsd(generation.telemetry.usage),
                                }),
                            )
                        }
                        return await options.work.run(
                            {
                                deadlineMs: STEP_MOTION_POLICY.deadlineMs,
                                signal: generationDeadline.signal,
                                beforeSend: () => {
                                    dailyCap.reserve()
                                    dispatched = true
                                },
                            },
                            async () => {
                                deadline.checkpoint()
                                const generate = async (repair?: {
                                    repairIssues: string[]
                                    previousScene: NonNullable<StepMotionResult['scene']>
                                }): Promise<ScreenGeneration> =>
                                    options.provider!.generateStepMotion!(
                                        { request: metadata, image: cropped, ...repair },
                                        generationDeadline!.signal,
                                    )
                                const parse = (
                                    generation: ScreenGeneration,
                                ): ReturnType<typeof stepMotionResultSchema.safeParse> =>
                                    stepMotionResultSchema.safeParse(
                                        dropDegenerateStepMotionShapes(clampStepMotionBevels(generation.value)),
                                    )
                                const first = await generate()
                                const parsed = parse(first)
                                const rejection = sceneRejection(parsed, first.telemetry, metadata)
                                if (rejection !== null || !parsed.success || parsed.data.scene === null) {
                                    log(first, rejection)
                                    return EMPTY
                                }
                                const repairIssues = stepMotionOverlapIssues(parsed.data.scene)
                                if (repairIssues.length === 0) {
                                    log(first, null)
                                    return parsed.data
                                }
                                log(first, 'overlap')
                                try {
                                    // The existing one-shot runner shares deadline, public count and dispatch-day cap.
                                    const repaired = await options.work.repair(() =>
                                        generate({ repairIssues, previousScene: parsed.data.scene! }),
                                    )
                                    const result = parse(repaired)
                                    const refused = sceneRejection(result, repaired.telemetry, metadata)
                                    const overlap =
                                        result.success &&
                                        result.data.scene !== null &&
                                        stepMotionOverlapIssues(result.data.scene).length > 0
                                    const reason = refused ?? (overlap ? 'overlap' : null)
                                    log(repaired, reason)
                                    return reason === null && result.success ? result.data : EMPTY
                                } catch (error: unknown) {
                                    // A blocked/failed repair stays terminal, and never falls back to the overlapping scene.
                                    console.info(
                                        JSON.stringify({
                                            event: 'step_motion_generation',
                                            promptVersion: STEP_MOTION_PROMPT_VERSION,
                                            accepted: false,
                                            reason: 'overlap',
                                            ...(error instanceof MetaProviderError && error.detail === 'repair_budget'
                                                ? { repairReason: 'repair_budget' }
                                                : {}),
                                        }),
                                    )
                                    return EMPTY
                                }
                            },
                        )
                    } catch (error) {
                        if (!dispatched) {
                            throw new BeforeMotionDispatch(error)
                        }
                        // Provider failure or its own deadline is terminal; reader cancellation never enters this branch.
                        console.info(
                            JSON.stringify({
                                event: 'step_motion_generation',
                                promptVersion: STEP_MOTION_PROMPT_VERSION,
                                accepted: false,
                                reason: 'provider_failure',
                            }),
                        )
                        return EMPTY
                    } finally {
                        generationDeadline?.dispose()
                        releaseWork?.()
                        release()
                    }
                })()
                const started: CacheEntry = { pending, completed: false, contentKey }
                cache.set(key, started)
                byContent.set(contentKey, key)
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
                        if (cache.get(key) === started) forget(key)
                    },
                )
                entry = started
            }
            releaseImageWork?.()
            releaseImageWork = undefined
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
            releaseImageWork?.()
            deadline.dispose()
        }
    }
}
