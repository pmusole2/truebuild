import { requestFetch } from './request-fetch'
import { documentUnavailable, postDocuments } from './document-client'
import { aiConsent } from '../features/consent/consent-runtime'
import type { AiConsentStore } from '../features/consent/consent-store'
import { appendMultipartImage, releaseMultipartImages } from './multipart-image'
import { outgoingManualSession } from './outgoing-session'
import {
    checkResultSchema,
    isRecord,
    LIMITS,
    matchesBinding,
    parsedManualSchema,
    projectStepExtensions,
    sanitizeManualStepActions,
    pieceBatchRequestSchema,
    pieceBatchResultSchema,
    questionResultSchema,
    screensResultSchema,
    segmentEventSchema,
    SUPPORTED_STEP_EXTENSIONS,
    stepMotionRequestSchema,
    stepMotionResultSchema,
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type ManualBinding,
    type ManualPage,
    type ManualSession,
    type ParsedManual,
    type PieceBatchRequest,
    type PieceBatchResult,
    type QuestionResult,
    type QuestionTarget,
    type ScreenKind,
    type ScreensResult,
    type SegmentEvent,
    type StepExtension,
    type StepMotionRequest,
    type StepMotionResult,
} from '@truebuild/contracts'
import {
    MAX_PARSE_PAGES,
    PARSE_SPLIT_MESSAGE,
    MODEL_METADATA_MAX_BYTES,
    MODEL_STEP_PAGE_TIMEOUT_MS,
    modelCheckMetadataSchema,
    modelOverlayMetadataSchema,
    modelOverlayJobMetadataSchema,
    OVERLAY_JOB_PATHS,
    modelParseMetadataSchema,
    modelQuestionJobMetadataSchema,
    modelQuestionMetadataSchema,
    modelScreensMetadataSchema,
    modelSegmentMetadataSchema,
    modelSecondOpinionMetadataSchema,
    overlayResultSchema,
    pendingResultSchema,
    type ModelScreensMetadata,
    type OverlayResult,
    type PendingResult,
    type ScreenContext,
    type ModelScreensV2Metadata,
    type ScreensV2Result,
} from '@truebuild/contracts/model'
import { z } from 'zod'
import { sameIdentity } from '../features/screens/screen-spec'
import { streamFetch as defaultStreamFetch, type StreamFetch } from './stream-fetch'
import {
    awaitStopped,
    createCallGuard,
    discardResponse,
    InvalidResponseError,
    interpretEnvelope,
    invalidInputResult,
    modelStatusResult,
    parseBaseUrl,
    readBoundedText,
    unavailableResult,
    type Call,
    type CallGuard,
} from './transport'

export { MODEL_METADATA_MAX_BYTES, MODEL_STEP_PAGE_TIMEOUT_MS } from '@truebuild/contracts/model'
export const MODEL_REQUEST_MAX_BYTES = LIMITS.requestBytes
// Outlast the 165s parse budget and 170s route, so the server's own timeout answer arrives first.
export const MODEL_PARSE_TIMEOUT_MS = 175_000
// Live checks reached 11.6–11.75s; 15s lets the 12s server budget return honest result/timeout feedback.
export const MODEL_CHECK_TIMEOUT_MS = 15_000
export const MODEL_SECOND_OPINION_TIMEOUT_MS = 60_000
export const MODEL_SEGMENT_TIMEOUT_MS = 30_000
// The server answers a question within QUESTION_SYNC_WAIT_MS (8 s by default) or hands back a 202 ticket. The first
// request must outlive that wait, or the app would cancel exactly when the ticket arrives. The ticket then owns the
// rest of the (server-bounded) job; a collect call long-polls for about five seconds at most.
export const MODEL_QUESTION_FIRST_TIMEOUT_MS = 12_000
export const MODEL_QUESTION_COLLECT_TIMEOUT_MS = 10_000
export const MODEL_QUESTION_CANCEL_TIMEOUT_MS = 5_000
// Paid baseline: Spark low screens 17s, quick-check medium 31s; outlast the server's 30s limit.
export const MODEL_SCREEN_TIMEOUT_MS = 35_000
/** Geometry batches are the slowest model call; a timeout is an unknown outcome, so the registry never resends it. */
export const MODEL_PIECES_TIMEOUT_MS = 120_000
/** Eight cutouts of up to 360k characters each, plus piece specs; the default 1 MB limit cannot hold a full batch. */
export const MODEL_PIECES_RESPONSE_MAX_BYTES = 4 * 1_024 * 1_024
export const MODEL_SCREEN_CONTROL_TIMEOUT_MS = 10_000
export const MODEL_OVERLAY_TIMEOUT_MS = 75_000
export const MODEL_OVERLAY_FIRST_TIMEOUT_MS = 12_000
export const MODEL_OVERLAY_COLLECT_TIMEOUT_MS = 10_000
export const MODEL_OVERLAY_CANCEL_TIMEOUT_MS = 5_000
const MAX_STREAM_BYTES = 1_048_576
const MAX_STREAM_EVENTS = 64
const MAX_SSE_EVENT_BYTES = 262_144
const pieceCapabilitiesSchema = z.object({
    status: z.literal('ok'),
    capabilities: z.object({ pieceFigureBox: z.literal(true) }),
})

export type ModelFetch = (url: string, init: RequestInit) => Promise<Response>

/** Bytes of one stored source page or one observation, always the normalized original format the server validates. */
export interface ImageBytes {
    readonly bytes: Uint8Array
    readonly mimeType: ManualPage['mimeType']
    readonly width: number
    readonly height: number
}

/** Parse progress the server reports in order: `reading` when the provider call starts, `output` at its first delta. */
export type ParseProgress = 'reading' | 'output'

export interface ModelRequestContext {
    readonly requestId: string
    readonly signal?: AbortSignal
    readonly language?: string
    /** Trusted in-process outer action deadline; never serialized or supplied by the backend. */
    readonly checkpoint?: () => void
    /** Present only when the caller wants progress: parse then opts into the SSE stream. Absent keeps the JSON envelope. */
    readonly onProgress?: (phase: ParseProgress) => void
    /**
     * Identity of the VALIDATED generated guide page the person is looking at (its `screenId` and exact `contextKey`).
     * The server recomputes the key from the session and step; a request without one behaves as before.
     */
    readonly screen?: ScreenContext
}

function composeCheckpoint(
    guard: CallGuard,
    outer: (() => void) | undefined,
): {
    checkpoint: () => void
    outerExpired: () => boolean
} {
    let expired = false

    return {
        checkpoint(): void {
            guard.checkpoint()

            try {
                outer?.()
            } catch (error: unknown) {
                expired = true
                throw error
            }

            guard.checkpoint()
        },
        outerExpired: (): boolean => expired,
    }
}

export interface ModelClientOptions {
    readonly baseUrl: string
    /** Public demo-only shared key (EXPO_PUBLIC_API_SECRET). Never a Meta credential. */
    readonly secret: string
    readonly fetch?: ModelFetch
    readonly streamFetch?: StreamFetch
    /** Trusted fixture clients inject transports; ordinary app clients use the persisted permission store. */
    readonly consent?: AiConsentStore
}

const SOURCE_EXTENSION: Record<ManualPage['mimeType'], string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
}

function utf8Length(text: string): number {
    return new TextEncoder().encode(text).byteLength
}

interface FileField {
    readonly name: string
    readonly image: ImageBytes
}

