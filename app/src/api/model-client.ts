import { requestFetch } from './request-fetch'
import { appendMultipartImage, releaseMultipartImages } from './multipart-image'
import {
    checkResultSchema,
    LIMITS,
    matchesBinding,
    parsedManualSchema,
    questionResultSchema,
    screensResultSchema,
    segmentEventSchema,
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type ManualBinding,
    type ManualPage,
    type ManualSession,
    type ParsedManual,
    type QuestionResult,
    type QuestionTarget,
    type ScreenKind,
    type ScreensResult,
    type SegmentEvent,
} from '@truebuild/contracts'
import {
    MAX_PARSE_PAGES,
    PARSE_SPLIT_MESSAGE,
    MODEL_METADATA_MAX_BYTES,
    modelCheckMetadataSchema,
    modelOverlayMetadataSchema,
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
} from '@truebuild/contracts/model'
import type { z } from 'zod'
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

export { MODEL_METADATA_MAX_BYTES } from '@truebuild/contracts/model'
export const MODEL_REQUEST_MAX_BYTES = LIMITS.requestBytes
// Five-second transport margin over the 105s server route; the controller also budgets local page reads.
export const MODEL_PARSE_TIMEOUT_MS = 110_000
export const MODEL_CHECK_TIMEOUT_MS = 8_000
export const MODEL_SECOND_OPINION_TIMEOUT_MS = 60_000
export const MODEL_SEGMENT_TIMEOUT_MS = 30_000
// The server answers a question within QUESTION_SYNC_WAIT_MS (8 s by default) or hands back a 202 ticket. The first
// request must outlive that wait, or the app would cancel exactly when the ticket arrives. The ticket then owns the
// rest of the (server-bounded) job; a collect call long-polls for about five seconds at most.
export const MODEL_QUESTION_FIRST_TIMEOUT_MS = 12_000
export const MODEL_QUESTION_COLLECT_TIMEOUT_MS = 10_000
export const MODEL_QUESTION_CANCEL_TIMEOUT_MS = 5_000
// Latency screens use the server's 20 s screens policy, step pages 45 s, the overlay 60 s; each plus a transport margin.
export const MODEL_SCREEN_TIMEOUT_MS = 30_000
export const MODEL_STEP_PAGE_TIMEOUT_MS = 55_000
export const MODEL_SCREEN_CONTROL_TIMEOUT_MS = 10_000
export const MODEL_OVERLAY_TIMEOUT_MS = 70_000
const MAX_STREAM_BYTES = 1_048_576
const MAX_STREAM_EVENTS = 64
const MAX_SSE_EVENT_BYTES = 262_144

export type ModelFetch = (url: string, init: RequestInit) => Promise<Response>

/** Bytes of one stored source page or one observation, always the normalized original format the server validates. */
export interface ImageBytes {
    readonly bytes: Uint8Array
    readonly mimeType: ManualPage['mimeType']
    readonly width: number
    readonly height: number
}

export interface ModelRequestContext {
    readonly requestId: string
    readonly signal?: AbortSignal
    readonly language?: string
    /** Trusted in-process outer action deadline; never serialized or supplied by the backend. */
    readonly checkpoint?: () => void
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
 * origin. Every call makes at most one request (no retries),
 * is bounded by one absolute monotonic deadline, validates the request and response against the frozen schemas, and
 * never publishes a value that does not echo its requestId, binding and mode.
 */
export class ModelApiClient {
    private readonly baseUrl: string
    private readonly secret: string
    private readonly fetchImpl: ModelFetch
    private readonly streamImpl: StreamFetch

    constructor(options: ModelClientOptions) {
        this.baseUrl = parseBaseUrl(options.baseUrl)
        this.secret = options.secret
        this.fetchImpl = options.fetch ?? requestFetch
        this.streamImpl = options.streamFetch ?? defaultStreamFetch
    }

    async parse(
        binding: ManualBinding,
        pages: readonly ManualPage[],
        images: readonly ImageBytes[],
        ctx: ModelRequestContext,
    ): Promise<ApiResult<ParsedManual>> {
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
            path: '/api/manuals/parse',
            requestId: ctx.requestId,
            binding,
            form,
            timeoutMs: MODEL_PARSE_TIMEOUT_MS,
            valueSchema: parsedManualSchema,
            accepts: (value: ParsedManual): boolean => everyRefInside(value, pageIds),
            signal: ctx.signal,
            checkpoint: ctx.checkpoint,
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
        return this.post({
            path: '/api/checks/overlay',
            requestId: ctx.requestId,
            binding,
            form,
            timeoutMs: MODEL_OVERLAY_TIMEOUT_MS,
            valueSchema: overlayResultSchema,
            accepts: (): boolean => true,
            signal: ctx.signal,
            checkpoint: ctx.checkpoint,
        })
    }

    /**
     * Model-composed screens: generate one, or control the background step-page job (precompute, progress, cancel).
     * Zero files. The envelope is the screens envelope, not the check envelope. A document is accepted only when every
     * identity field and its kind match what was asked, so a stale, foreign or mislabelled document is never published.
     */
    async screens(request: ScreenRequest, ctx: ModelRequestContext): Promise<ScreensResult> {
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
            const url = new URL('/api/screens', this.baseUrl).toString()
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

    private async post<T, P = never>(spec: {
        path: string
        requestId: string
        binding: ManualBinding | CaptureBinding
        form: FormData | string
        timeoutMs: number
        valueSchema: z.ZodType<T>
        accepts: (value: T, binding: ManualBinding | CaptureBinding) => boolean
        signal: AbortSignal | undefined
        checkpoint: (() => void) | undefined
        /** A 202 carries this shape instead of an envelope (slow questions). Only the requested binding may match. */
        pending?: (value: unknown) => P | null
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

        const call: Call<T> = {
            path: spec.path,
            requestId,
            binding,
            fields: {},
            valueSchema: spec.valueSchema,
            accepts: spec.accepts,
            signal,
        }
        const guard = createCallGuard(spec.timeoutMs, signal)
        const { checkpoint, outerExpired } = composeCheckpoint(guard, spec.checkpoint)
        let owned: Response | undefined

        try {
            checkpoint()
            const url = new URL(spec.path, this.baseUrl).toString()
            const init = this.init(spec.form, guard.signal)
            checkpoint()
            owned = await awaitStopped(this.fetchImpl(url, init), guard.signal, discardResponse)
            checkpoint()
            const text = await readBoundedText(owned, guard.signal, checkpoint)
            checkpoint()
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
            const result = interpretEnvelope(call, owned.status, text, 'model', modelStatusResult)
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

    private init(form: FormData | string, signal: AbortSignal): RequestInit {
        return {
            method: 'POST',
            headers: {
                'x-truebuild-key': this.secret,
                Accept: 'application/json, text/event-stream',
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

                buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n?/gu, '\n')
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
                session: request.session,
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
                session: request.session,
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
            ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
        ]),
    ]
    return refs.every((ref) => pageIds.has(ref.pageId))
}
