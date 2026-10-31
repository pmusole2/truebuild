import { SecondOpinionTickets, reconcileSecondOpinion, unavailableSecondOpinion } from './second-opinion'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { retryableNetworkFailure } from '../providers/meta-transport'
import { admission } from './request-clock'

import {
    checkResultSchema,
    FIXTURE_EVIDENCE,
    LIMITS,
    type ObservedCallTelemetry,
    manualSessionSchema,
    matchesBinding,
    parsedManualSchema,
    questionResultSchema,
    screenContextJsonV2,
    screenManualJsonV2,
    screensResultSchema,
    segmentEventSchema,
    type ScreenContextInputsV2,
    type ApiResult,
    type CheckResult,
    type StandardModel,
    type CaptureBinding,
    type ManualBinding,
    type ManualSession,
    type SegmentEvent,
} from '@truebuild/contracts'
import {
    MAX_PARSE_PAGES,
    MODEL_METADATA_MAX_BYTES,
    PARSE_SPLIT_MESSAGE,
    selectCompactStepSourcePageIds,
    modelCheckMetadataSchema,
    modelSecondOpinionMetadataSchema,
    modelOverlayMetadataSchema,
    modelParseMetadataSchema,
    modelQuestionJobMetadataSchema,
    modelQuestionMetadataSchema,
    modelScreensMetadataSchema,
    modelScreensV2MetadataSchema,
    modelSegmentMetadataSchema,
    overlayResultSchema,
    screensV2ResultSchema,
    type ModelScreensV2Metadata,
    pendingResultSchema,
    type OverlayResult,
    type ModelOverlayMetadata,
    type ModelScreensMetadata,
    type ModelCheckMetadata,
    type ModelSecondOpinionMetadata,
    type ModelParseMetadata,
    type ModelQuestionMetadata,
    type ModelSegmentMetadata,
} from '@truebuild/contracts/model'
import { z } from 'zod'

import {
    MetaProviderError,
    observedTelemetry,
    type CheckContextMode,
    type CheckStepInput,
    type MetaProvider,
    type OverlayInput,
    type ParseManualInput,
} from '../providers/meta-provider'
import type { SamInput, SamProvider } from '../providers/sam'
import { AuthenticationError, type SharedKeyAuth } from './auth'
import { BudgetError, ConcurrencyGate, type ModelCallCounter } from './budget'
import { corsResponse, isAllowedOrigin, preflight } from './cors'
import { createDeadline, RequestStoppedError, type Deadline } from './deadline'
import {
    exactModelFiles,
    ModelBodyError,
    modelFileBytes,
    readModelMultipart,
    withinModelDeadline,
} from './model-multipart'
import { withResolvedLayout } from './layout'
import { SEGMENT_PROMPT_LIMIT } from '@truebuild/contracts'
import { aiPolicyFromEnvironment, MAX_DEADLINE_MS, type AiPolicy } from './ai-policy'
import { PARSE_ROUTE_MARGIN_MS } from './parse-budget'
import { readBoundedJson, InvalidBodyError } from './json-body'
import { DuplicateQuestionError, QuestionJobs, type QuestionIdentity, type StoredResponse } from './question-jobs'
import { createDocumentService, type DocumentFixtureGenerator } from './documents/service'
import {
    createScreenService,
    type BackgroundWork,
    type ScreenFixtureGenerator,
    type ScreenService,
} from './screens/service'

const segmentPromptSchema = modelSegmentMetadataSchema.shape.prompt

type Identity = { requestId: string; binding: ManualBinding | CaptureBinding }
type ScreensValue = Extract<z.infer<typeof screensResultSchema>, { status: 'ok' }>['value']
/** Node's fetch needs `duplex` to stream a request body; the DOM RequestInit type does not declare it. */
type StreamingInit = RequestInit & { duplex: 'half' }
type FailureCode = Extract<ApiResult<never>, { status: 'unavailable' }>['code']
type Handler = (request: Request) => Promise<Response>
type EffectContext = {
    check: () => void
    deadline: Deadline
    dispatched: boolean
    counter?: ModelCallCounter
    retry: boolean
    fingerprint?: string
    attempts: number
    /** Present only on an admitted parse route; the one-use repair child never carries it. */
    repair?: { used: boolean }
    /** Status of the first upstream response; only a first 200 can authorize the repair. */
    firstStatus?: number
}
const effects = new AsyncLocalStorage<EffectContext>()

/** Flat, secret-free view of a result's observed call telemetry for the outcome log. */
function telemetryFields(value: unknown): Record<string, unknown> {
    const telemetry = (value as { telemetry?: ObservedCallTelemetry } | null | undefined)?.telemetry
    return telemetry === undefined
        ? {}
        : { stage: telemetry.stage, effort: telemetry.effort, ...telemetry.timing, ...telemetry.usage }
}

/** One structured line per model request: ids, counts and timings only; never a prompt, body or generated text. */
function logOutcome(fields: Record<string, unknown>): void {
    console.info(JSON.stringify({ event: 'model_outcome', ...fields }))
}

class AdmissionError extends Error {
    constructor(
        readonly code: FailureCode,
        readonly status: number,
        /** Static, non-sensitive text shown to the user for a known rejection; never provider or request data. */
        readonly publicMessage?: string,
        readonly identity?: Identity,
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
            // The provider ports serialize JSON strings. An opaque Request/byte/blob body cannot prove retry identity.
            if (
                (init?.body != null && typeof init.body !== 'string') ||
                (input instanceof Request && input.body !== null && typeof init?.body !== 'string')
            ) {
                throw new AdmissionError('invalid_input', 400)
            }
            const fingerprint = createHash('sha256')
                .update(typeof init?.body === 'string' ? init.body : '')
                .digest('hex')
            if (
                context.dispatched &&
                (!context.retry || fingerprint !== context.fingerprint || context.attempts >= 2)
            ) {
                throw new AdmissionError('duplicate_request', 409)
            }
            if (context.dispatched) context.counter?.claim()
            context.dispatched = true
            context.retry = false
            context.fingerprint = fingerprint
            context.attempts += 1
            const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined)
            const signal = inherited ? AbortSignal.any([inherited, context.deadline.signal]) : context.deadline.signal
            return transport(input, { ...init, signal, redirect: 'error' }).then(
                (response): Response => {
                    try {
                        context.check()
                    } catch (error) {
                        void response.body?.cancel().catch((): void => {})
                        throw error
                    }
                    // Receiving any response ends transport retry authority; semantic repair needs its separate grant.
                    context.retry = false
                    context.firstStatus ??= response.status
                    return response
                },
                (error: unknown): never => {
                    context.check()
                    context.retry = context.attempts === 1 && retryableNetworkFailure(error)
                    throw error
                },
            )
        } catch (error) {
            return Promise.reject(error)
        }
    }
}