/**
 * Builds the exact wire body: one `metadata` text field plus one file field per image. Field names are fixed by the
 * contract and carry no paths. Returns null when the body would exceed a frozen limit, so nothing is dispatched.
 */
function buildForm(metadata: unknown, files: readonly FileField[]): FormData | null {
    const json = JSON.stringify(metadata)
    if (utf8Length(json) > MODEL_METADATA_MAX_BYTES) {
        return null
    }
    const total = files.reduce((sum, file) => sum + file.image.bytes.byteLength, 0)
    if (total > MODEL_REQUEST_MAX_BYTES) {
        return null
    }
    const form = new FormData()
    form.append('metadata', json)
    for (const file of files) {
        try {
            appendMultipartImage(form, file.name, file.image, `${file.name}.${SOURCE_EXTENSION[file.image.mimeType]}`)
        } catch {
            releaseMultipartImages(form)
            return null
        }
    }
    return form
}

function fileFieldsWithinLimits(files: readonly ImageBytes[]): boolean {
    return files.every((file) => file.bytes.byteLength > 0 && file.bytes.byteLength <= LIMITS.imageBytes)
}

/** Parses one SSE data block into its payload. Only `data:` lines and comments are accepted; anything else is malformed. */
function ssePayload(block: string): string | null | undefined {
    const data: string[] = []
    for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) {
            continue
        }
        if (!line.startsWith('data:')) {
            return undefined
        }
        data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
    }
    return data.length === 0 ? null : data.join('\n')
}

/**
 * Model-mode client for the TrueBuild backend. The shared key is sent only in the x-truebuild-key header to the configured
 * origin. Every call makes at most one generation request (no retries); piece batches may first discover unmetered capabilities.
 * Each operation has one absolute monotonic deadline and validates its request and response against the frozen schemas.
 * Envelope responses must echo their requestId, binding and mode.
 */
