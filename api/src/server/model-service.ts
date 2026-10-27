import { AsyncLocalStorage } from 'node:async_hooks'

import {
    checkResultSchema,
    LIMITS,
    manualSessionSchema,
    matchesBinding,
    parsedManualSchema,
    questionResultSchema,
    segmentEventSchema,
    type ApiResult,
    type CaptureBinding,
    type ManualBinding,
    type SegmentEvent,
} from '@truebuild/contracts'
import {
    modelCheckMetadataSchema,
    modelParseMetadataSchema,
    modelQuestionMetadataSchema,
    modelSegmentMetadataSchema,
    type ModelCheckMetadata,
    type ModelParseMetadata,
    type ModelQuestionMetadata,
    type ModelSegmentMetadata,
} from '@truebuild/contracts/model'
import type { z } from 'zod'

import {
    MetaProviderError,
    type CheckStepInput,
    type MetaProvider,
    type ParseManualInput,
} from '../providers/meta-provider'
import type { SamInput, SamProvider } from '../providers/sam'
import { AuthenticationError, type SharedKeyAuth } from './auth'
import { BudgetError, type ModelCallCounter } from './budget'
import { corsResponse, isAllowedOrigin, preflight } from './cors'
import { createDeadline, RequestStoppedError, type Deadline } from './deadline'
import {
    exactModelFiles,
    ModelBodyError,
    modelFileBytes,
    readModelMultipart,
    withinModelDeadline,
} from './model-multipart'

type Identity = { requestId: string; binding: ManualBinding | CaptureBinding }
type FailureCode = Extract<ApiResult<never>, { status: 'unavailable' }>['code']
type Handler = (request: Request) => Promise<Response>
type EffectContext = { check: () => void; deadline: Deadline; dispatched: boolean }
const effects = new AsyncLocalStorage<EffectContext>()

class AdmissionError extends Error {
    constructor(
        readonly code: FailureCode,
        readonly status: number,
    ) {
        super(code)
    }
}

/** Trusted server composition only. A caller cannot provide endpoints or bypass the current admitted request context. */
export function guardModelFetch(transport: typeof fetch = fetch): typeof fetch {
    return (input, init): Promise<Response> => {
        const context = effects.getStore()
        if (!context) {
            return Promise.reject(new AdmissionError('unauthorized', 401))
        }
        try {
            context.check()
            const url = input instanceof Request ? input.url : String(input)
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
            if (url !== 'https://api.meta.ai/v1/responses' || method !== 'POST') {
                throw new AdmissionError('unauthorized', 401)
            }
            if (context.dispatched) {
                throw new AdmissionError('duplicate_request', 409)
            }
            context.dispatched = true
            const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined)
            const signal = inherited ? AbortSignal.any([inherited, context.deadline.signal]) : context.deadline.signal
            return transport(input, { ...init, signal, redirect: 'error' }).then((response): Response => {
                try {
                    context.check()
                } catch (error) {
                    void response.body?.cancel().catch((): void => {})
                    throw error
                }
                return response
            })
        } catch (error) {
            return Promise.reject(error)
        }
    }
}

function fail(code: FailureCode, identity?: Identity): ApiResult<never> {
    return {
        status: 'unavailable',
        requestId: identity?.requestId ?? 'invalid-request',
        binding: identity?.binding ?? null,
        code,
        retryable: false,
    }
}

export function modelOptions(request: Request): Response {
    return preflight(request)
}

interface Execution {
    deadline: Deadline
    context: EffectContext
    check(): void
    stop(): void
    dispose(): void
}

function admit(request: Request, auth: SharedKeyAuth, duration: number, origins?: readonly string[]): Execution {
    auth.authenticate(request)
    if (!isAllowedOrigin(request, origins)) {
        throw new AuthenticationError()
    }
    const abort = new AbortController()
    const deadline = createDeadline(duration, AbortSignal.any([request.signal, abort.signal]))
    const check = (): void => deadline.checkpoint()
    try {
        check()
    } catch (error) {
        deadline.dispose()
        throw error
    }
    return {
        deadline,
        check,
        context: { check, deadline, dispatched: false },
        stop: (): void => abort.abort(),
        dispose: (): void => deadline.dispose(),
    }
}