/**
 * Trusted composition only (injected by model-runtime into the meta provider). After an admitted parse received HTTP 200
 * and the provider found unresolved critical facts, this spends the single repair: the budget is claimed before launch,
 * and the child runs in a fresh context that allows one changed upstream request and cannot repair again.
 */
export async function runModelParseRepair<T>(work: () => Promise<T>): Promise<T> {
    const parent = effects.getStore()
    if (!parent?.repair || parent.repair.used || !parent.counter || !parent.dispatched || parent.firstStatus !== 200) {
        throw new AdmissionError('unauthorized', 401)
    }
    parent.check()
    parent.repair.used = true
    parent.counter.claim()
    return effects.run(
        {
            check: parent.check,
            deadline: parent.deadline,
            counter: parent.counter,
            dispatched: false,
            retry: false,
            attempts: 0,
        },
        work,
    )
}

/**
 * Trusted composition for provider work that has no inbound request (precompute, shared screen generation): its own
 * deadline and cancellation, the explicit call counter when an operator set one, and the one-shot repair runner.
 */
export function createBackgroundWork(counter: ModelCallCounter, gate: ConcurrencyGate): BackgroundWork {
    return {
        async run<T>(
            { deadlineMs, signal }: { deadlineMs: number; signal: AbortSignal },
            work: () => Promise<T>,
        ): Promise<T> {
            const deadline = createDeadline(Math.min(deadlineMs, MAX_DEADLINE_MS), signal)
            const check = (): void => deadline.checkpoint()
            const context: EffectContext = {
                check,
                deadline,
                dispatched: false,
                retry: false,
                attempts: 0,
                repair: { used: false },
                counter,
            }
            try {
                check()
                counter.claim()
                return await withinModelDeadline(
                    admission.run(admission.getStore() ?? { start: performance.now() }, () =>
                        effects.run(context, work),
                    ),
                    deadline,
                )
            } finally {
                deadline.dispose()
            }
        },
        repair: runModelParseRepair,
        tryAcquire: () => gate.tryAcquire(),
        acquire: (signal) => gate.acquire(signal),
    }
}

function fail(code: FailureCode, identity?: Identity, message?: string): ApiResult<never> {
    return {
        status: 'unavailable',
        requestId: identity?.requestId ?? 'invalid-request',
        binding: identity?.binding ?? null,
        code,
        retryable: false,
        ...(message === undefined ? {} : { message }),
    }
}

export function modelOptions(request: Request): Response {
    return preflight(request)
}

interface Execution {
    deadline: Deadline
    /** Monotonic time of real admission, before the body is read. */
    startedAt: number
    context: EffectContext
    check(): void
    stop(): void
    dispose(): void
}

function admit(request: Request, auth: SharedKeyAuth, duration: number, origins?: readonly string[]): Execution {
    const startedAt = performance.now()
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
        startedAt,
        check,
        context: { check, deadline, dispatched: false, retry: false, attempts: 0 },
        stop: (): void => abort.abort(),
        dispose: (): void => deadline.dispose(),
    }
}

