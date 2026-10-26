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
import { requireOwnerSession, SessionError, type OwnerSessionManager, type OwnerSession } from './auth'
import { BudgetError, type RunLedger } from './budget'
import { corsResponse, isAllowedOrigin } from './cors'
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

/** Trusted server composition only. A caller cannot provide endpoints or bypass the current reservation context. */
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

export function unconfiguredModelResponse(request: Request): Response {
    return corsResponse(
        request,
        Response.json(fail('unconfigured'), { status: 503, headers: { 'cache-control': 'no-store' } }),
    )
}

export function modelOptions(request: Request): Response {
    const method = request.headers.get('access-control-request-method')
    const headers = request.headers.get('access-control-request-headers')
    if (
        !isAllowedOrigin(request) ||
        (method !== null && !['GET', 'POST'].includes(method)) ||
        (headers !== null &&
            !headers
                .split(',')
                .every((header) => ['content-type', 'authorization'].includes(header.trim().toLowerCase())))
    ) {
        return Response.json(fail('unauthorized'), {
            status: 401,
            headers: { 'cache-control': 'no-store', vary: 'Origin' },
        })
    }
    return corsResponse(
        request,
        new Response(null, {
            status: 204,
            headers: {
                'cache-control': 'no-store',
                'access-control-allow-methods': 'GET, POST, OPTIONS',
                'access-control-allow-headers': 'Content-Type, Authorization',
            },
        }),
    )
}

class Reservation {
    #reserved = false
    #closed = false
    #finalizing: Promise<void> | undefined
    constructor(
        readonly ledger: RunLedger,
        readonly runId: string,
        readonly requestId: string,
    ) {}
    async reserve(allowanceMicros: number): Promise<void> {
        await this.ledger.reserve({ runId: this.runId, requestId: this.requestId, allowanceMicros })
        this.#reserved = true
        if (this.#closed) {
            void this.finalize('unknown').catch((): void => {})
        }
    }
    finalize(outcome: 'completed' | 'unknown'): Promise<void> {
        this.#closed = true
        if (!this.#reserved) {
            return Promise.resolve()
        }
        this.#finalizing ??= this.ledger.finalize({ runId: this.runId, requestId: this.requestId, outcome })
        void this.#finalizing.catch((): void => {})
        return this.#finalizing
    }
}

interface Execution {
    deadline: Deadline
    session: OwnerSession
    context: EffectContext
    check(): void
    stop(): void
    dispose(): void
}

function admit(request: Request, manager: OwnerSessionManager, duration: number): Execution {
    const abort = new AbortController()
    const deadline = createDeadline(duration, AbortSignal.any([request.signal, abort.signal]))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const authority = new Request(request.url, {
            headers: {
                ...(request.headers.get('authorization') === null
                    ? {}
                    : { authorization: request.headers.get('authorization') ?? '' }),
                ...(request.headers.get('origin') === null ? {} : { origin: request.headers.get('origin') ?? '' }),
            },
        })
        const session = requireOwnerSession(authority, manager)
        deadline.checkpoint()
        const check = (): void => {
            const current = requireOwnerSession(authority, manager)
            if (current.runId !== session.runId || current.expiresAt !== session.expiresAt) {
                throw new SessionError('unauthorized')
            }
            deadline.checkpoint()
        }
        timer = setTimeout((): void => abort.abort(), Math.max(0, session.expiresAt - Date.now()))
        timer.unref?.()
        return {
            deadline,
            session,
            check,
            context: { check, deadline, dispatched: false },
            stop: (): void => abort.abort(),
            dispose: (): void => {
                clearTimeout(timer)
                deadline.dispose()
            },
        }
    } catch (error) {
        clearTimeout(timer)
        deadline.dispose()
        throw error
    }
}