/** Decodes a page picture the app already holds as a data URI; any other shape or MIME type is refused. */
function bytesFromDataUri(uri: string | undefined, mimeType: ManualPage['mimeType']): Uint8Array | null {
    const match = uri === undefined ? null : /^data:([a-z/]+);base64,([A-Za-z0-9+/]+=*)$/u.exec(uri)
    if (match === null || match[1] !== mimeType) return null
    const binary = atob(match[2] ?? '')
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const PARSE_PHASE_ORDER: readonly ParseProgress[] = ['reading', 'output']

/**
 * Reads a progress stream: ordered progress phases, then one `result` whose ApiResult JSON goes to the shared
 * interpreter. A failed result is returned with a non-2xx status so the interpreter classifies it the same way.
 */
async function readProgressStream(
    response: Response,
    signal: AbortSignal,
    checkpoint: () => void,
    onProgress: (phase: ParseProgress) => void,
): Promise<{ status: number; text: string }> {
    if (response.body === null) throw new InvalidResponseError('Progress stream has no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const stop = (): void => {
        void reader.cancel().catch((): undefined => undefined)
    }
    signal.addEventListener('abort', stop, { once: true })
    let buffer = ''
    let streamed = 0
    let phase = -1
    let result: unknown = undefined
    try {
        for (;;) {
            checkpoint()
            const next = await awaitStopped(reader.read(), signal)
            checkpoint()
            if (next.done) break
            streamed += next.value.byteLength
            if (streamed > MAX_STREAM_BYTES) throw new InvalidResponseError('Progress stream is too large')
            buffer += decoder.decode(next.value, { stream: true })
            buffer = buffer.replace(/\r\n/gu, '\n')
            let boundary = buffer.indexOf('\n\n')
            while (boundary !== -1) {
                const block = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                boundary = buffer.indexOf('\n\n')
                const payload = ssePayload(block)
                if (payload === undefined) throw new InvalidResponseError('Malformed progress event')
                if (payload === null) continue
                if (result !== undefined) throw new InvalidResponseError('Event after result')
                const event: unknown = JSON.parse(payload)
                const kind =
                    typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined
                if (kind === 'progress') {
                    const next = PARSE_PHASE_ORDER.indexOf((event as { phase?: ParseProgress }).phase as ParseProgress)
                    if (next <= phase) throw new InvalidResponseError('Progress phase out of order')
                    phase = next
                    onProgress(PARSE_PHASE_ORDER[next] as ParseProgress)
                } else if (kind === 'result') {
                    result = (event as { result?: unknown }).result
                } else {
                    throw new InvalidResponseError('Unknown progress event')
                }
            }
        }
        buffer += decoder.decode()
    } catch (error: unknown) {
        if (error instanceof InvalidResponseError) throw error
        throw new InvalidResponseError('Progress stream is not valid', { cause: error })
    } finally {
        signal.removeEventListener('abort', stop)
        void reader.cancel().catch((): undefined => undefined)
        reader.releaseLock()
    }
    if (result === undefined || buffer.trim() !== '') throw new InvalidResponseError('Progress stream has no result')
    const failed = (result as { status?: unknown } | null)?.status === 'unavailable'
    return { status: failed ? 502 : 200, text: JSON.stringify(result) }
}

/** A known refusal before model dispatch can be retried on a later visit; unknown outcomes must never be resent. */
export type StepMotionAttempt = StepMotionResult | { status: 'not_sent' | 'unknown' }

/** Set once an original generation is refused with 404: the endpoint is absent for the rest of this app session. */
let stepMotionEndpointAbsent = false

/** Forgets an earlier 404 so each test starts with the endpoint assumed present. */
export function resetStepMotionEndpointForTests(): void {
    stepMotionEndpointAbsent = false
}

/** The step fields the API applied, read only from its echo header; an absent header applies none. */
const STEP_FIELDS_HEADER = 'x-truebuild-step-fields'

function echoedStepFields(headers: Headers): ReadonlySet<StepExtension> {
    const named = new Set((headers.get(STEP_FIELDS_HEADER) ?? '').split(',').map((name) => name.trim()))
    return new Set(SUPPORTED_STEP_EXTENSIONS.filter((name) => named.has(name)))
}

/** Drops each optional step field the API did not echo before strict validation sees the steps. */
function projectEchoedSteps(value: unknown, echoed: ReadonlySet<StepExtension>): unknown {
    if (!isRecord(value) || !Array.isArray(value.steps)) return value
    return { ...value, steps: value.steps.map((step: unknown) => projectStepExtensions(step, echoed)) }
}

function parsedManualValue(echoed: ReadonlySet<StepExtension>, pageIds: ReadonlySet<string>) {
    return z.preprocess(
        (value) => sanitizeManualStepActions(projectEchoedSteps(value, echoed), pageIds),
        parsedManualSchema,
    )
}

export class ModelApiClient {
    private readonly baseUrl: string
    private readonly secret: string
    private readonly fetchImpl: ModelFetch
    private readonly streamImpl: StreamFetch
    private readonly consent: AiConsentStore | null

    constructor(options: ModelClientOptions) {
        this.baseUrl = parseBaseUrl(options.baseUrl)
        this.secret = options.secret
        this.consent =
            options.consent ?? (options.fetch === undefined && options.streamFetch === undefined ? aiConsent : null)
        const guarded = (transport: ModelFetch, store: AiConsentStore | null): ModelFetch =>
            store === null
                ? transport
                : async (url, init): Promise<Response> => {
                      if (!(await store.request(init.signal ?? undefined))) {
                          throw new Error('ai_consent_required')
                      }
                      if (init.signal?.aborted) throw new Error('request_stopped')
                      return transport(url, init)
                  }
        this.fetchImpl = guarded(
            options.fetch ?? requestFetch,
            options.consent ?? (options.fetch === undefined ? aiConsent : null),
        )
        this.streamImpl = guarded(
            options.streamFetch ?? options.fetch ?? defaultStreamFetch,
            options.consent ?? (options.streamFetch === undefined && options.fetch === undefined ? aiConsent : null),
        )
    }

    private async allowed(signal?: AbortSignal, explicit = true): Promise<boolean> {
        return this.consent === null || this.consent.request(signal, explicit)
    }

    async screensV2(metadata: ModelScreensV2Metadata, ctx: ModelRequestContext): Promise<ScreensV2Result> {
        if (this.consent !== null && !(await this.allowed(ctx.signal, false)))
            return documentUnavailable(ctx.requestId, 'invalid_input')
        return postDocuments({ metadata, ctx, baseUrl: this.baseUrl, secret: this.secret, fetch: this.fetchImpl })
    }

    async parse(
        binding: ManualBinding,
        pages: readonly ManualPage[],
        images: readonly ImageBytes[],
        ctx: ModelRequestContext,
    ): Promise<ApiResult<ParsedManual>> {
        if (this.consent !== null && !(await this.allowed(ctx.signal)))
            return unavailableResult(ctx.requestId, binding, 'invalid_input', false)
        if (pages.length > MAX_PARSE_PAGES) {
            return {
                status: 'unavailable',
                requestId: ctx.requestId,
                binding,
                code: 'invalid_input',
                retryable: false,
                message: PARSE_SPLIT_MESSAGE,
            }
        }
        const metadata = {
            mode: 'model',
            requestId: ctx.requestId,
            binding,
            pages: [...pages],
            language: ctx.language ?? 'en',
        }
        const sourceIds = pages.map((_page, index) => `source-${index}`)
        const valid = modelParseMetadataSchema.safeParse(metadata)
        if (!valid.success || images.length !== pages.length || !fileFieldsWithinLimits(images)) {
            return invalidInputResult(ctx.requestId)
        }
        const form = buildForm(
            metadata,
            images.map((image, index) => ({ name: sourceIds[index] ?? '', image })),
        )
        if (form === null) {
            return invalidInputResult(ctx.requestId)
        }
        const pageIds = new Set(pages.map((page) => page.pageId))

        return this.post({
            // Query parameters are ignored by old APIs and do not alter their strict metadata or CORS contract.
            path: `/api/manuals/parse?stepKinds=remove&stepFields=${SUPPORTED_STEP_EXTENSIONS.join(',')}`,
            requestId: ctx.requestId,
            binding,
            form,
            timeoutMs: MODEL_PARSE_TIMEOUT_MS,
            // The steps' optional fields are judged by the API's echo header, read with the response, never by the request.
            valueSchema: (headers: Headers) => parsedManualValue(echoedStepFields(headers), pageIds),
            accepts: (value: ParsedManual): boolean => everyRefInside(value, pageIds),
            signal: ctx.signal,
            checkpoint: ctx.checkpoint,
            onProgress: ctx.onProgress,
        })
    }

    async check(
        binding: CaptureBinding,
        session: ManualSession,
        sourcePageIds: readonly string[],
        sources: readonly ImageBytes[],
        observation: ImageBytes,
        ctx: ModelRequestContext,
    ): Promise<ApiResult<CheckResult>> {
        return this.postCheck(binding, session, sourcePageIds, sources, observation, ctx)
    }

    /** Consumes one server ticket using the exact primary request identity and frozen context. No retry. */
    async secondOpinion(
        binding: CaptureBinding,
        session: ManualSession,
        sourcePageIds: readonly string[],
        sources: readonly ImageBytes[],
        observation: ImageBytes,
        secondOpinionToken: string,
        ctx: ModelRequestContext,
    ): Promise<ApiResult<CheckResult>> {
        return this.postCheck(binding, session, sourcePageIds, sources, observation, ctx, secondOpinionToken)
    }

    private async postCheck(
        binding: CaptureBinding,
        session: ManualSession,
        sourcePageIds: readonly string[],
        sources: readonly ImageBytes[],
        observation: ImageBytes,
        ctx: ModelRequestContext,
        secondOpinionToken?: string,
    ): Promise<ApiResult<CheckResult>> {
        if (this.consent !== null && !(await this.allowed(ctx.signal)))
            return unavailableResult(ctx.requestId, binding, 'invalid_input', false)
        const secondary = secondOpinionToken !== undefined
        const metadata = {
            mode: 'model',
            requestId: ctx.requestId,
            binding,
            session,
            sourcePageIds: [...sourcePageIds],
            observation: { mimeType: observation.mimeType, width: observation.width, height: observation.height },
            ...(secondary ? { secondOpinionToken } : {}),
            ...(ctx.screen === undefined ? {} : { screen: ctx.screen }),
        }
        const schema = secondary ? modelSecondOpinionMetadataSchema : modelCheckMetadataSchema
        if (!schema.safeParse(metadata).success || sources.length !== sourcePageIds.length) {
            return invalidInputResult(ctx.requestId)
        }
        const files = [...sources, observation]
        if (!fileFieldsWithinLimits(files)) {
            return invalidInputResult(ctx.requestId)
        }
        const form = buildForm(metadata, [
            ...sources.map((image, index) => ({ name: `source-${index}`, image })),
            { name: 'observation', image: observation },
        ])
        if (form === null) {
            return invalidInputResult(ctx.requestId)
        }
        const allowed = new Set(sourcePageIds)

        return this.post({
            path: secondary ? '/api/checks/second-opinion' : '/api/checks',
            requestId: ctx.requestId,
            binding,
            form,
            timeoutMs: secondary ? MODEL_SECOND_OPINION_TIMEOUT_MS : MODEL_CHECK_TIMEOUT_MS,
            valueSchema: checkResultSchema,
            accepts: (value: CheckResult): boolean => value.sourceRefs.every((ref) => allowed.has(ref.pageId)),
            signal: ctx.signal,
            checkpoint: ctx.checkpoint,
        })
    }

    async questions(
        binding: CaptureBinding,
        session: ManualSession,
        sourcePageIds: readonly string[],
        sources: readonly ImageBytes[],
        observation: ImageBytes,
        question: string,
        target: QuestionTarget,
        ctx: ModelRequestContext,
    ): Promise<ApiResult<QuestionResult> | PendingResult> {
        if (this.consent !== null && !(await this.allowed(ctx.signal)))
            return unavailableResult(ctx.requestId, binding, 'invalid_input', false)
        const metadata = {
            mode: 'model',
            requestId: ctx.requestId,
            binding,
            session,
            sourcePageIds: [...sourcePageIds],
            observation: { mimeType: observation.mimeType, width: observation.width, height: observation.height },
            question,
            target,
            ...(ctx.screen === undefined ? {} : { screen: ctx.screen }),
        }
        if (!modelQuestionMetadataSchema.safeParse(metadata).success || sources.length !== sourcePageIds.length) {
            return invalidInputResult(ctx.requestId)
        }
        if (!fileFieldsWithinLimits([...sources, observation])) {
            return invalidInputResult(ctx.requestId)
        }
        const form = buildForm(metadata, [
            ...sources.map((image, index) => ({ name: `source-${index}`, image })),
            { name: 'observation', image: observation },
        ])
        if (form === null) {
            return invalidInputResult(ctx.requestId)
        }
        const allowed = new Set(sourcePageIds)

        return this.post<QuestionResult, PendingResult>({
            path: '/api/questions',
            requestId: ctx.requestId,
            binding,
            form,
            timeoutMs: MODEL_QUESTION_FIRST_TIMEOUT_MS,
            valueSchema: questionResultSchema,
            accepts: (value: QuestionResult): boolean => value.sourceRefs.every((ref) => allowed.has(ref.pageId)),
            signal: ctx.signal,
            checkpoint: ctx.checkpoint,
            pending: pendingFor(ctx.requestId, binding),
        })
    }

    /**
     * Collects a slow question's ticket: pending again, or the original final response (an envelope). This never
     * resends the question or its photo; a stopped or cancelled job is reported as such and not repeated.
     */
    async questionResult(
        binding: CaptureBinding,
        ticket: string,
        ctx: ModelRequestContext,
        sourcePageIds: readonly string[],
    ): Promise<ApiResult<QuestionResult> | PendingResult> {
        const body = { mode: 'model', requestId: ctx.requestId, binding, ticket }
        if (!modelQuestionJobMetadataSchema.safeParse(body).success) {
            return invalidInputResult(ctx.requestId)
        }
        const allowed = new Set(sourcePageIds)
        return this.post<QuestionResult, PendingResult>({
            path: '/api/questions/result',
            requestId: ctx.requestId,
            binding,
            form: JSON.stringify(body),
            timeoutMs: MODEL_QUESTION_COLLECT_TIMEOUT_MS,
            valueSchema: questionResultSchema,
            accepts: (value: QuestionResult): boolean => value.sourceRefs.every((ref) => allowed.has(ref.pageId)),
            signal: ctx.signal,
            checkpoint: ctx.checkpoint,
            pending: pendingFor(ctx.requestId, binding),
        })
    }

    /** Best-effort stop of a slow question's job (204). Never throws; a refusal or failure is simply `false`. */
    async questionCancel(
        binding: CaptureBinding,
        ticket: string,
        ctx: Pick<ModelRequestContext, 'requestId'>,
    ): Promise<boolean> {
        const body = { mode: 'model', requestId: ctx.requestId, binding, ticket }
        if (!modelQuestionJobMetadataSchema.safeParse(body).success) {
            return false
        }
        const guard = createCallGuard(MODEL_QUESTION_CANCEL_TIMEOUT_MS, undefined)
        let owned: Response | undefined
        try {
            const url = new URL('/api/questions/cancel', this.baseUrl).toString()
            owned = await awaitStopped(
                this.fetchImpl(url, this.init(JSON.stringify(body), guard.signal)),
                guard.signal,
                discardResponse,
            )
            return owned.status === 204
        } catch {
            return false
        } finally {
            guard.dispose()
            if (owned !== undefined) {
                discardResponse(owned)
            }
        }
    }

    /**
     * Wonder overlay for one published verdict. Consumes the one-use ticket from `followUps.overlay`; the verdict never
     * waits for it and it carries no decision. A replay or different bytes is refused by the server, not retried here.
     */
    async overlay(
        binding: CaptureBinding,
        session: ManualSession,
        sourcePageIds: readonly string[],
        sources: readonly ImageBytes[],
        observation: ImageBytes,
        overlayToken: string,
        ctx: ModelRequestContext,
    ): Promise<ApiResult<OverlayResult>> {
        if (this.consent !== null && !(await this.allowed(ctx.signal)))
            return unavailableResult(ctx.requestId, binding, 'invalid_input', false)
        const metadata = {
            mode: 'model',
            requestId: ctx.requestId,
            binding,
            session,
            sourcePageIds: [...sourcePageIds],
            observation: { mimeType: observation.mimeType, width: observation.width, height: observation.height },
            overlayToken,
            ...(ctx.screen === undefined ? {} : { screen: ctx.screen }),
        }
        if (!modelOverlayMetadataSchema.safeParse(metadata).success || sources.length !== sourcePageIds.length) {
            return invalidInputResult(ctx.requestId)
        }
        if (!fileFieldsWithinLimits([...sources, observation])) {
            return invalidInputResult(ctx.requestId)
        }
        const form = buildForm(metadata, [
            ...sources.map((image, index) => ({ name: `source-${index}`, image })),
            { name: 'observation', image: observation },
        ])
        if (form === null) {
            return invalidInputResult(ctx.requestId)
        }
        const guard = createCallGuard(MODEL_OVERLAY_TIMEOUT_MS, ctx.signal)
        let ticket: string | null = null
        let cancelled = false
        const cancel = (): void => {
            if (ticket === null || cancelled) return
            cancelled = true
            void this.cancelOverlay(binding, ticket, ctx.requestId)
        }
        guard.signal.addEventListener('abort', cancel, { once: true })
        let horizon = performance.now() + MODEL_OVERLAY_TIMEOUT_MS
        const checkpoint = (): void => {
            guard.checkpoint()
            ctx.checkpoint?.()
            if (performance.now() >= horizon) throw new Error('overlay_expired')
        }
        const pending = (value: unknown): PendingResult | null => {
            const parsed = pendingFor(ctx.requestId, binding)(value)
            return parsed !== null && (ticket === null || parsed.ticket === ticket) ? parsed : null
        }
        const post = (
            path: string,
            body: FormData | string,
            timeoutMs: number,
        ): Promise<ApiResult<OverlayResult> | PendingResult> =>
            this.post<OverlayResult, PendingResult>({
                path,
                requestId: ctx.requestId,
                binding,
                form: body,
                timeoutMs,
                valueSchema: overlayResultSchema,
                accepts: (): boolean => true,
                signal: guard.signal,
                checkpoint,
                pending,
                acceptSyntheticFixture: (value): boolean => value.evidence === 'synthetic-fixture',
            })
        try {
            checkpoint()
            let result = await post('/api/checks/overlay', form, MODEL_OVERLAY_FIRST_TIMEOUT_MS)
            while (result.status === 'pending') {
                ticket ??= result.ticket
                horizon = Math.min(horizon, performance.now() + result.expiresInMs + 5_000)
                checkpoint()
                await waitForOverlay(
                    Math.min(result.retryAfterMs, Math.max(0, horizon - performance.now())),
                    guard.signal,
                )
                checkpoint()
                // Result/cancel share the questions' authenticated JSON job protocol. Only the original effect
                // is multipart; collection never resends its images or one-use overlay token.
                const body = JSON.stringify({ mode: 'model', requestId: ctx.requestId, binding, ticket })
                result = await post(
                    OVERLAY_JOB_PATHS.result,
                    body,
                    Math.max(1, Math.min(MODEL_OVERLAY_COLLECT_TIMEOUT_MS, horizon - performance.now())),
                )
            }
            checkpoint()
            if (result.status === 'ok' && result.mode === 'model' && result.value.evidence === 'synthetic-fixture') {
                cancel()
                return unavailableResult(ctx.requestId, binding, 'invalid_output', false)
            }
            if (result.status === 'unavailable' && result.code === 'invalid_output') cancel()
            return result
        } catch {
            cancel()
            return unavailableResult(ctx.requestId, binding, ctx.signal?.aborted ? 'invalid_input' : 'timeout', false)
        } finally {
            guard.signal.removeEventListener('abort', cancel)
            guard.dispose()
            releaseMultipartImages(form)
        }
    }

    private async cancelOverlay(binding: CaptureBinding, ticket: string, requestId: string): Promise<void> {
        const metadata = modelOverlayJobMetadataSchema.safeParse({ mode: 'model', requestId, binding, ticket })
        if (!metadata.success) return
        const guard = createCallGuard(MODEL_OVERLAY_CANCEL_TIMEOUT_MS, undefined)
        let response: Response | undefined
        try {
            guard.checkpoint()
            response = await awaitStopped(
                this.fetchImpl(
                    new URL(OVERLAY_JOB_PATHS.cancel, this.baseUrl).toString(),
                    this.init(JSON.stringify(metadata.data), guard.signal),
                ),
                guard.signal,
                discardResponse,
            )
        } catch {
            // Best effort with the original owned ticket; never retry a cancellation or resend the effect.
        } finally {
            if (response !== undefined) discardResponse(response)
            guard.dispose()
        }
    }

    /**
     * Model-composed screens: generate one, or control the background step-page job (precompute, progress, cancel).
     * Zero files. The envelope is the screens envelope, not the check envelope. A document is accepted only when every
     * identity field and its kind match what was asked, so a stale, foreign or mislabelled document is never published.
     */
    async screens(request: ScreenRequest, ctx: ModelRequestContext): Promise<ScreensResult> {
        if (this.consent !== null && !(await this.allowed(ctx.signal, false)))
            return screensUnavailable(ctx.requestId, 'invalid_input', false)
        const metadata = screenMetadata(request, ctx.requestId)
        const valid = modelScreensMetadataSchema.safeParse(metadata)
        if (!valid.success) {
            return screensUnavailable(ctx.requestId, 'invalid_input', false)
        }
        const form = buildForm(metadata, [])
        if (form === null) {
            return screensUnavailable(ctx.requestId, 'invalid_input', false)
        }
        const { requestId } = ctx
        if (ctx.signal?.aborted === true) {
            return screensUnavailable(requestId, 'invalid_input', false)
        }
        const generating = request.op === 'generate'
        const guard = createCallGuard(
            generating
                ? stepPageKind(request.kind)
                    ? MODEL_STEP_PAGE_TIMEOUT_MS
                    : MODEL_SCREEN_TIMEOUT_MS
                : MODEL_SCREEN_CONTROL_TIMEOUT_MS,
            ctx.signal,
        )
        const { checkpoint, outerExpired } = composeCheckpoint(guard, ctx.checkpoint)
        let owned: Response | undefined
        try {
            checkpoint()
            const url = new URL('/api/screens?guideRepair=1', this.baseUrl).toString()
            owned = await awaitStopped(
                this.fetchImpl(url, this.init(form, guard.signal)),
                guard.signal,
                discardResponse,
            )
            checkpoint()
            const text = await readBoundedText(owned, guard.signal, checkpoint)
            checkpoint()
            const result = interpretScreens(owned.status, text, requestId, request)
            checkpoint()
            return result
        } catch (error: unknown) {
            try {
                checkpoint()
            } catch {
                /* Classify the stopped action below. */
            }
            if (outerExpired() || (!guard.callerAborted() && guard.timedOut())) {
                return screensUnavailable(requestId, 'timeout', true)
            }
            if (guard.callerAborted()) {
                return screensUnavailable(requestId, 'invalid_input', false)
            }
            return screensUnavailable(
                requestId,
                error instanceof InvalidResponseError ? 'invalid_output' : 'provider_error',
                error instanceof InvalidResponseError ? false : true,
            )
        } finally {
            releaseMultipartImages(form)
            guard.dispose()
            if (owned !== undefined) {
                discardResponse(owned)
            }
        }
    }

    /**
     * Streams the frozen-photo localization. Yields every validated event in order; the last yielded value is always
     * terminal (`completed`, `unavailable` event, or an unavailable envelope). Truncation, malformed data, a second
     * terminal, a deadline or an abort ends the stream with an unavailable value and never a fabricated completion.
     */
    async *segments(
        binding: CaptureBinding,
        prompt: string,
        capturedAt: string,
        image: ImageBytes,
        ctx: ModelRequestContext,
    ): AsyncGenerator<ApiResult<SegmentEvent>, void, void> {
        if (this.consent !== null && !(await this.allowed(ctx.signal))) {
            yield unavailableResult(ctx.requestId, binding, 'invalid_input', false)
            return
        }
        const metadata = {
            mode: 'model',
            requestId: ctx.requestId,
            binding,
            capturedAt,
            prompt,
            media: { kind: 'image', mimeType: image.mimeType, width: image.width, height: image.height },
        }
        if (!modelSegmentMetadataSchema.safeParse(metadata).success || !fileFieldsWithinLimits([image])) {
            yield invalidInputResult(ctx.requestId)
            return
        }
        const form = buildForm(metadata, [{ name: 'media', image }])
        if (form === null) {
            yield invalidInputResult(ctx.requestId)
            return
        }

        const call: Call<SegmentEvent> = {
            path: '/api/segments',
            requestId: ctx.requestId,
            binding,
            fields: {},
            valueSchema: segmentEventSchema,
            accepts: (event: SegmentEvent, requested: ManualBinding | CaptureBinding): boolean =>
                event.type !== 'snapshot' || matchesBinding(event.snapshot.binding, requested),
            signal: ctx.signal,
        }
        yield* this.streamSegments(call, form, ctx)
    }

    /**
     * One geometry batch for the piece registry. Every answer that is not a valid result (an unavailable envelope, a bad
     * status, a timeout, a malformed page) is null, which the registry records as an unknown outcome: it is never resent.
     */
    async pieceBatch(
        request: PieceBatchRequest,
        pageUris: Readonly<Record<string, string>>,
    ): Promise<PieceBatchResult | null> {
        if (this.consent !== null && !(await this.allowed(undefined, false))) return null
        const valid = pieceBatchRequestSchema.safeParse(request)
        if (!valid.success) return null
        const form = new FormData()
        const guard = createCallGuard(MODEL_PIECES_TIMEOUT_MS, undefined)
        try {
            for (const page of valid.data.pages) {
                const bytes = bytesFromDataUri(pageUris[page.pageId], page.mimeType)
                if (bytes === null) return null
                appendMultipartImage(
                    form,
                    `page:${page.pageId}`,
                    { bytes, mimeType: page.mimeType, width: page.width, height: page.height },
                    page.pageId,
                )
            }
            const figureBox =
                valid.data.parts.some((part) => part.figureBox !== undefined) &&
                (await this.supportsPieceFigureBox(guard.signal))
            guard.checkpoint()
            // Old APIs reject unknown keys even when the new field is optional. Keep the cited page for their context.
            const parts = figureBox
                ? valid.data.parts
                : valid.data.parts.map(({ figureBox: _figureBox, ...part }) => part)
            form.append('metadata', JSON.stringify({ ...valid.data, parts }))
            const url = new URL('/api/pieces', this.baseUrl).toString()
            const response = await awaitStopped(
                this.fetchImpl(url, this.init(form, guard.signal)),
                guard.signal,
                discardResponse,
            )
            const text = await readBoundedText(
                response,
                guard.signal,
                guard.checkpoint,
                MODEL_PIECES_RESPONSE_MAX_BYTES,
            )
            if (!response.ok) return null
            const result = pieceBatchResultSchema.safeParse(JSON.parse(text))
            return result.success ? result.data : null
        } catch {
            return null
        } finally {
            releaseMultipartImages(form)
            guard.dispose()
        }
    }

    /** Additive endpoint: an older server's 404 is an absent hint, with no fallback or retry. */
    async stepMotion(
        request: StepMotionRequest,
        pageUris: Readonly<Record<string, string>>,
    ): Promise<StepMotionAttempt> {
        if (stepMotionEndpointAbsent) return { status: 'not_sent' }
        if (this.consent !== null && !(await this.allowed(undefined, false))) return { status: 'not_sent' }
        const valid = stepMotionRequestSchema.safeParse(request)
        if (!valid.success) return { status: 'not_sent' }
        const guard = createCallGuard(MODEL_PIECES_TIMEOUT_MS, undefined)
        const form = new FormData()
        const cacheOnly = valid.data.cacheOnly === true
        let sent = false
        try {
            // A cache-only lookup sends metadata alone: it may read a finished scene but can never dispatch.
            if (!cacheOnly) {
                const page = valid.data.page
                const bytes = bytesFromDataUri(pageUris[page.pageId], page.mimeType)
                if (bytes === null || bytes.byteLength > LIMITS.imageBytes) return { status: 'not_sent' }
                appendMultipartImage(form, `page:${page.pageId}`, { ...page, bytes }, page.pageId)
            }
            // Only a cache-only lookup carries the recovery flag; normal generation metadata never does.
            const { cacheOnly: _flag, ...wire } = valid.data
            form.append('metadata', JSON.stringify(cacheOnly ? valid.data : wire))
            sent = true
            const url = new URL('/api/step-motion', this.baseUrl)
            // The query marks only the lookup, so the server can skip the paid-call admission check for it. Metadata alone
            // never grants that: the server still refuses to dispatch on a lookup.
            if (cacheOnly) url.searchParams.set('cacheOnly', '1')
            const response = await awaitStopped(
                this.fetchImpl(url.toString(), this.init(form, guard.signal)),
                guard.signal,
                discardResponse,
            )
            // Only a refused original generation latches, and before its body is read: a body failure cannot skip the latch.
            // A cache-only miss on a 404 proves the endpoint exists, so it never latches.
            if (!cacheOnly && response.status === 404) {
                discardResponse(response)
                stepMotionEndpointAbsent = true
                return { status: 'not_sent' }
            }
            const text = await readBoundedText(response, guard.signal, guard.checkpoint, 500_000)
            if (!response.ok) {
                // A failed lookup can say nothing about the original paid call, so it never reads as not sent.
                if (cacheOnly) return { status: 'unknown' }
                if ([400, 401, 429].includes(response.status)) return { status: 'not_sent' }
                const failure: unknown = JSON.parse(text)
                if (
                    typeof failure === 'object' &&
                    failure !== null &&
                    'notDispatched' in failure &&
                    failure.notDispatched === true
                )
                    return { status: 'not_sent' }
                return { status: 'unknown' }
            }
            const parsed = stepMotionResultSchema.safeParse(JSON.parse(text))
            return parsed.success && (parsed.data.scene === null || parsed.data.scene.stepId === request.stepId)
                ? parsed.data
                : { status: 'unknown' }
        } catch (error) {
            if (error instanceof Error && ['ai_consent_required', 'request_stopped'].includes(error.message))
                return { status: 'not_sent' }
            return { status: sent ? 'unknown' : 'not_sent' }
        } finally {
            releaseMultipartImages(form)
            guard.dispose()
        }
    }

    /** Recheck each batch so a backend rollback takes the strict legacy wire path without a POST retry. */
    private async supportsPieceFigureBox(signal: AbortSignal): Promise<boolean> {
        const guard = createCallGuard(5_000, signal)
        let response: Response | undefined
        try {
            response = await awaitStopped(
                this.fetchImpl(new URL('/api/session', this.baseUrl).toString(), {
                    method: 'GET',
                    headers: { 'x-truebuild-key': this.secret, Accept: 'application/json' },
                    credentials: 'omit',
                    redirect: 'error',
                    signal: guard.signal,
                }),
                guard.signal,
                discardResponse,
            )
            if (!response.ok) return false
            const text = await readBoundedText(response, guard.signal, guard.checkpoint, 32_768)
            return pieceCapabilitiesSchema.safeParse(JSON.parse(text)).success
        } catch {
            return false
        } finally {
            if (response !== undefined) discardResponse(response)
            guard.dispose()
        }
    }

    private async post<T, P = never>(spec: {
        path: string
        requestId: string
        binding: ManualBinding | CaptureBinding
        form: FormData | string
        timeoutMs: number
        /** A function receives the response headers, for a route whose value depends on what the response echoes. */
        valueSchema: z.ZodType<T> | ((headers: Headers) => z.ZodType<T>)
        accepts: (value: T, binding: ManualBinding | CaptureBinding) => boolean
        signal: AbortSignal | undefined
        checkpoint: (() => void) | undefined
        /** A 202 carries this shape instead of an envelope (slow questions). Only the requested binding may match. */
        pending?: (value: unknown) => P | null
        /** Overlay fixtures explicitly identify synthetic IO; other model APIs retain their original strict mode. */
        acceptSyntheticFixture?: (value: T) => boolean
        /** Present only for a progress-reporting route: it opts into the SSE stream instead of the JSON envelope. */
        onProgress?: (phase: ParseProgress) => void
    }): Promise<ApiResult<T> | P> {
        const { requestId, binding, signal } = spec
        const release = (): void => {
            if (typeof spec.form !== 'string') {
                releaseMultipartImages(spec.form)
            }
        }
        if (signal?.aborted === true) {
            release()
            return unavailableResult(requestId, binding, 'invalid_input', false)
        }

        const guard = createCallGuard(spec.timeoutMs, signal)
        const { checkpoint, outerExpired } = composeCheckpoint(guard, spec.checkpoint)
        let owned: Response | undefined

        try {
            checkpoint()
            const url = new URL(spec.path, this.baseUrl).toString()
            const onProgress = spec.onProgress
            const init = this.init(spec.form, guard.signal, onProgress !== undefined)
            checkpoint()
            owned = await awaitStopped(
                onProgress !== undefined ? this.streamImpl(url, init) : this.fetchImpl(url, init),
                guard.signal,
                discardResponse,
            )
            checkpoint()
            // A header-aware schema reads what the response echoes, so it is built only once the response has arrived.
            const call: Call<T> = {
                path: spec.path,
                requestId,
                binding,
                fields: {},
                valueSchema:
                    typeof spec.valueSchema === 'function' ? spec.valueSchema(owned.headers) : spec.valueSchema,
                accepts: spec.accepts,
                signal,
            }
            // Only a successful event stream is read as progress; any other answer keeps the legacy JSON envelope.
            const streamed =
                onProgress !== undefined &&
                owned.status >= 200 &&
                owned.status < 300 &&
                owned.headers.get('content-type')?.startsWith('text/event-stream') === true
            const body =
                streamed && onProgress !== undefined
                    ? await readProgressStream(owned, guard.signal, checkpoint, onProgress)
                    : { status: owned.status, text: await readBoundedText(owned, guard.signal, checkpoint) }
            checkpoint()
            const text = body.text
            if (spec.pending !== undefined && owned.status === 202) {
                let json: unknown
                try {
                    json = JSON.parse(text)
                } catch {
                    throw new InvalidResponseError('Pending response is not JSON')
                }
                const pending = spec.pending(json)
                if (pending === null) {
                    throw new InvalidResponseError('Pending response does not echo this request')
                }
                checkpoint()
                return pending
            }
            const result = interpretEnvelope(call, body.status, text, 'model', modelStatusResult)
            if (
                result.status === 'unavailable' &&
                result.code === 'invalid_output' &&
                spec.acceptSyntheticFixture !== undefined
            ) {
                const fixture = interpretEnvelope(call, body.status, text, 'fixture', modelStatusResult)
                if (fixture.status === 'ok' && spec.acceptSyntheticFixture(fixture.value)) {
                    checkpoint()
                    return fixture
                }
            }
            checkpoint()

            return result
        } catch (error: unknown) {
            try {
                checkpoint()
            } catch {
                /* Classify the stopped action below. */
            }
            if (outerExpired()) {
                return unavailableResult(requestId, binding, 'timeout', true)
            }
            if (guard.callerAborted()) {
                return unavailableResult(requestId, binding, 'invalid_input', false)
            }
            if (guard.timedOut()) {
                return unavailableResult(requestId, binding, 'timeout', true)
            }
            if (error instanceof InvalidResponseError) {
                return unavailableResult(requestId, binding, 'invalid_output', false)
            }
            return unavailableResult(requestId, binding, 'provider_error', true)
        } finally {
            release()
            guard.dispose()
            if (owned !== undefined) {
                discardResponse(owned)
            }
        }
    }

    private init(form: FormData | string, signal: AbortSignal, progress = false): RequestInit {
        return {
            method: 'POST',
            headers: {
                'x-truebuild-key': this.secret,
                // A progress request names only the stream, so the server cannot answer with the JSON envelope.
                Accept: progress ? 'text/event-stream' : 'application/json, text/event-stream',
                ...(typeof form === 'string' ? { 'content-type': 'application/json' } : {}),
            },
            body: form,
            credentials: 'omit',
            redirect: 'error',
            signal,
        }
    }

    private async *streamSegments(
        call: Call<SegmentEvent>,
        form: FormData,
        ctx: ModelRequestContext,
    ): AsyncGenerator<ApiResult<SegmentEvent>, void, void> {
        const { requestId, binding, signal } = call
        if (signal?.aborted === true) {
            releaseMultipartImages(form)
            yield unavailableResult(requestId, binding, 'invalid_input', false)
            return
        }

        const guard = createCallGuard(MODEL_SEGMENT_TIMEOUT_MS, ctx.signal)
        const { checkpoint, outerExpired } = composeCheckpoint(guard, ctx.checkpoint)
        let owned: Response | undefined
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        const onStop = (): void => {
            if (reader !== undefined) {
                void reader.cancel().catch((): void => undefined)
            } else if (owned !== undefined) {
                discardResponse(owned)
            }
        }
        // A consumer may pause at a snapshot; cancellation must not wait for its next pull or return.
        guard.signal.addEventListener('abort', onStop, { once: true })
        // A terminal success is held until the stream ends cleanly, so no malformed or second event can follow a publication.
        let held: ApiResult<SegmentEvent> | null = null
        let streamed = 0
        let events = 0

        try {
            checkpoint()
            const url = new URL(call.path, this.baseUrl).toString()
            const init = this.init(form, guard.signal)
            checkpoint()
            owned = await awaitStopped(this.streamImpl(url, init), guard.signal, discardResponse)
            checkpoint()

            if (owned.status < 200 || owned.status >= 300) {
                const text = await readBoundedText(owned, guard.signal, checkpoint)
                checkpoint()
                const result = interpretEnvelope(call, owned.status, text, 'model', modelStatusResult)
                checkpoint()
                yield result
                return
            }
            if (owned.body === null) {
                checkpoint()
                yield unavailableResult(requestId, binding, 'invalid_output', false)
                return
            }

            reader = owned.body.getReader()
            const decoder = new TextDecoder('utf-8', { fatal: true })
            let buffer = ''

            for (;;) {
                checkpoint()
                const next = await awaitStopped(reader.read(), guard.signal)
                checkpoint()

                if (next.done) {
                    break
                }
                streamed += next.value.byteLength
                if (streamed > MAX_STREAM_BYTES) {
                    checkpoint()
                    yield unavailableResult(requestId, binding, 'invalid_output', false)
                    return
                }

                buffer += decoder.decode(next.value, { stream: true })
                buffer = buffer.replace(/\r\n/gu, '\n')
                let boundary = buffer.indexOf('\n\n')

                while (boundary !== -1) {
                    const block = buffer.slice(0, boundary)
                    buffer = buffer.slice(boundary + 2)
                    boundary = buffer.indexOf('\n\n')

                    const payload = ssePayload(block)
                    if (payload === undefined || (payload !== null && utf8Length(payload) > MAX_SSE_EVENT_BYTES)) {
                        checkpoint()
                        yield unavailableResult(requestId, binding, 'invalid_output', false)
                        return
                    }
                    if (payload === null) {
                        continue
                    }
                    // Anything after a held terminal, or past the event budget, makes the whole stream invalid.
                    if (held !== null || ++events > MAX_STREAM_EVENTS) {
                        checkpoint()
                        yield unavailableResult(requestId, binding, 'invalid_output', false)
                        return
                    }

                    const result = interpretEnvelope(call, 200, payload, 'model')
                    checkpoint()
                    if (result.status === 'unavailable') {
                        // A failure is published as-is: it can never be read as success.
                        yield result
                        return
                    }
                    if (result.value.type === 'snapshot') {
                        checkpoint()
                        yield result
                        // Resumed after the consumer paused: the deadline is checked again before the next event.
                        checkpoint()
                    } else {
                        held = result
                    }
                }
            }

            // Input ended: a partial block, no terminal, or a stray byte is truncation, never completion.
            try {
                // Flush the fatal decoder: an incomplete final code point otherwise remains silently buffered.
                buffer += decoder.decode()
            } catch (error: unknown) {
                throw new InvalidResponseError('Response is not valid UTF-8', { cause: error })
            }
            checkpoint()
            if (held === null || buffer.trim() !== '') {
                checkpoint()
                yield unavailableResult(requestId, binding, 'invalid_output', false)
                return
            }
            checkpoint()
            yield held
        } catch (error: unknown) {
            try {
                checkpoint()
            } catch {
                /* Classify the stopped action below. */
            }
            if (outerExpired()) {
                yield unavailableResult(requestId, binding, 'timeout', true)
            } else if (guard.callerAborted()) {
                yield unavailableResult(requestId, binding, 'invalid_input', false)
            } else if (guard.timedOut()) {
                yield unavailableResult(requestId, binding, 'timeout', true)
            } else if (error instanceof InvalidResponseError) {
                yield unavailableResult(requestId, binding, 'invalid_output', false)
            } else {
                yield unavailableResult(requestId, binding, 'provider_error', true)
            }
        } finally {
            releaseMultipartImages(form)
            guard.signal.removeEventListener('abort', onStop)
            guard.dispose()
            if (reader !== undefined) {
                void reader.cancel().catch((): undefined => undefined)
                reader.releaseLock()
            }
            if (owned !== undefined) {
                discardResponse(owned)
            }
        }
    }
}

/** One typed `/api/screens` call. `generate` names the screen kind; the rest control the background step-page job. */
export type ScreenRequest =
    | {
          readonly op: 'generate'
          readonly kind: ScreenKind
          readonly session: ManualSession | null
          readonly stepId: string | null
          readonly captureId: string | null
          readonly result: ModelScreensMetadata['result']
          readonly failure: ModelScreensMetadata['failure']
          readonly completedStepIds?: readonly string[]
          readonly uiState?: ModelScreensMetadata['uiState']
      }
    | { readonly op: 'precompute'; readonly session: ManualSession; readonly focusStepId: string | null }
    | { readonly op: 'progress'; readonly binding: ManualBinding; readonly want: readonly string[] }
    | { readonly op: 'cancel'; readonly binding: ManualBinding }

const STEP_PAGE_KINDS: ReadonlySet<ScreenKind> = new Set(['guide', 'result', 'answer'])

function stepPageKind(kind: ScreenKind): boolean {
    return STEP_PAGE_KINDS.has(kind)
}

function screenMetadata(request: ScreenRequest, requestId: string): unknown {
    const base = {
        mode: 'model',
        requestId,
        kind: null,
        binding: null,
        session: null,
        stepId: null,
        captureId: null,
        result: null,
        failure: null,
        focusStepId: null,
        want: [] as string[],
    }
    switch (request.op) {
        case 'generate':
            return {
                ...base,
                op: 'generate',
                kind: request.kind,
                binding:
                    request.session === null
                        ? null
                        : { kind: 'manual', manualId: request.session.manualId, revision: request.session.revision },
                session: request.session === null ? null : outgoingManualSession(request.session),
                stepId: request.stepId,
                captureId: request.captureId,
                result: request.result,
                failure: request.failure,
                ...(request.completedStepIds === undefined ? {} : { completedStepIds: [...request.completedStepIds] }),
                ...(request.uiState === undefined ? {} : { uiState: request.uiState }),
            }
        case 'precompute':
            return {
                ...base,
                op: 'precompute',
                binding: { kind: 'manual', manualId: request.session.manualId, revision: request.session.revision },
                session: outgoingManualSession(request.session),
                focusStepId: request.focusStepId,
            }
        case 'progress':
            return { ...base, op: 'progress', binding: request.binding, want: [...request.want] }
        case 'cancel':
            return { ...base, op: 'cancel', binding: request.binding }
    }
}

function screensUnavailable(
    requestId: string,
    code: Extract<ScreensResult, { status: 'unavailable' }>['code'],
    retryable: boolean,
): ScreensResult {
    return { status: 'unavailable', requestId, binding: null, code, retryable }
}

function pendingFor(requestId: string, binding: CaptureBinding): (value: unknown) => PendingResult | null {
    return (value: unknown): PendingResult | null => {
        const parsed = pendingResultSchema.safeParse(value)
        return parsed.success && parsed.data.requestId === requestId && matchesBinding(parsed.data.binding, binding)
            ? parsed.data
            : null
    }
}

function waitForOverlay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject): void => {
        const finish = (): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            resolve()
        }
        const abort = (): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            reject(new Error('overlay_stopped'))
        }
        const timer = setTimeout(finish, ms)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
    })
}