function errorResult(
    error: unknown,
    execution?: Execution,
): { code: FailureCode; status: number; message?: string; identity?: Identity } {
    try {
        execution?.check()
    } catch (current) {
        error = current
    }
    if (error instanceof AuthenticationError) {
        return { code: 'unauthorized', status: 401 }
    }
    if (error instanceof AdmissionError) {
        return {
            code: error.code,
            status: error.status,
            ...(error.publicMessage === undefined ? {} : { message: error.publicMessage }),
            ...(error.identity === undefined ? {} : { identity: error.identity }),
        }
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
    return {
        requestId: metadata.requestId,
        binding: metadata.binding,
        pages,
        ...(metadata.language === undefined ? {} : { language: metadata.language }),
    }
}

/**
 * Recognises only the known too-many-pages case before any other validation, normalization, budget claim or upstream
 * dispatch. Every other malformed body keeps the generic invalid_input response without a message.
 */
const parseRouteIdentitySchema = z.object({
    mode: modelParseMetadataSchema.shape.mode,
    requestId: modelParseMetadataSchema.shape.requestId,
    binding: modelParseMetadataSchema.shape.binding,
})
const parseRouteMetadataSchema = z
    .unknown()
    .transform((value): unknown => {
        if (
            typeof value === 'object' &&
            value !== null &&
            'pages' in value &&
            Array.isArray(value.pages) &&
            value.pages.length > MAX_PARSE_PAGES
        ) {
            const identity = parseRouteIdentitySchema.safeParse(value)
            if (identity.success) {
                throw new AdmissionError('invalid_input', 400, PARSE_SPLIT_MESSAGE, identity.data)
            }
            throw new ModelBodyError(400)
        }
        return value
    })
    .pipe(modelParseMetadataSchema)

async function checkFiles(
    metadata: ModelCheckMetadata,
    files: Map<string, File>,
    deadline: Deadline,
    screens?: Pick<ScreenService, 'resolveStepScreen'>,
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
    // The optional generated-screen identity is bound to the exact manual revision, step and facts by recomputing the
    // expected context here; only validator-resolved facts reach the model, never client text. A mismatch is a client bug.
    let screen: CheckStepInput['screen']
    if (metadata.screen !== undefined && screens) {
        const resolved = screens.resolveStepScreen(metadata.session, metadata.binding.stepId, metadata.screen)
        if (resolved === 'mismatch') throw new AdmissionError('invalid_input', 400)
        screen = resolved ?? undefined
    }
    return {
        requestId: metadata.requestId,
        binding: metadata.binding,
        session: metadata.session,
        sourceImages,
        observation: { ...metadata.observation, bytes },
        ...(screen === undefined ? {} : { screen }),
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
    checkContext?: CheckContextMode
    secondOpinionModel?: StandardModel
    /** MODEL_LAYOUT=1: resolve the proposal carried by the same check/ask response. Default off. */
    layout?: boolean
    checkTimeoutMs?: number
    allowedOrigins?: readonly string[]
    /** Per-stage policy; defaults to the documented defaults. */
    policy?: AiPolicy
    runtimeMode?: 'fixture' | 'meta'
    /** Verdict follow-ups published with a check result. Both require GENERATIVE_UI other than off. */
    followUps?: { overlay: boolean; segments: boolean }
    /** In-flight provider bound (correctness: memory, pacing, verdict-path protection). */
    maxConcurrency?: number
    /** Slots only foreground work may take (default: a quarter of the bound); background screens never use them. */
    foregroundReserve?: number
    /** Background step-screen generation concurrency (provider pacing and memory, not cost). */
    precomputeConcurrency?: number
    /** Explicit synthetic screen composition source (fixture runtime / tests only). Ignored when a provider exists. */
    screenFixtures?: ScreenFixtureGenerator | null
    /** Explicit synthetic version 2 document source (fixture runtime / tests only). Ignored when a provider exists. */
    documentFixtures?: DocumentFixtureGenerator | null
    /** How long a question request waits for its answer before returning a 202 ticket. */
    questionSyncWaitMs?: number
}): {
    parse: Handler
    check: Handler
    secondOpinion: Handler
    overlay: Handler
    overlayResult: Handler
    overlayCancel: Handler
    question: Handler
    questionResult: Handler
    questionCancel: Handler
    segment: Handler
    screens: Handler
    screensV2: Handler
    screenService: ScreenService
    documentService: ReturnType<typeof createDocumentService>
    options: typeof modelOptions
} {
    const { provider, samProvider, auth, counter, allowedOrigins } = options
    const checkTimeoutMs = options.checkTimeoutMs ?? 12_000 // t5 Spark low verdict 7.96 s; match runtime/provider headroom.
    if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs <= 0 || checkTimeoutMs > MAX_DEADLINE_MS) {
        throw new Error('invalid_timeout')
    }
    const policy =
        options.policy ??
        aiPolicyFromEnvironment(
            {},
            {
                checkTimeoutMs,
                parseModel: 'muse-spark-1.3',
                verdictModel: 'muse-spark-1.3',
                secondOpinionModel: options.secondOpinionModel ?? 'muse-wonder-1.0',
            },
        )
    const gate = new ConcurrencyGate(options.maxConcurrency ?? 32, options.foregroundReserve)
    const followUpsEnabled = policy.generativeUi !== 'off'
    const offerOverlay = followUpsEnabled && options.followUps?.overlay === true && provider?.overlay !== undefined
    const offerSegments = followUpsEnabled && options.followUps?.segments === true && samProvider !== null
    /**
     * A trusted provider injected under the fixture runtime makes no model call. Its public values are stamped as
     * fixture evidence and carry no model, effort, timing or usage, whatever the source reports internally. This is
     * decided here from the runtime composition only: nothing in a request can enable it, and a live runtime rejects
     * every fixture claim instead of publishing it.
     */
    const fixtureProvider = options.runtimeMode === 'fixture' && provider !== null
    const tickets = new SecondOpinionTickets(
        undefined,
        fixtureProvider
            ? (primary): boolean =>
                  primary.decision === 'cannot_verify' &&
                  (primary.model === undefined || primary.model === 'muse-spark-1.3')
            : undefined,
    )
    const overlayTickets = new SecondOpinionTickets(undefined, () => true)
    const layout = options.layout === true
    const screenService = createScreenService({
        provider: provider?.generateScreen ? provider : null,
        // Synthetic screen sources run in the fixture runtime only, even when one is injected elsewhere.
        fixtureGenerator: options.runtimeMode === 'fixture' ? (options.screenFixtures ?? null) : null,
        policy,
        runtimeMode: options.runtimeMode ?? 'meta',
        work: createBackgroundWork(counter, gate),
        ...(options.precomputeConcurrency === undefined
            ? {}
            : { precomputeConcurrency: options.precomputeConcurrency }),
    })

    const documentService = createDocumentService({
        provider: provider?.generateDocument ? provider : null,
        fixtureGenerator: options.runtimeMode === 'fixture' ? (options.documentFixtures ?? null) : null,
        policy,
        runtimeMode: options.runtimeMode ?? 'meta',
        work: createBackgroundWork(counter, gate),
        ...(options.precomputeConcurrency === undefined
            ? {}
            : { precomputeConcurrency: options.precomputeConcurrency }),
    })
    const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
    /** A version 2 document (guide or camera) names itself first; any other screen id is a version 1 page. */
    const stepScreens: Pick<ScreenService, 'resolveStepScreen'> = {
        resolveStepScreen: (session, stepId, screen) => {
            const v2 = documentService.resolveStepScreen(session, stepId, screen)
            return v2 !== null ? v2 : screenService.resolveStepScreen(session, stepId, screen)
        },
    }

    /** Drops everything a provider reported about itself: in the fixture runtime nothing was observed. */
    const unobserved = <V extends { model?: unknown; telemetry?: unknown; evidence?: unknown }>(
        value: V,
    ): Omit<V, 'model' | 'telemetry' | 'evidence'> => {
        const { model: _model, telemetry: _telemetry, evidence: _evidence, ...rest } = value
        return rest
    }
    const asPublic = <V extends { model?: unknown; telemetry?: unknown; evidence?: unknown }>(value: V): V =>
        fixtureProvider ? (unobserved(value) as V) : value
    const asPublicCheck = (value: CheckResult): CheckResult =>
        fixtureProvider ? { ...unobserved(value), evidence: FIXTURE_EVIDENCE } : value
    /** Live values never claim fixture evidence: only the fixture runtime stamps it. */
    const honest = (value: { evidence?: unknown }): boolean => fixtureProvider || value.evidence === undefined

    const prepareCheck = (
        metadata: ModelCheckMetadata,
        files: Map<string, File>,
        deadline: Deadline,
    ): Promise<CheckStepInput> => checkFiles(metadata, files, deadline, stepScreens)

    function jsonHandler<M extends Identity, I, T>(
        schema: z.ZodType<M>,
        output: z.ZodType<T>,
        duration: number,
        prepare: (metadata: M, files: Map<string, File>, deadline: Deadline) => Promise<I>,
        dispatch: ((input: I, signal: AbortSignal) => Promise<T>) | null,
        validate: (value: T, metadata: M) => boolean,
        scopeHeaders?: (metadata: M) => Record<string, string>,
        publish?: (value: T, input: I) => { value: T; rollback?: () => void },
        policy: {
            repairable?: boolean
            /** Called once the request identity is parsed and authorized, before any provider work. */
            onMetadata?: (metadata: M) => void
            /** Route name and the resolved path (for example verdict-only), for the outcome log. */
            route?: string
            path?: string
            /** The value as published: the fixture runtime strips what a provider claimed about itself. */
            present?: (value: T) => T
        } = {},
    ): Handler {
        return async (request): Promise<Response> => {
            let execution: Execution | undefined
            let metadata: M | undefined
            let rollback: (() => void) | undefined
            let releaseSlot: (() => void) | undefined
            try {
                execution = admit(request, auth, duration, allowedOrigins)
                if (policy.repairable) execution.context.repair = { used: false }
                if (!dispatch) {
                    throw new AdmissionError('unconfigured', 503)
                }
                const parsed = await readModelMultipart(request, schema, 9 * 1_024 * 1_024, execution.deadline)
                execution.check()
                metadata = parsed.metadata
                policy.onMetadata?.(metadata)
                const input = await prepare(metadata, parsed.files, execution.deadline)
                execution.check()
                counter.claim()
                execution.context.counter = counter
                const release = gate.tryAcquire()
                if (release === null) throw new BudgetError()
                releaseSlot = release
                execution.check()
                const providerSignal = execution.deadline.signal
                const active = execution
                const raw = await withinModelDeadline(
                    admission.run({ start: active.startedAt }, () =>
                        effects.run(active.context, (): Promise<T> => dispatch(input, providerSignal)),
                    ),
                    execution.deadline,
                )
                execution.check()
                const value = output.safeParse(raw)
                if (!value.success || !validate(value.data, metadata)) {
                    throw new AdmissionError('invalid_output', 502)
                }
                execution.check()
                const published = publish?.(value.data, input)
                rollback = published?.rollback
                execution.check()
                const response = Response.json(
                    {
                        status: 'ok',
                        // Overlay's explicit fixture contract carries no model/effort. Its transport envelope must
                        // agree so the strict client cannot credit synthetic geometry as a live model response.
                        mode: fixtureProvider && policy.route === 'overlay' ? 'fixture' : 'model',
                        requestId: metadata.requestId,
                        binding: metadata.binding,
                        value: policy.present?.(published?.value ?? value.data) ?? published?.value ?? value.data,
                    },
                    { headers: { 'cache-control': 'no-store', ...scopeHeaders?.(metadata) } },
                )
                execution.check()
                logOutcome({
                    route: policy.route,
                    outcome: 'ok',
                    http: 200,
                    source: 'provider',
                    path: policy.path,
                    // A fixture runtime logs no model or provider metric: none was observed.
                    ...(fixtureProvider
                        ? { evidence: FIXTURE_EVIDENCE, inference: false }
                        : { model: (value.data as { model?: string }).model, ...telemetryFields(value.data) }),
                })
                return corsResponse(request, response, allowedOrigins)
            } catch (error) {
                rollback?.()
                const failure = errorResult(error, execution)
                logOutcome({
                    route: policy.route,
                    outcome: 'error',
                    code: failure.code,
                    http: failure.status,
                    path: policy.path,
                    dispatched: execution?.context.dispatched ?? false,
                    ...(execution === undefined
                        ? {}
                        : { elapsedMs: Math.max(0, performance.now() - execution.startedAt) }),
                })
                return corsResponse(
                    request,
                    Response.json(fail(failure.code, metadata ?? failure.identity, failure.message), {
                        status: failure.status,
                        headers: { 'cache-control': 'no-store' },
                    }),
                    allowedOrigins,
                )
            } finally {
                releaseSlot?.()
                execution?.dispose()
            }
        }
    }

    const parse = jsonHandler(
        parseRouteMetadataSchema,
        parsedManualSchema,
        policy.stages.parse.deadlineMs + PARSE_ROUTE_MARGIN_MS,
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
        undefined,
        undefined,
        { repairable: true, route: 'parse', present: (value) => asPublic(value) },
    )
    const scopeHeaders = (metadata: ModelCheckMetadata): Record<string, string> => {
        const mode = options.checkContext ?? 'full'
        const selected =
            mode === 'compact'
                ? selectCompactStepSourcePageIds(metadata.session, metadata.binding.stepId)
                : metadata.session.pages.map((page) => page.pageId)
        return { 'x-truebuild-check-context': mode, 'x-truebuild-source-pages': String(selected?.length ?? 0) }
    }
    function publishSecondOpinion(
        value: CheckResult,
        input: CheckStepInput,
    ): { value: CheckResult; rollback?: () => void } {
        const model = options.secondOpinionModel
        if (
            !model ||
            !provider?.secondOpinion ||
            value.decision !== 'cannot_verify' ||
            (value.model !== 'muse-spark-1.3' && !(fixtureProvider && value.model === undefined))
        )
            return { value }
        const token = tickets.issue(input, value)
        return token
            ? {
                  value: { ...value, secondOpinion: { model, status: 'available', token } },
                  rollback: () => tickets.revoke(token),
              }
            : { value: unavailableSecondOpinion(value, model, fixtureProvider) }
    }

    /** SAM prompts are noun phrases built only from validated part names of the bound step. */
    function segmentPrompts(input: CheckStepInput): string[] {
        const step = input.session.reviewedSteps.find((candidate) => candidate.stepId === input.binding.stepId)
        if (!step) return []
        const ids = new Set(step.parts.map((part) => part.partId))
        const prompts = input.session.parts.flatMap((part) =>
            ids.has(part.partId) &&
            part.name.state === 'known' &&
            segmentPromptSchema.safeParse(part.name.value).success
                ? [segmentPromptSchema.parse(part.name.value)]
                : [],
        )
        return [...new Set(prompts)].slice(0, SEGMENT_PROMPT_LIMIT)
    }

    const questionIdentify = new AsyncLocalStorage<(identity: QuestionIdentity) => void>()
    const check = jsonHandler(
        modelCheckMetadataSchema,
        checkResultSchema,
        checkTimeoutMs,
        prepareCheck,
        provider
            ? async (input, signal): ReturnType<MetaProvider['checkStep']> =>
                  withResolvedLayout(await provider.checkStep(input, signal), input, layout)
            : null,
        (value, metadata): boolean =>
            (value.model === undefined || value.model === 'muse-spark-1.3') &&
            honest(value) &&
            value.secondOpinion === undefined &&
            value.sourceRefs.every((ref) => metadata.sourcePageIds.includes(ref.pageId)),
        scopeHeaders,
        (value, input): { value: CheckResult; rollback?: () => void } => {
            const second = publishSecondOpinion(value, input)
            if (!offerOverlay && !offerSegments) return second
            // Follow-ups never touch the decision, reason or citations: they only offer later, separate work.
            const followUps: NonNullable<CheckResult['followUps']> = {}
            const revokes: (() => void)[] = [(): void => second.rollback?.()]
            if (offerOverlay) {
                const token = overlayTickets.issue(input, second.value)
                followUps.overlay = token
                    ? { status: 'available', model: policy.stages.overlay.model, token }
                    : { status: 'unavailable' }
                if (token) revokes.push(() => overlayTickets.revoke(token))
            }
            if (offerSegments) {
                const prompts = segmentPrompts(input)
                if (prompts.length > 0) followUps.segments = { status: 'available', model: 'sam-3.1', prompts }
            }
            return {
                value: Object.keys(followUps).length > 0 ? { ...second.value, followUps } : second.value,
                rollback: () => revokes.forEach((revoke) => revoke()),
            }
        },
        // With the overlay stage offered the Spark call is verdict-only; without it the verdict carries its own region.
        { route: 'check', path: offerOverlay ? 'verdict-only' : 'verdict', present: asPublicCheck },
    )
    const questionRun = jsonHandler(
        modelQuestionMetadataSchema,
        questionResultSchema,
        policy.stages.questions.deadlineMs,
        async (
            metadata: ModelQuestionMetadata,
            files,
            deadline,
        ): Promise<CheckStepInput & Pick<ModelQuestionMetadata, 'question' | 'target'>> => ({
            ...(await prepareCheck(metadata, files, deadline)),
            question: metadata.question,
            target: metadata.target,
        }),
        provider
            ? async (input, signal): ReturnType<MetaProvider['answerQuestion']> =>
                  withResolvedLayout(await provider.answerQuestion(input, signal), input, layout)
            : null,
        (value, metadata): boolean =>
            (value.model === undefined || value.model === 'muse-spark-1.3') &&
            value.sourceRefs.every((ref) => metadata.sourcePageIds.includes(ref.pageId)),
        scopeHeaders,
        undefined,
        {
            route: 'question',
            present: (value) => asPublic(value),
            onMetadata: (metadata): void => {
                const identify = questionIdentify.getStore()
                identify?.({ requestId: metadata.requestId, binding: metadata.binding })
            },
        },
    )

    const overlayIdentify = new AsyncLocalStorage<(identity: QuestionIdentity) => void>()
    const overlayRun = jsonHandler(
        modelOverlayMetadataSchema,
        overlayResultSchema,
        policy.stages.overlay.deadlineMs,
        async (metadata: ModelOverlayMetadata, files, deadline): Promise<OverlayInput> => {
            if (!offerOverlay) throw new AdmissionError('unconfigured', 503)
            // A newer revision of this manual supersedes the photo's session before any ticket is spent.
            if (!observeRevision(metadata.binding.manualId, metadata.binding.revision)) {
                throw new AdmissionError('invalid_input', 409)
            }
            const input = await prepareCheck(metadata, files, deadline)
            const primary = overlayTickets.consume(metadata.overlayToken, input)
            if (!primary) throw new AdmissionError('duplicate_request', 409)
            return { ...input, verdict: { decision: primary.decision, reason: primary.reason } }
        },
        provider?.overlay
            ? async (input, signal): Promise<OverlayResult> => {
                  const generation = await provider.overlay!(input, signal)
                  const { observedRegion, layout: proposed, nextPartRegion, targetRegion } = generation.value
                  // The published decision is fixed context: only regions of real current-step parts survive.
                  const resolved = withResolvedLayout(
                      { decision: input.verdict.decision, layout: proposed, nextPartRegion, targetRegion },
                      input,
                      true,
                  )
                  const regions = {
                      observedRegion,
                      ...(resolved.nextPartRegion ? { nextPartRegion: resolved.nextPartRegion } : {}),
                      ...(resolved.targetRegion ? { targetRegion: resolved.targetRegion } : {}),
                      ...(resolved.layout ? { layout: resolved.layout } : {}),
                  }
                  // The fixture runtime publishes regions only: whatever the source reported of itself is dropped.
                  if (fixtureProvider) return { evidence: FIXTURE_EVIDENCE, ...regions }
                  // A live overlay must carry what its call observed; a fixture-shaped generation is never published.
                  if (generation.telemetry === undefined || generation.evidence !== undefined) {
                      throw new AdmissionError('invalid_output', 502)
                  }
                  return {
                      model: generation.telemetry.model,
                      effort: generation.telemetry.effort,
                      telemetry: observedTelemetry(generation.telemetry),
                      ...regions,
                  }
              }
            : null,
        () => true,
        undefined,
        undefined,
        {
            route: 'overlay',
            path: 'overlay',
            onMetadata: (metadata): void => {
                overlayIdentify.getStore()?.({ requestId: metadata.requestId, binding: metadata.binding })
            },
        },
    )

    const delay = (milliseconds: number): Promise<void> =>
        new Promise((resolve) => {
            const timer = setTimeout(resolve, milliseconds)
            timer.unref?.()
        })
    /** A terminal job outcome, collected gracefully (HTTP 200, `unavailable`), never as a gateway timeout. */
    const terminalJob = (kind: 'expired' | 'failed', identity: QuestionIdentity | undefined): StoredResponse => ({
        status: 200,
        body: JSON.stringify(fail(kind === 'expired' ? 'timeout' : 'provider_error', identity)),
        headers: [
            ['content-type', 'application/json'],
            ['cache-control', 'no-store'],
        ],
    })
    /** A newer revision of either screen generation supersedes older work; an older one is stale. */
    const observeRevision = (manualId: string, revision: number): boolean => {
        const current = screenService.observe(manualId, revision)
        return documentService.observe(manualId, revision) && current
    }
    const questionSyncWaitMs = options.questionSyncWaitMs ?? 8_000
    const storedResponse = (request: Request, stored: StoredResponse): Response =>
        corsResponse(
            request,
            new Response(stored.body, { status: stored.status, headers: new Headers(stored.headers) }),
            allowedOrigins,
        )
    const rejected = (request: Request, error: unknown, identity?: Identity): Response => {
        const failure = errorResult(error)
        return corsResponse(
            request,
            Response.json(fail(failure.code, identity ?? failure.identity), {
                status: failure.status,
                headers: { 'cache-control': 'no-store' },
            }),
            allowedOrigins,
        )
    }
    function authorize(request: Request): void {
        auth.authenticate(request)
        if (!isAllowedOrigin(request, allowedOrigins)) throw new AuthenticationError()
    }
    async function jobRequest(request: Request): Promise<z.infer<typeof modelQuestionJobMetadataSchema>> {
        authorize(request)
        let body: unknown
        try {
            body = await readBoundedJson(request)
        } catch (error) {
            throw error instanceof InvalidBodyError
                ? new ModelBodyError(error.status as 400 | 413 | 415)
                : new ModelBodyError(400)
        }
        const parsed = modelQuestionJobMetadataSchema.safeParse(body)
        if (!parsed.success) throw new ModelBodyError(400)
        return parsed.data
    }

    /**
     * Job custody shared by slow questions and overlays. One original request (request id and exact capture binding)
     * owns at most one job: it runs server-side for its own budget, and a request that is not answered within the sync
     * wait gets a 202 ticket (never a 504) to collect with `result`, or to `cancel`. A timeout is collected as a 200
     * `unavailable`; a late arrival is collected like any answer. A repeat is refused before any provider dispatch.
     */
    function jobEndpoints(
        jobs: QuestionJobs,
        run: Handler,
        identifyStore: AsyncLocalStorage<(identity: QuestionIdentity) => void>,
    ): { start: Handler; result: Handler; cancel: Handler } {
        const pendingResponse = (request: Request, job: NonNullable<ReturnType<typeof jobs.start>>): Response =>
            corsResponse(
                request,
                Response.json(
                    pendingResultSchema.parse({
                        status: 'pending',
                        requestId: job.identity!.requestId,
                        binding: job.identity!.binding,
                        ticket: job.ticket,
                        retryAfterMs: 1_500,
                        expiresInMs: jobs.remainingMs(job),
                    }),
                    { status: 202, headers: { 'cache-control': 'no-store' } },
                ),
                allowedOrigins,
            )
        const start: Handler = async (request): Promise<Response> => {
            try {
                authorize(request)
            } catch (error) {
                await request.body?.cancel().catch((): void => {})
                return rejected(request, error)
            }
            const job = jobs.start(async (signal, identify) => {
                const init: StreamingInit = {
                    method: request.method,
                    headers: request.headers,
                    body: request.body,
                    signal,
                    duplex: 'half',
                }
                const forwarded = new Request(request.url, init)
                let known: QuestionIdentity | undefined
                const tracked = (identity: QuestionIdentity): void => {
                    try {
                        identify(identity)
                    } catch (error) {
                        // The same original request is already owned by a job: reject before any provider dispatch.
                        if (error instanceof DuplicateQuestionError) {
                            throw new AdmissionError('duplicate_request', 409, undefined, identity)
                        }
                        throw error
                    }
                    known = identity
                }
                const response = await identifyStore.run(tracked, () => run(forwarded))
                const body = await response.text()
                // A processing-deadline expiry is a terminal outcome the person can collect, not a gateway timeout.
                if (response.status === 504) return terminalJob('expired', known)
                return { status: response.status, body, headers: [...response.headers] }
            })
            if (!job) {
                await request.body?.cancel().catch((): void => {})
                return rejected(request, new BudgetError())
            }
            await Promise.race([job.settled, delay(questionSyncWaitMs)])
            if (!job.stored && !job.identity) await Promise.race([job.identified, job.settled])
            if (job.stored) return storedResponse(request, job.stored)
            return job.identity ? pendingResponse(request, job) : rejected(request, new ModelBodyError(400))
        }
        const result: Handler = async (request): Promise<Response> => {
            try {
                const metadata = await jobRequest(request)
                const job = jobs.find(metadata.ticket, metadata.requestId, metadata.binding)
                if (!job) return rejected(request, new ModelBodyError(400), metadata)
                if (!job.stored) await Promise.race([job.settled, delay(Math.min(questionSyncWaitMs, 5_000))])
                if (job.stored) return storedResponse(request, job.stored)
                return job.finishedAt === undefined
                    ? pendingResponse(request, job)
                    : rejected(request, new RequestStoppedError('cancelled'), metadata)
            } catch (error) {
                return rejected(request, error)
            }
        }
        const cancel: Handler = async (request): Promise<Response> => {
            try {
                const metadata = await jobRequest(request)
                if (!jobs.cancel(metadata.ticket, metadata.requestId, metadata.binding)) {
                    return rejected(request, new ModelBodyError(400), metadata)
                }
                return corsResponse(
                    request,
                    new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
                    allowedOrigins,
                )
            } catch (error) {
                return rejected(request, error)
            }
        }
        return { start, result, cancel }
    }

    const questionJobs: QuestionJobs = new QuestionJobs({
        processingMs: policy.stages.questions.deadlineMs,
        terminal: terminalJob,
        // Before any provider work: an older revision is rejected, a newer one cancels older work of the manual.
        onIdentity: (identity, job): void => {
            const { manualId, revision } = identity.binding
            if (!observeRevision(manualId, revision))
                throw new AdmissionError('invalid_input', 409, undefined, identity)
            questionJobs.supersede(manualId, revision, job.ticket)
        },
    })
    const overlayJobs: QuestionJobs = new QuestionJobs({
        processingMs: policy.stages.overlay.deadlineMs,
        terminal: terminalJob,
        onIdentity: (identity, job): void => {
            const { manualId, revision } = identity.binding
            if (!observeRevision(manualId, revision))
                throw new AdmissionError('invalid_input', 409, undefined, identity)
            overlayJobs.supersede(manualId, revision, job.ticket)
        },
    })
    /**
     * A screen request (either generation) for a newer revision of a manual cancels that manual's older running question
     * and overlay jobs now, not only when another job later arrives: their photo and verdict belong to a manual state the
     * person has already left. An aborted job stores a terminal `unavailable`, so nothing is published late.
     */
    const supersedeFollowUps = (session: ManualSession | null): void => {
        if (session === null) return
        observeRevision(session.manualId, session.revision)
        questionJobs.supersede(session.manualId, session.revision, '')
        overlayJobs.supersede(session.manualId, session.revision, '')
    }
    const questions = jobEndpoints(questionJobs, questionRun, questionIdentify)
    const overlays = jobEndpoints(overlayJobs, overlayRun, overlayIdentify)
    const question = questions.start
    const questionResult = questions.result
    const questionCancel = questions.cancel
    const overlay = overlays.start
    const overlayResult = overlays.result
    const overlayCancel = overlays.cancel

    const screens: Handler = async (request): Promise<Response> => {
        let execution: Execution | undefined
        let metadata: ModelScreensMetadata | undefined
        try {
            const route = Math.min(
                MAX_DEADLINE_MS,
                Math.max(policy.stages.screens.deadlineMs, policy.stages['step-pages'].deadlineMs) * 2 + 5_000,
            )
            execution = admit(request, auth, route, allowedOrigins)
            const parsed = await readModelMultipart(
                request,
                modelScreensMetadataSchema,
                MODEL_METADATA_MAX_BYTES + 65_536,
                execution.deadline,
            )
            exactModelFiles(parsed.files, [], false)
            metadata = parsed.metadata
            execution.check()
            if (metadata.op === 'generate' || metadata.op === 'precompute') supersedeFollowUps(metadata.session)
            const inputs = {
                kind: metadata.kind ?? 'home',
                session: metadata.session,
                stepId: metadata.stepId,
                captureId: metadata.captureId,
                result: metadata.result,
                failure: metadata.failure,
                completedStepIds: metadata.completedStepIds,
                uiState: metadata.uiState,
            } as const
            let value: ScreensValue = {
                document: null,
                progress: null,
                documents: [],
            }
            if (metadata.op === 'generate') {
                try {
                    const active = execution
                    const document = await admission.run({ start: active.startedAt }, () =>
                        screenService.generate(inputs, active.deadline.signal),
                    )
                    value = { ...value, document }
                } catch (error) {
                    execution.check()
                    // A slow generation never blocks the screen: the deterministic composition is returned instead.
                    if (!(error instanceof RequestStoppedError)) throw error
                    value = { ...value, document: screenService.fallback(inputs, 'timeout') }
                }
            } else if (metadata.op === 'precompute') {
                value = { ...value, progress: screenService.precompute(metadata.session!, metadata.focusStepId) }
            } else if (metadata.op === 'progress') {
                const read = screenService.progress(
                    metadata.binding!.manualId,
                    metadata.binding!.revision,
                    metadata.want,
                )
                value = { ...value, progress: read.progress, documents: read.documents }
            } else {
                value = {
                    ...value,
                    progress: screenService.cancel(metadata.binding!.manualId, metadata.binding!.revision),
                }
            }
            execution.check()
            const body = screensResultSchema.parse({
                status: 'ok',
                requestId: metadata.requestId,
                mode: provider ? 'model' : 'fixture',
                value,
            })
            const meta = value.document?.metadata
            logOutcome({
                route: 'screens',
                outcome: 'ok',
                http: 200,
                op: metadata.op,
                kind: metadata.kind,
                ...(meta === undefined
                    ? {}
                    : {
                          source: meta.source,
                          evidence: meta.evidence,
                          fallbackReason: meta.fallbackReason,
                          model: meta.model,
                          effort: meta.effort,
                          stage: meta.stage,
                          cacheHit: meta.cacheHit,
                          repaired: meta.repaired,
                          ...meta.timing,
                          ...meta.usage,
                      }),
            })
            return corsResponse(
                request,
                Response.json(body, { headers: { 'cache-control': 'no-store' } }),
                allowedOrigins,
            )
        } catch (error) {
            const failure = errorResult(error, execution)
            return corsResponse(
                request,
                Response.json(
                    {
                        status: 'unavailable',
                        requestId: metadata?.requestId ?? 'invalid-request',
                        binding: null,
                        code: failure.code,
                        retryable: false,
                    },
                    { status: failure.status, headers: { 'cache-control': 'no-store' } },
                ),
                allowedOrigins,
            )
        } finally {
            execution?.dispose()
        }
    }

    /**
     * Version 2 whole-screen documents. Bound to the full state: the supplied session must hash to `manualHash` and,
     * for `generate`, the recomputed context key must equal the client's; a mismatch is a client bug (400), never a
     * silently different document.
     */
    const screensV2: Handler = async (request): Promise<Response> => {
        let execution: Execution | undefined
        let metadata: ModelScreensV2Metadata | undefined
        try {
            const route = Math.min(
                MAX_DEADLINE_MS,
                Math.max(policy.stages.screens.deadlineMs, policy.stages['step-pages'].deadlineMs) * 2 + 5_000,
            )
            execution = admit(request, auth, route, allowedOrigins)
            const parsed = await readModelMultipart(
                request,
                modelScreensV2MetadataSchema,
                MODEL_METADATA_MAX_BYTES + 65_536,
                execution.deadline,
            )
            exactModelFiles(parsed.files, [], false)
            metadata = parsed.metadata
            execution.check()
            if (metadata.session !== null && sha256(screenManualJsonV2(metadata.session)) !== metadata.manualHash) {
                throw new AdmissionError('invalid_input', 400)
            }
            const inputs: ScreenContextInputsV2 = {
                kind: metadata.kind ?? 'home',
                session: metadata.session,
                stepId: metadata.stepId,
                captureId: metadata.captureId,
                result: metadata.result,
                failure: metadata.failure,
                completedStepIds: metadata.completedStepIds,
                uiState: metadata.uiState,
                ...(metadata.companionAnswer == null ? {} : { companionAnswer: metadata.companionAnswer }),
            }
            let value: Extract<z.infer<typeof screensV2ResultSchema>, { status: 'ok' }>['value'] = {
                document: null,
                progress: null,
                documents: [],
            }
            if (metadata.op === 'generate') {
                if (sha256(screenContextJsonV2(inputs)) !== metadata.contextKey) {
                    throw new AdmissionError('invalid_input', 400)
                }
                supersedeFollowUps(metadata.session)
                try {
                    const active = execution
                    const document = await admission.run({ start: active.startedAt }, () =>
                        documentService.generate(inputs, active.deadline.signal),
                    )
                    value = { ...value, document }
                } catch (error) {
                    execution.check()
                    // A slow generation never blocks the screen: the complete deterministic document is returned.
                    if (!(error instanceof RequestStoppedError)) throw error
                    value = { ...value, document: documentService.fallback(inputs, 'timeout') }
                }
            } else if (metadata.op === 'precompute') {
                supersedeFollowUps(metadata.session)
                value = {
                    ...value,
                    progress: documentService.precompute({
                        session: metadata.session!,
                        focusKey: metadata.focusKey,
                        uiState: metadata.uiState,
                        completedStepIds: metadata.completedStepIds,
                        requestedKinds: metadata.requestedKinds,
                    }),
                }
            } else if (metadata.op === 'progress') {
                const read = documentService.progress(
                    metadata.binding!.manualId,
                    metadata.binding!.revision,
                    metadata.want,
                    documentService.jobContextKey({
                        session: metadata.session!,
                        focusKey: null,
                        uiState: metadata.uiState,
                        completedStepIds: metadata.completedStepIds,
                        requestedKinds: metadata.requestedKinds,
                    }),
                )
                value = { ...value, progress: read.progress, documents: read.documents }
            } else {
                value = {
                    ...value,
                    progress: documentService.cancel(
                        metadata.binding!.manualId,
                        metadata.binding!.revision,
                        documentService.jobContextKey({
                            session: metadata.session!,
                            focusKey: null,
                            uiState: metadata.uiState,
                            completedStepIds: metadata.completedStepIds,
                            requestedKinds: metadata.requestedKinds,
                        }),
                    ),
                }
            }
            execution.check()
            const body = screensV2ResultSchema.parse({
                status: 'ok',
                requestId: metadata.requestId,
                mode: options.runtimeMode === 'fixture' ? 'fixture' : 'model',
                value,
            })
            const meta = value.document?.metadata
            logOutcome({
                route: 'screens-v2',
                outcome: 'ok',
                http: 200,
                op: metadata.op,
                kind: metadata.kind,
                ...(meta === undefined
                    ? {}
                    : {
                          source: meta.source,
                          evidence: meta.evidence,
                          fallbackReason: meta.fallbackReason,
                          model: meta.model,
                          effort: meta.effort,
                          stage: meta.stage,
                          cacheHit: meta.cacheHit,
                          repaired: meta.repaired,
                          rejectedIssues: meta.rejectedIssues,
                          ...meta.timing,
                          ...meta.usage,
                      }),
            })
            return corsResponse(
                request,
                Response.json(body, { headers: { 'cache-control': 'no-store' } }),
                allowedOrigins,
            )
        } catch (error) {
            const failure = errorResult(error, execution)
            return corsResponse(
                request,
                Response.json(
                    {
                        status: 'unavailable',
                        requestId: metadata?.requestId ?? 'invalid-request',
                        binding: null,
                        code: failure.code,
                        retryable: false,
                    },
                    { status: failure.status, headers: { 'cache-control': 'no-store' } },
                ),
                allowedOrigins,
            )
        } finally {
            execution?.dispose()
        }
    }

    const secondOpinion: Handler = async (request): Promise<Response> => {
        let execution: Execution | undefined
        let metadata: ModelSecondOpinionMetadata | undefined
        let primary: CheckResult | null = null
        let releaseSlot: (() => void) | undefined
        const model = options.secondOpinionModel
        const recordOutcome = (value: CheckResult): void => {
            console.info(
                JSON.stringify({
                    event: 'second_opinion_outcome',
                    ...(fixtureProvider
                        ? { evidence: FIXTURE_EVIDENCE, inference: false }
                        : {
                              primaryModel: primary!.model,
                              secondaryModel: model,
                              resultModel: value.model,
                              ...telemetryFields(value),
                          }),
                    outcome:
                        value.secondOpinion?.status === 'unavailable'
                            ? 'unavailable_retained'
                            : value.decision === 'refuse'
                              ? 'refused'
                              : 'uncertainty_retained',
                    dispatched: execution?.context.dispatched ?? false,
                }),
            )
        }
        const success = (value: CheckResult): Response => {
            return corsResponse(
                request,
                Response.json(
                    {
                        status: 'ok',
                        mode: 'model',
                        requestId: metadata!.requestId,
                        binding: metadata!.binding,
                        value: asPublicCheck(value),
                    },
                    { headers: { 'cache-control': 'no-store', ...scopeHeaders(metadata!) } },
                ),
                allowedOrigins,
            )
        }
        try {
            execution = admit(request, auth, policy.stages['second-opinion'].deadlineMs, allowedOrigins)
            if (!model || !provider?.secondOpinion) throw new AdmissionError('unconfigured', 503)
            const parsed = await readModelMultipart(
                request,
                modelSecondOpinionMetadataSchema,
                9 * 1_024 * 1_024,
                execution.deadline,
            )
            metadata = parsed.metadata
            const input = await prepareCheck(metadata, parsed.files, execution.deadline)
            execution.check()
            // Capacity is claimed before the ticket is spent, so a saturated gate leaves the capability intact.
            const slot = gate.tryAcquire()
            if (slot === null) throw new BudgetError()
            releaseSlot = slot
            primary = tickets.consume(metadata.secondOpinionToken, input)
            if (!primary) throw new AdmissionError('duplicate_request', 409)
            execution.check()
            counter.claim()
            execution.context.counter = counter
            const active = execution
            const raw = await withinModelDeadline(
                admission.run({ start: active.startedAt }, () =>
                    effects.run(active.context, async () =>
                        withResolvedLayout(await provider.secondOpinion!(input, active.deadline.signal), input, layout),
                    ),
                ),
                active.deadline,
            )
            active.check()
            const value = checkResultSchema.safeParse(raw)
            if (
                !value.success ||
                (value.data.model !== model && !(fixtureProvider && value.data.model === undefined)) ||
                !honest(value.data) ||
                value.data.secondOpinion !== undefined
            )
                throw new AdmissionError('invalid_output', 502)
            const result = reconcileSecondOpinion(primary, value.data, model, input, fixtureProvider)
            active.check()
            const response = success(result)
            active.check()
            recordOutcome(result)
            return response
        } catch (error) {
            // Once consumed, failure never retries or replaces the original uncertain verdict.
            if (primary && model && !request.signal.aborted) {
                const retained = unavailableSecondOpinion(primary, model, fixtureProvider)
                const response = success(retained)
                recordOutcome(retained)
                return response
            }
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
            releaseSlot?.()
            execution?.dispose()
        }
    }

    const segment: Handler = async (request): Promise<Response> => {
        let execution: Execution | undefined
        let metadata: ModelSegmentMetadata | undefined
        let releaseSlot: (() => void) | undefined
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
            // The stream holds one provider slot until it terminates (done, failed, cancelled or timed out).
            const slot = gate.tryAcquire()
            if (slot === null) throw new BudgetError()
            releaseSlot = slot
            counter.claim()
            execution.context.counter = counter
            execution.check()
            return corsResponse(request, segmentResponse(input, metadata, execution, samProvider, slot), allowedOrigins)
        } catch (error) {
            const failure = errorResult(error, execution)
            releaseSlot?.()
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
    return {
        parse,
        check,
        secondOpinion,
        overlay,
        overlayResult,
        overlayCancel,
        question,
        questionResult,
        questionCancel,
        segment,
        screens,
        screensV2,
        screenService,
        documentService,
        options: modelOptions,
    }
}

function segmentResponse(
    input: SamInput,
    metadata: ModelSegmentMetadata,
    execution: Execution,
    provider: SamProvider,
    release: () => void,
): Response {
    const dispose = (): void => {
        release()
        execution.dispose()
    }
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
            dispose()
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
                    dispose()
                }
            },
            cancel(): void {
                closed = true
                execution.deadline.signal.removeEventListener('abort', abort)
                stop()
                void source.return(undefined).catch((): void => {})
                dispose()
            },
        }),
        { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } },
    )
}