function errorResult(error: unknown, execution?: Execution): { code: FailureCode; status: number } {
    // A poisoned ledger also invalidates session admission; preserve the original persistence failure.
    if (error instanceof BudgetError && !['duplicate_request', 'budget_exhausted'].includes(error.code)) {
        return { code: 'provider_error', status: 502 }
    }
    try {
        execution?.check()
    } catch (current) {
        error = current
    }
    if (error instanceof SessionError) {
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
        if (error.code === 'duplicate_request') {
            return { code: 'duplicate_request', status: 409 }
        }
        if (error.code === 'budget_exhausted') {
            return { code: 'budget_exhausted', status: 429 }
        }
        return { code: 'provider_error', status: 502 }
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
    manager: OwnerSessionManager
    ledger: RunLedger
    allowanceMicros?: number
}): { parse: Handler; check: Handler; question: Handler; segment: Handler; options: typeof modelOptions } {
    const { provider, samProvider, manager, ledger } = options
    const allowanceMicros = options.allowanceMicros ?? 100_000
    if (!Number.isSafeInteger(allowanceMicros) || allowanceMicros <= 0) {
        throw new Error('invalid_allowance')
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
            let reservation: Reservation | undefined
            try {
                execution = admit(request, manager, duration)
                if (!dispatch) {
                    throw new AdmissionError('unconfigured', 503)
                }
                const parsed = await readModelMultipart(request, schema, 9 * 1_024 * 1_024, execution.deadline)
                execution.check()
                metadata = parsed.metadata
                const input = await prepare(metadata, parsed.files, execution.deadline)
                execution.check()
                reservation = new Reservation(ledger, execution.session.runId, metadata.requestId)
                await withinModelDeadline(reservation.reserve(allowanceMicros), execution.deadline)
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
                await withinModelDeadline(reservation.finalize('completed'), execution.deadline)
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
                return corsResponse(request, response)
            } catch (error) {
                const failure = errorResult(error, execution)
                if (reservation) {
                    const cleanup = reservation.finalize('unknown')
                    if (execution) {
                        await withinModelDeadline(cleanup, execution.deadline).catch((): void => {})
                    }
                }
                return corsResponse(
                    request,
                    Response.json(fail(failure.code, metadata), {
                        status: failure.status,
                        headers: { 'cache-control': 'no-store' },
                    }),
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
        8_000,
        checkFiles,
        provider ? (input, signal): ReturnType<MetaProvider['checkStep']> => provider.checkStep(input, signal) : null,
        (value, metadata): boolean => value.sourceRefs.every((ref) => metadata.sourcePageIds.includes(ref.pageId)),
    )
    const question = jsonHandler(
        modelQuestionMetadataSchema,
        questionResultSchema,
        8_000,
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
        let reservation: Reservation | undefined
        try {
            execution = admit(request, manager, 30_000)
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
            reservation = new Reservation(ledger, execution.session.runId, metadata.requestId)
            await withinModelDeadline(reservation.reserve(allowanceMicros), execution.deadline)
            execution.check()
            return corsResponse(request, segmentResponse(input, metadata, execution, reservation, samProvider))
        } catch (error) {
            const failure = errorResult(error, execution)
            if (reservation) {
                void reservation.finalize('unknown').catch((): void => {})
            }
            execution?.dispose()
            return corsResponse(
                request,
                Response.json(fail(failure.code, metadata), {
                    status: failure.status,
                    headers: { 'cache-control': 'no-store' },
                }),
            )
        }
    }
    return { parse, check, question, segment, options: modelOptions }
}

function segmentResponse(
    input: SamInput,
    metadata: ModelSegmentMetadata,
    execution: Execution,
    reservation: Reservation,
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
        void reservation.finalize('unknown').catch((): void => {})
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
                } else {
                    await withinModelDeadline(
                        reservation.finalize(value.type === 'completed' ? 'completed' : 'unknown'),
                        execution.deadline,
                    )
                    execution.check()
                }
                yield { status: 'ok', mode: 'model', requestId: metadata.requestId, binding: metadata.binding, value }
                if (value.type !== 'snapshot') {
                    return
                }
            }
        } catch (error) {
            const failure = errorResult(error, execution)
            await withinModelDeadline(reservation.finalize('unknown'), execution.deadline).catch((): void => {})
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
        void reservation.finalize('unknown').catch((): void => {})
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