function statusToScreensCode(status: number): Extract<ScreensResult, { status: 'unavailable' }>['code'] {
    if (status === 401 || status === 403) return 'unauthorized'
    if (status === 503) return 'unconfigured'
    if (status === 400 || status === 413 || status === 415) return 'invalid_input'
    if (status === 409) return 'duplicate_request'
    if (status === 429) return 'budget_exhausted'
    if (status === 504) return 'timeout'
    return status >= 500 && status < 600 ? 'provider_error' : 'invalid_output'
}

/** Pure: validates the whole screens envelope and the identity of every document against what was requested. */
export function interpretScreens(
    status: number,
    text: string,
    requestId: string,
    request: ScreenRequest,
): ScreensResult {
    let json: unknown
    try {
        json = JSON.parse(text)
    } catch {
        return status >= 200 && status < 300
            ? screensUnavailable(requestId, 'invalid_output', false)
            : screensUnavailable(requestId, statusToScreensCode(status), status >= 500)
    }
    const parsed = screensResultSchema.safeParse(json)
    if (!parsed.success || parsed.data.requestId !== requestId) {
        return status >= 200 && status < 300
            ? screensUnavailable(requestId, 'invalid_output', false)
            : screensUnavailable(requestId, statusToScreensCode(status), status >= 500)
    }
    const result = parsed.data
    if (status < 200 || status >= 300) {
        return result.status === 'unavailable' ? result : screensUnavailable(requestId, 'invalid_output', false)
    }
    if (result.status === 'unavailable') {
        return result
    }
    return acceptsScreens(request, result.value) ? result : screensUnavailable(requestId, 'invalid_output', false)
}