function errorResult(error: unknown, execution?: Execution): { code: FailureCode; status: number } {
    try {
        execution?.check()
    } catch (current) {
        error = current
    }
    if (error instanceof AuthenticationError) {
        return { code: 'unauthorized', status: 401 }
    }
    if (error instanceof AdmissionError) {
        return { code: error.code, status: error.status }
    }
    if (error instanceof ModelBodyError) {
        return { code: 'invalid_input', status: error.status }
    }
    if (error instanceof RequestStoppedError) {
        return error.reason === 'timeout' ? { code: 'timeout', status: 504 } : { code: 'provider_error', status: 502 }
    }
    if (error instanceof BudgetError) {
        return { code: 'budget_exhausted', status: 429 }
    }
    if (error instanceof MetaProviderError) {
        return {
            code: error.code,
            status:
                error.code === 'invalid_input'
                    ? 400
                    : error.code === 'unconfigured'
                      ? 503
                      : error.code === 'timeout'
                        ? 504
                        : 502,
        }
    }
    return { code: 'provider_error', status: 502 }
}

async function parseFiles(
    metadata: ModelParseMetadata,
    files: Map<string, File>,
    deadline: Deadline,
): Promise<ParseManualInput> {
    exactModelFiles(
        files,
        metadata.pages.map((_page, index) => `source-${index}`),
        true,
    )
    const pages: ParseManualInput['pages'] = []
    for (const [index, page] of metadata.pages.entries()) {
        pages.push({
            page,
            bytes: await modelFileBytes(files, `source-${index}`, page.mimeType, LIMITS.imageBytes, deadline),
        })
        deadline.checkpoint()
    }
    return { requestId: metadata.requestId, binding: metadata.binding, pages }
}

async function checkFiles(
    metadata: ModelCheckMetadata,
    files: Map<string, File>,
    deadline: Deadline,
): Promise<CheckStepInput> {
    exactModelFiles(files, [...metadata.sourcePageIds.map((_page, index) => `source-${index}`), 'observation'], true)
    const sourceImages: CheckStepInput['sourceImages'] = []
    for (const [index, id] of metadata.sourcePageIds.entries()) {
        const page = metadata.session.pages.find((candidate) => candidate.pageId === id)
        if (!page) {
            throw new ModelBodyError(400)
        }
        sourceImages.push({
            page,
            bytes: await modelFileBytes(files, `source-${index}`, page.mimeType, LIMITS.imageBytes, deadline),
        })
        deadline.checkpoint()
    }
    const bytes = await modelFileBytes(files, 'observation', metadata.observation.mimeType, LIMITS.imageBytes, deadline)
    deadline.checkpoint()
    return {
        requestId: metadata.requestId,
        binding: metadata.binding,
        session: metadata.session,
        sourceImages,
        observation: { ...metadata.observation, bytes },
    }
}

async function segmentFiles(
    metadata: ModelSegmentMetadata,
    files: Map<string, File>,
    deadline: Deadline,
): Promise<SamInput> {
    exactModelFiles(files, ['media'], metadata.media.kind === 'image')
    const bytes = await modelFileBytes(
        files,
        'media',
        metadata.media.mimeType,
        metadata.media.kind === 'clip' ? 20 * 1_024 * 1_024 : LIMITS.imageBytes,
        deadline,
    )
    deadline.checkpoint()
    return {
        requestId: metadata.requestId,
        binding: metadata.binding,
        capturedAt: metadata.capturedAt,
        prompt: metadata.prompt,
        media:
            metadata.media.kind === 'image'
                ? {
                      kind: 'image',
                      image: {
                          mimeType: metadata.media.mimeType,
                          width: metadata.media.width,
                          height: metadata.media.height,
                          bytes,
                      },
                  }
                : { kind: 'clip', bytes, mimeType: metadata.media.mimeType },
    }
}

