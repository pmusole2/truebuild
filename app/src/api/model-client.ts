import { requestFetch } from './request-fetch'
import { appendMultipartImage, releaseMultipartImages } from './multipart-image'
import {
    checkResultSchema,
    LIMITS,
    matchesBinding,
    parsedManualSchema,
    questionResultSchema,
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
    type SegmentEvent,
} from '@truebuild/contracts'
import {
    MODEL_METADATA_MAX_BYTES,
    modelCheckMetadataSchema,
    modelParseMetadataSchema,
    modelQuestionMetadataSchema,
    modelSegmentMetadataSchema,
} from '@truebuild/contracts/model'
import type { z } from 'zod'
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
export const MODEL_PARSE_TIMEOUT_MS = 30_000
export const MODEL_CHECK_TIMEOUT_MS = 8_000
export const MODEL_SEGMENT_TIMEOUT_MS = 30_000
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
    /** Trusted in-process outer action deadline; never serialized or supplied by the backend. */
    readonly checkpoint?: () => void
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
        const metadata = { mode: 'model', requestId: ctx.requestId, binding, pages: [...pages] }
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
        const metadata = {
            mode: 'model',
            requestId: ctx.requestId,
            binding,
            session,
            sourcePageIds: [...sourcePageIds],
            observation: { mimeType: observation.mimeType, width: observation.width, height: observation.height },
        }
        if (!modelCheckMetadataSchema.safeParse(metadata).success || sources.length !== sourcePageIds.length) {
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
            path: '/api/checks',
            requestId: ctx.requestId,
            binding,
            form,
            timeoutMs: MODEL_CHECK_TIMEOUT_MS,
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
    ): Promise<ApiResult<QuestionResult>> {
        const metadata = {
            mode: 'model',
            requestId: ctx.requestId,
            binding,
            session,
            sourcePageIds: [...sourcePageIds],
            observation: { mimeType: observation.mimeType, width: observation.width, height: observation.height },
            question,
            target,
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

        return this.post({
            path: '/api/questions',
            requestId: ctx.requestId,
            binding,
            form,
            timeoutMs: MODEL_CHECK_TIMEOUT_MS,
            valueSchema: questionResultSchema,
            accepts: (value: QuestionResult): boolean => value.sourceRefs.every((ref) => allowed.has(ref.pageId)),
            signal: ctx.signal,
            checkpoint: ctx.checkpoint,
        })
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

    private async post<T>(spec: {
        path: string
        requestId: string
        binding: ManualBinding | CaptureBinding
        form: FormData
        timeoutMs: number
        valueSchema: z.ZodType<T>
        accepts: (value: T, binding: ManualBinding | CaptureBinding) => boolean
        signal: AbortSignal | undefined
        checkpoint: (() => void) | undefined
    }): Promise<ApiResult<T>> {
        const { requestId, binding, signal } = spec
        if (signal?.aborted === true) {
            releaseMultipartImages(spec.form)
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
            releaseMultipartImages(spec.form)
            guard.dispose()
            if (owned !== undefined) {
                discardResponse(owned)
            }
        }
    }

    private init(form: FormData, signal: AbortSignal): RequestInit {
        return {
            method: 'POST',
            headers: { 'x-truebuild-key': this.secret, Accept: 'application/json, text/event-stream' },
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

function everyRefInside(parsed: ParsedManual, pageIds: ReadonlySet<string>): boolean {
    const refs = [
        ...parsed.parts.flatMap((part) => (part.name.state === 'known' ? part.name.sourceRefs : [])),
        ...parsed.steps.flatMap((step) => [
            ...step.sourceRefs,
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