function acceptsScreens(request: ScreenRequest, value: Extract<ScreensResult, { status: 'ok' }>['value']): boolean {
    switch (request.op) {
        case 'generate': {
            const document = value.document
            if (document === null || value.documents.length > 0 || value.progress !== null) return false
            return (
                document.kind === request.kind &&
                sameIdentity(document.bound, {
                    manualId: request.session?.manualId ?? null,
                    revision: request.session?.revision ?? null,
                    stepId: request.stepId,
                    captureId: request.result === null ? null : request.captureId,
                })
            )
        }
        case 'precompute':
        case 'cancel': {
            const progress = value.progress
            const binding = request.op === 'precompute' ? request.session : request.binding
            return (
                value.document === null &&
                value.documents.length === 0 &&
                (progress === null ||
                    (progress.manualId === binding.manualId && progress.revision === binding.revision))
            )
        }
        case 'progress': {
            const progress = value.progress
            if (value.document !== null) return false
            if (
                progress !== null &&
                (progress.manualId !== request.binding.manualId || progress.revision !== request.binding.revision)
            ) {
                return false
            }
            const want = new Set(request.want)
            return value.documents.every(
                (document) =>
                    document.kind === 'guide' &&
                    document.bound.stepId !== null &&
                    want.has(document.bound.stepId) &&
                    sameIdentity(document.bound, {
                        manualId: request.binding.manualId,
                        revision: request.binding.revision,
                        stepId: document.bound.stepId,
                        captureId: null,
                    }),
            )
        }
    }
}

function everyRefInside(parsed: ParsedManual, pageIds: ReadonlySet<string>): boolean {
    const refs = [
        ...parsed.parts.flatMap((part) => (part.name.state === 'known' ? part.name.sourceRefs : [])),
        ...parsed.steps.flatMap((step) => [
            ...step.sourceRefs,
            ...(step.alternatives?.flatMap((alternative) => alternative.sourceRefs) ?? []),
            ...step.parts.flatMap((part) => part.quantityBasis?.sourceRefs ?? []),
            ...step.parts.flatMap((part) => (part.quantity.state === 'known' ? part.quantity.sourceRefs : [])),
            ...(step.orientation.state === 'known' ? step.orientation.sourceRefs : []),
            ...(step.connection.state === 'known' ? step.connection.sourceRefs : []),
            ...step.visibleChecks.flatMap((check) =>
                check.description.state === 'known' ? check.description.sourceRefs : [],
            ),
            ...(step.actions?.flatMap((action) => action.sourceRefs) ?? []),
            ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
        ]),
    ]
    return refs.every((ref) => pageIds.has(ref.pageId))
}