export function createModelHandlers(options: {
    provider: MetaProvider | null
    samProvider: SamProvider | null
    auth: SharedKeyAuth
    counter: ModelCallCounter
    checkTimeoutMs?: number
    allowedOrigins?: readonly string[]
}): { parse: Handler; check: Handler; question: Handler; segment: Handler; options: typeof modelOptions } {
    const { provider, samProvider, auth, counter, allowedOrigins } = options
    const checkTimeoutMs = options.checkTimeoutMs ?? 8_000
    if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs <= 0 || checkTimeoutMs > 8_000) {
        throw new Error('invalid_timeout')
    }

    function jsonHandler<M extends Identity, I, T>(
        schema: z.ZodType<M>,
        output: z.ZodType<T>,
        duration: number,
        prepare: (metadata: M, files: Map<string, File>, deadline: Deadline) => Promise<I>,
        dispatch: ((input: I, signal: AbortSignal) => Promise<T>) | null,
        validate: (value: T, metadata: M) => boolean,
    ): Handler {
        return async (request): Promise<Response> => {
            let execution: Execution | undefined
            let metadata: M | undefined
            try {
                execution = admit(request, auth, duration, allowedOrigins)
                if (!dispatch) {
                    throw new AdmissionError('unconfigured', 503)
                }
                const parsed = await readModelMultipart(request, schema, 9 * 1_024 * 1_024, execution.deadline)
                execution.check()
                metadata = parsed.metadata
                const input = await prepare(metadata, parsed.files, execution.deadline)
                execution.check()
                counter.claim()
                execution.check()
                const providerSignal = execution.deadline.signal
                const raw = await withinModelDeadline(
                    effects.run(execution.context, (): Promise<T> => dispatch(input, providerSignal)),
                    execution.deadline,
                )
                execution.check()
                const value = output.safeParse(raw)
                if (!value.success || !validate(value.data, metadata)) {
                    throw new AdmissionError('invalid_output', 502)
                }
                execution.check()
                const response = Response.json(
                    {
                        status: 'ok',
                        mode: 'model',
                        requestId: metadata.requestId,
                        binding: metadata.binding,
                        value: value.data,
                    },
                    { headers: { 'cache-control': 'no-store' } },
                )
                execution.check()
                return corsResponse(request, response, allowedOrigins)
            } catch (error) {
                const failure = errorResult(error, execution)
                return corsResponse(
                    request,
                    Response.json(fail(failure.code, metadata), {
                        status: failure.status,
                        headers: { 'cache-control': 'no-store' },
                    }),
                    allowedOrigins,
                )
            } finally {
                execution?.dispose()
            }
        }
    }

    const parse = jsonHandler(
        modelParseMetadataSchema,
        parsedManualSchema,
        30_000,
        parseFiles,
        provider
            ? (input, signal): ReturnType<MetaProvider['parseManual']> => provider.parseManual(input, signal)
            : null,
        (value, metadata): boolean =>
            manualSessionSchema.safeParse({
                manualId: metadata.binding.manualId,
                revision: metadata.binding.revision,
                title: 'Model extraction',
                updatedAt: '2026-01-01T00:00:00.000Z',
                pages: metadata.pages,
                parts: [],
                rawExtraction: value,
                reviewedSteps: [],
                reviewStatus: 'unreviewed',
            }).success,
    )
    const check = jsonHandler(
        modelCheckMetadataSchema,
        checkResultSchema,
        checkTimeoutMs,
        checkFiles,
        provider ? (input, signal): ReturnType<MetaProvider['checkStep']> => provider.checkStep(input, signal) : null,
        (value, metadata): boolean => value.sourceRefs.every((ref) => metadata.sourcePageIds.includes(ref.pageId)),
    )
    const question = jsonHandler(
        modelQuestionMetadataSchema,
        questionResultSchema,
        checkTimeoutMs,
        async (
            metadata: ModelQuestionMetadata,
            files,
            deadline,
        ): Promise<CheckStepInput & Pick<ModelQuestionMetadata, 'question' | 'target'>> => ({
            ...(await checkFiles(metadata, files, deadline)),
            question: metadata.question,
            target: metadata.target,
        }),
        provider
            ? (input, signal): ReturnType<MetaProvider['answerQuestion']> => provider.answerQuestion(input, signal)
            : null,
        (value, metadata): boolean => value.sourceRefs.every((ref) => metadata.sourcePageIds.includes(ref.pageId)),
    )

    const segment: Handler = async (request): Promise<Response> => {
        let execution: Execution | undefined
        let metadata: ModelSegmentMetadata | undefined
        try {
            execution = admit(request, auth, 30_000, allowedOrigins)
            if (!samProvider) {
                throw new AdmissionError('unconfigured', 503)
            }
            const parsed = await readModelMultipart(
                request,
                modelSegmentMetadataSchema,
                22 * 1_024 * 1_024,
                execution.deadline,
            )
            execution.check()
            metadata = parsed.metadata
            const input = await segmentFiles(metadata, parsed.files, execution.deadline)
            execution.check()
            counter.claim()
            execution.check()
            return corsResponse(request, segmentResponse(input, metadata, execution, samProvider), allowedOrigins)
        } catch (error) {
            const failure = errorResult(error, execution)
            execution?.dispose()
            return corsResponse(
                request,
                Response.json(fail(failure.code, metadata), {
                    status: failure.status,
                    headers: { 'cache-control': 'no-store' },
                }),
                allowedOrigins,
            )
        }
    }
    return { parse, check, question, segment, options: modelOptions }
}

function segmentResponse(
    input: SamInput,
    metadata: ModelSegmentMetadata,
    execution: Execution,
    provider: SamProvider,
): Response {
    let providerIterator: AsyncIterator<SegmentEvent> | undefined
    let closed = false
    let providerReturnRequested = false
    const closeProvider = (): void => {
        if (providerReturnRequested || !providerIterator?.return) {
            return
        }
        providerReturnRequested = true
        try {
            const returned = effects.run(execution.context, () => providerIterator?.return?.())
            void returned?.catch((): void => {})
        } catch {
            /* Cleanup cannot authorize a retry or additional terminal. */
        }
    }
    const stop = (): void => {
        execution.stop()
        closeProvider()
    }
    async function* events(): AsyncGenerator<ApiResult<SegmentEvent>> {
        try {
            execution.check()
            providerIterator = effects.run(execution.context, () =>
                provider.segment(input, execution.deadline.signal)[Symbol.asyncIterator](),
            )
            let frames = 0
            let streamId: string | undefined
            while (true) {
                execution.check()
                const next = await withinModelDeadline(
                    effects.run(execution.context, (): Promise<IteratorResult<SegmentEvent>> =>
                        providerIterator!.next(),
                    ),
                    execution.deadline,
                )
                execution.check()
                if (next.done) {
                    throw new AdmissionError('invalid_output', 502)
                }
                const parsed = segmentEventSchema.safeParse(next.value)
                if (!parsed.success) {
                    throw new AdmissionError('invalid_output', 502)
                }
                const value = parsed.data
                if (value.type === 'snapshot') {
                    frames += 1
                    if (
                        frames > 150 ||
                        value.snapshot.records.length > 16 ||
                        !matchesBinding(value.snapshot.binding, metadata.binding) ||
                        (streamId !== undefined && streamId !== value.snapshot.streamId)
                    ) {
                        throw new AdmissionError('invalid_output', 502)
                    }
                    streamId = value.snapshot.streamId
                }
                yield { status: 'ok', mode: 'model', requestId: metadata.requestId, binding: metadata.binding, value }
                if (value.type !== 'snapshot') {
                    return
                }
            }
        } catch (error) {
            const failure = errorResult(error, execution)
            if (!closed) {
                yield fail(failure.code, metadata)
            }
        } finally {
            closeProvider()
            execution.dispose()
        }
    }
    const source = events()
    const abort = (): void => {
        closeProvider()
    }
    execution.deadline.signal.addEventListener('abort', abort, { once: true })
    return new Response(
        new ReadableStream<Uint8Array>({
            async pull(controller): Promise<void> {
                try {
                    const next = await source.next()
                    if (closed) {
                        return
                    }
                    if (next.done) {
                        closed = true
                        execution.deadline.signal.removeEventListener('abort', abort)
                        controller.close()
                        return
                    }
                    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(next.value)}\n\n`)
                    if (next.value.status === 'ok') {
                        execution.check()
                    }
                    controller.enqueue(bytes)
                } catch (error) {
                    if (!closed) {
                        const failure = errorResult(error, execution)
                        controller.enqueue(
                            new TextEncoder().encode(`data: ${JSON.stringify(fail(failure.code, metadata))}\n\n`),
                        )
                        closed = true
                        controller.close()
                    }
                    stop()
                    execution.dispose()
                }
            },
            cancel(): void {
                closed = true
                execution.deadline.signal.removeEventListener('abort', abort)
                stop()
                void source.return(undefined).catch((): void => {})
                execution.dispose()
            },
        }),
        { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } },
    )
}
