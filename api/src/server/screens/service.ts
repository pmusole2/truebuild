import {
    SCREEN_CATALOG_VERSION,
    SCREEN_DOCUMENT_VERSION,
    screenDocumentSchema,
    type ManualSession,
    type ScreenBound,
    type ScreenDocument,
    type ScreenKind,
    type ScreenMetadata,
    type ScreenProgress,
    type ScreenProposal,
} from '@truebuild/contracts'

import { BudgetError } from '../budget'
import { admission } from '../request-clock'
import { createDeadline, RequestStoppedError } from '../deadline'
import { withinModelDeadline } from '../model-multipart'
import {
    MetaProviderError,
    type CallTelemetry,
    type MetaProvider,
    type ScreenGeneration,
    type ScreenGenerationInput,
} from '../../providers/meta-provider'
import { SCREEN_PROMPT_VERSION } from '../../providers/screen-prompt'
import type { ShownScreen } from '../../providers/shown-screen'
import {
    LEGACY_GUIDE_DEADLINE_MS,
    MAX_DEADLINE_MS,
    type AiPolicy,
    type GenerativeUiMode,
    type PolicyStage,
} from '../ai-policy'
import { shellScreen, Tally } from './required'
import { buildContext, canonicalJson, sha256, type Decision, type GroundingContext, type ScreenInputs } from './context'
import { finalize, groundProposal, validateProposal, withRequiredContent, type FinalScreen } from './ground'
import { issueShown, resolveShown, type IssuedShown } from './shown'
import { headerTitles, instructionCopy } from './ui-copy'
import { PrecomputeRegistry, ScreenCache, SingleFlight, StaleGuard, StaleRevisionError } from './store'

type FallbackReason = NonNullable<ScreenMetadata['fallbackReason']>

/**
 * Runs provider work inside an admitted, abortable, counted context (no request object). Trusted composition only.
 * `repair` is the one-shot runner for the single same-model repair, valid only inside this context.
 */
export interface BackgroundWork {
    run<T>(options: { deadlineMs: number; signal: AbortSignal }, work: () => Promise<T>): Promise<T>
    repair<T>(work: () => Promise<T>): Promise<T>
    /** Foreground: fails fast (null) when too many provider calls are in flight. */
    tryAcquire(): (() => void) | null
    /** Background callers wait for a non-reserved slot instead of failing. */
    acquire(signal: AbortSignal): Promise<() => void>
}

/** What a test-only synthetic generator is told about the screen it is asked to compose. */
export interface ScreenFixtureRequest {
    kind: ScreenKind
    manualId: string | null
    revision: number | null
    stepId: string | null
    decision: Decision | null
    /** 1 for the first call, 2 for the single repair. */
    attempt: 1 | 2
    /** Exactly what a provider would be shown for this screen (facts with their own source indexes, sources, result). */
    view: { stable: Record<string, unknown>; dynamic: Record<string, unknown> }
    /** The closed interface wording the server accepts for this screen (header titles, instruction copy). */
    copy: { titles: string[]; instructions: string[] }
}

/**
 * Explicit test/fixture composition source. It is wired only by `PROVIDER_MODE=fixture` or an injected test option,
 * never as a fallback for a live provider, and its documents are labeled `synthetic-fixture` with nothing observed.
 * It returns the raw (unvalidated) proposal, which then takes exactly the same validation, grounding and repair path.
 */
export type ScreenFixtureGenerator = (request: ScreenFixtureRequest, signal: AbortSignal) => Promise<unknown>

export interface ScreenServiceOptions {
    provider: Pick<MetaProvider, 'generateScreen'> | null
    fixtureGenerator?: ScreenFixtureGenerator | null
    policy: AiPolicy
    runtimeMode: 'fixture' | 'meta'
    work: BackgroundWork
    cache?: ScreenCache<CachedGeneration>
    /** API routes set this from the query capability; in-process callers retain the existing repair behavior. */
    guideRepair?: boolean
    precomputeConcurrency?: number
    now?: () => Date
}

/**
 * @deprecated Version 1 screens protocol: no production caller (the app renders `ScreenDocumentV2` from `/api/screens/v2`). Kept unchanged for the legacy `ScreenStore`, the `/api/screens` route and their tests; new work uses the version 2 document family. Version 1 has no complete deterministic composition: every outcome that is not an accepted
 * model screen is the honest `shell`.
 */
export interface ScreenService {
    generate(inputs: ScreenInputs, waiter?: AbortSignal): Promise<ScreenDocument>
    /** Deterministic document for an already-known failure (for example a route timeout); never calls the model. */
    fallback(inputs: ScreenInputs, reason: FallbackReason): ScreenDocument
    precompute(session: ManualSession, focusStepId: string | null): ScreenProgress
    progress(
        manualId: string,
        revision: number,
        want: readonly string[],
    ): { progress: ScreenProgress | null; documents: ScreenDocument[] }
    cancel(manualId: string, revision: number): ScreenProgress | null
    /** Documents are only ever composed for the newest revision of a manual. */
    observe(manualId: string, revision: number): boolean
    /**
     * Resolves the generated step screen a check, question or overlay names. `mismatch`: the key does not match what
     * the server recomputes for this session and step, or the screen id was issued for another kind, manual, revision,
     * step or capture. `null`: the screen id is not one this server issued (a restart, an eviction), so it contributes
     * nothing. Otherwise the identity plus what the person was actually shown (blocks, order, parts, figure and source
     * emphasis) and the facts on that page, each re-verified against this request's manual; never client text.
     */
    resolveStepScreen(
        session: ManualSession,
        stepId: string,
        screen: { screenId: string; contextKey: string },
    ): StepScreenContext | 'mismatch' | null
    readonly mode: GenerativeUiMode
}

export interface StepScreenContext {
    screenId: string
    contextKey: string
    kind: 'guide'
    /** The manual facts and witnessed texts that were on the shown page, not every fact of the step. */
    facts: { id: string; kind: string; text: string }[]
    /** Absent only when the issued page cannot be projected into the bounded provider shape. */
    shown?: ShownScreen
}

/** What the server remembers of a page it issued: its exact identity and a projection of the published document. */
interface IssuedScreen {
    contextKey: string
    kind: ScreenKind
    bound: ScreenBound
    /** Only step guides are resolvable; other kinds keep identity so they can never be paired with a guide. */
    shown: IssuedShown | null
}

const sameBound = (a: ScreenBound, b: ScreenBound): boolean =>
    a.manualId === b.manualId &&
    a.revision === b.revision &&
    a.stepId === b.stepId &&
    a.captureId === b.captureId &&
    a.contextKey === b.contextKey

/**
 * The accepted model output for one screen content, with what was observed producing it. It is re-grounded against the
 * requesting context every time it is served, so a later revision of identical facts reuses it without a model call
 * but is never given another manual's identity, review state or actions.
 */
export interface CachedGeneration {
    proposal: ScreenProposal
    observed: Pick<ScreenMetadata, 'model' | 'effort' | 'repaired' | 'timing' | 'usage' | 'generatedAt'>
}

const STEP_PAGE_KINDS: ReadonlySet<ScreenKind> = new Set(['guide', 'result', 'answer'])

/** Background and noncritical pages use the Wonder `step-pages` policy; latency-sensitive screens use `screens`. */
export function stageOf(kind: ScreenKind): Extract<PolicyStage, 'screens' | 'step-pages'> {
    return STEP_PAGE_KINDS.has(kind) ? 'step-pages' : 'screens'
}

function reasonFor(error: unknown): FallbackReason {
    if (error instanceof StaleRevisionError) return 'stale'
    if (error instanceof BudgetError) return 'busy'
    if (error instanceof RequestStoppedError) return error.reason === 'timeout' ? 'timeout' : 'stale'
    if (error instanceof MetaProviderError) {
        if (error.code === 'timeout') return 'timeout'
        if (error.code === 'unconfigured') return 'unconfigured'
        if (error.code === 'invalid_output') return 'invalid_output'
    }
    return 'provider_error'
}

/** A total is known only if every attempt reported the value; one missing observation makes the total unknown. */
function total(values: readonly (number | undefined)[], attempts: number): number | null {
    if (attempts === 0 || values.length < attempts || values.some((value) => value === undefined)) return null
    return (values as number[]).reduce((sum, value) => sum + value, 0)
}

type Evaluated =
    | { ok: true; final: FinalScreen; tally: Tally; proposal: ScreenProposal }
    | { ok: false; issues: string[]; reason: FallbackReason; terminal?: boolean }

export function createScreenService(options: ScreenServiceOptions): ScreenService {
    const { provider, policy, work } = options
    const fixture = provider === null ? (options.fixtureGenerator ?? null) : null
    const now = options.now ?? ((): Date => new Date())
    const cache = options.cache ?? new ScreenCache<CachedGeneration>()
    /** Every precomputed result, including deterministic fallbacks, so progress readers can fetch what a job made. */
    const finished = new ScreenCache<ScreenDocument>(512)
    const flights = new SingleFlight<ScreenDocument>()
    const guard = new StaleGuard()
    const jobs = new PrecomputeRegistry(options.precomputeConcurrency ?? 4)
    const mode = policy.generativeUi
    /** Screen ids this server composed, with the exact identity and shown projection of each (bounded, like the cache). */
    const issued = new ScreenCache<IssuedScreen>(1_024)
    const evidence: ScreenMetadata['evidence'] = provider === null ? 'synthetic-fixture' : 'live'

    /** Model-output cache key: the grounded content plus the model/effort/prompt that produced it. */
    function cacheKey(context: GroundingContext): string {
        const stagePolicy = policy.stages[stageOf(context.kind)]
        return sha256(
            canonicalJson({
                contentKey: context.contentKey,
                model: provider === null ? 'fixture' : stagePolicy.model,
                effort: provider === null ? 'fixture' : stagePolicy.effort,
                prompt: SCREEN_PROMPT_VERSION,
                catalog: SCREEN_CATALOG_VERSION,
            }),
        )
    }

    /** One computation per exact identity (the cache key hashes content only, so identities must not share a flight). */
    const flightKey = (context: GroundingContext): string =>
        sha256(canonicalJson({ cache: cacheKey(context), bound: context.bound }))

    function metadata(
        context: GroundingContext,
        source: ScreenMetadata['source'],
        extra: Partial<ScreenMetadata> & { fallbackReason?: FallbackReason | null },
    ): ScreenMetadata {
        return {
            source,
            evidence,
            stage: stageOf(context.kind) === 'step-pages' ? 'step-page' : 'screen',
            model: null,
            effort: null,
            fallbackReason: null,
            repaired: false,
            cacheHit: false,
            catalogVersion: SCREEN_CATALOG_VERSION,
            promptVersion: SCREEN_PROMPT_VERSION,
            generatedAt: now().toISOString(),
            timing: { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
            usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
            droppedFacts: 0,
            forcedSafety: 0,
            ...extra,
        }
    }

    function assemble(context: GroundingContext, final: FinalScreen, meta: ScreenMetadata): ScreenDocument | null {
        // Mandatory facts ride in every step-bound document, including a shell whose body is empty.
        const facts = final.manualFacts.length > 0 ? { manualFacts: final.manualFacts } : {}
        const candidate = {
            version: SCREEN_DOCUMENT_VERSION,
            kind: context.kind,
            screenId: sha256(
                canonicalJson({
                    bound: context.bound,
                    kind: context.kind,
                    header: final.header,
                    body: final.body,
                    bar: final.bar,
                    sources: final.sources,
                    manualFacts: final.manualFacts,
                    source: meta.source,
                }),
            ),
            bound: context.bound,
            metadata: meta,
            header: final.header,
            body: final.body,
            bar: final.bar,
            sources: final.sources,
            ...facts,
        }
        const parsed = screenDocumentSchema.safeParse(candidate)
        if (parsed.success) {
            issued.set(parsed.data.screenId, {
                contextKey: parsed.data.bound.contextKey,
                kind: parsed.data.kind,
                bound: parsed.data.bound,
                shown: parsed.data.kind === 'guide' ? issueShown(parsed.data) : null,
            })
        }
        return parsed.success ? parsed.data : null
    }

    function groundingMeta(tally: Tally): Pick<ScreenMetadata, 'droppedFacts' | 'forcedSafety' | 'grounding'> {
        return {
            droppedFacts: tally.droppedBlocks + tally.droppedItems,
            forcedSafety: tally.forcedSafety,
            grounding: {
                droppedBlocks: tally.droppedBlocks,
                droppedItems: tally.droppedItems,
                replacedComponents: tally.replacedComponents,
                forcedRequired: tally.forcedRequired,
            },
        }
    }

    /**
     * The honest shell, never a composed replacement: an empty body (the native screen is the screen) with every mandatory
     * manual fact in the remainder. Used whenever no model screen is available or acceptable; never calls the model.
     */
    function deterministic(
        context: GroundingContext,
        reason: FallbackReason,
        extra: Partial<ScreenMetadata> = {},
    ): ScreenDocument {
        const forced = withRequiredContent(shellScreen(context), context, new Tally())
        // The mandatory facts are not body blocks: a shell still carries every one of them, all in the remainder.
        const final = finalize(
            {
                ...forced.screen,
                items: [],
                facts: forced.screen.facts.map((slot) => ({ ...slot, placement: 'remainder' as const })),
            },
            context,
        )
        const document = assemble(
            context,
            final,
            metadata(context, 'shell', {
                // Required content that cannot fit one document is reported as such (an honest 'disabled' stays disabled).
                fallbackReason: !forced.complete && reason !== 'disabled' ? 'unsupported_content' : reason,
                origins: Object.fromEntries(Object.keys(final.origins).map((path) => [path, 'shell'])),
                ...extra,
            }),
        )
        // The shell is validated by tests; if it ever failed, publish nothing rather than garbage.
        if (document === null) throw new Error('invalid_screen_composition')
        return document
    }

    function evaluate(context: GroundingContext, value: unknown, timed: <T>(fn: () => T) => T): Evaluated {
        const validated = timed(() => validateProposal(value))
        if (!validated.ok) return { ok: false, issues: validated.issues, reason: 'repair_failed' }
        const grounded = timed(() => groundProposal(validated.proposal, context))
        if (grounded === null) {
            return { ok: false, issues: ['grounding:no_supported_block'], reason: 'unsupported_content' }
        }
        if (!grounded.complete) {
            // The actual verdict or answer cannot fit one document body; a repair cannot change that.
            return {
                ok: false,
                issues: ['grounding:required_content_overflow'],
                reason: 'unsupported_content',
                terminal: true,
            }
        }
        const final = finalize(grounded.screen, context)
        // A screen where nothing the model composed survived unchanged is not a generated screen.
        if (final.source !== 'generated') {
            return { ok: false, issues: ['grounding:no_unchanged_component'], reason: 'unsupported_content' }
        }
        return { ok: true, final, tally: grounded.tally, proposal: validated.proposal }
    }

    /** Re-grounds an accepted proposal for the requesting context; null if it no longer yields a generated screen. */
    function fromCache(context: GroundingContext, cached: CachedGeneration): ScreenDocument | null {
        const grounded = groundProposal(cached.proposal, context)
        if (grounded === null || !grounded.complete) return null
        const final = finalize(grounded.screen, context)
        if (final.source !== 'generated') return null
        return assemble(
            context,
            final,
            metadata(context, 'generated', {
                ...cached.observed,
                cacheHit: true,
                origins: final.origins,
                ...groundingMeta(grounded.tally),
            }),
        )
    }

    interface Made {
        document: ScreenDocument
        cached: CachedGeneration | null
    }

    async function generateWithModel(context: GroundingContext, signal: AbortSignal): Promise<Made> {
        const stage = stageOf(context.kind)
        const stagePolicy = policy.stages[stage]
        const legacyGuide = context.kind === 'guide' && options.guideRepair === false
        const workBudgetMs = legacyGuide
            ? Math.min(LEGACY_GUIDE_DEADLINE_MS, stagePolicy.deadlineMs)
            : Math.min(MAX_DEADLINE_MS, stagePolicy.deadlineMs * 2 + 2_000)
        const workStarted = performance.now()
        const generateScreen = provider?.generateScreen
        if ((provider === null || !generateScreen) && fixture === null) {
            return { document: deterministic(context, 'unconfigured'), cached: null }
        }
        const started = admission.getStore()?.start ?? performance.now()
        const base: ScreenGenerationInput = {
            requestId: `screen-${context.bound.contextKey.slice(0, 16)}`,
            stage,
            stable: context.view.stable,
            dynamic: context.view.dynamic,
        }
        const telemetry: CallTelemetry[] = []
        let dispatched = 0
        let repaired = false
        let validationMs = 0
        const timed = <T>(fn: () => T): T => {
            const at = performance.now()
            try {
                return fn()
            } finally {
                validationMs += performance.now() - at
            }
        }
        const observed = (): Pick<ScreenMetadata, 'model' | 'effort' | 'repaired' | 'timing' | 'usage'> => {
            if (provider === null) {
                // A synthetic example observed nothing: no model, effort, timing or usage is claimed.
                return {
                    model: null,
                    effort: null,
                    repaired,
                    timing: { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
                    usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
                }
            }
            const last = telemetry[telemetry.length - 1]
            const sum = (pick: (call: CallTelemetry) => number | undefined): number | null =>
                total(telemetry.map(pick), dispatched)
            const parse = sum((call) => call.parseValidateMs)
            return {
                model: last?.model ?? null,
                effort: last?.effort ?? null,
                repaired,
                timing: {
                    timeToProviderMs: telemetry[0]?.timeToProviderMs ?? null,
                    providerMs: sum((call) => call.providerMs),
                    parseValidateMs: parse === null ? null : parse + validationMs,
                    totalMs: Math.max(0, performance.now() - started),
                    paceWaitMs: sum((call) => call.paceWaitMs),
                    networkMs: sum((call) => call.networkMs),
                    bodyMs: sum((call) => call.bodyMs),
                },
                usage: {
                    inputTokens: sum((call) => call.usage.inputTokens),
                    cachedTokens: sum((call) => call.usage.cachedTokens),
                    outputTokens: sum((call) => call.usage.outputTokens),
                    reasoningTokens: sum((call) => call.usage.reasoningTokens),
                },
            }
        }
        const failure = (reason: FallbackReason): Made => ({
            document: deterministic(context, reason, observed()),
            cached: null,
        })

        /** One call of the model (or of the synthetic generator). A rejected call reports what it observed. */
        const attempt = async (repairIssues?: readonly string[]): Promise<unknown> => {
            const attemptMs =
                context.kind === 'guide' && fixture === null
                    ? workBudgetMs - (performance.now() - workStarted)
                    : legacyGuide
                      ? workBudgetMs
                      : stagePolicy.deadlineMs
            if (attemptMs <= 0) throw new RequestStoppedError('timeout')
            dispatched += 1
            const deadline = createDeadline(attemptMs, signal)
            try {
                deadline.checkpoint()
                if (fixture !== null) {
                    return await withinModelDeadline(
                        fixture(
                            {
                                kind: context.kind,
                                manualId: context.bound.manualId,
                                revision: context.bound.revision,
                                stepId: context.bound.stepId,
                                decision: context.decision,
                                attempt: repairIssues === undefined ? 1 : 2,
                                view: context.view,
                                copy: { titles: headerTitles(context), instructions: instructionCopy(context) },
                            },
                            deadline.signal,
                        ),
                        deadline,
                    )
                }
                const call = (): Promise<ScreenGeneration> =>
                    generateScreen!.call(
                        provider,
                        repairIssues === undefined ? base : { ...base, repairIssues },
                        deadline.signal,
                        context.kind === 'guide' ? attemptMs : undefined,
                    )
                const generation = await withinModelDeadline(
                    repairIssues === undefined ? call() : work.repair(call),
                    deadline,
                ).catch((error: unknown) => {
                    if (error instanceof MetaProviderError && error.telemetry) telemetry.push(error.telemetry)
                    throw error
                })
                telemetry.push(generation.telemetry)
                deadline.checkpoint()
                return generation.value
            } finally {
                deadline.dispose()
            }
        }

        const isMalformed = (error: unknown): boolean =>
            error instanceof MetaProviderError && error.code === 'invalid_output' && error.detail === 'malformed'

        const run = async (): Promise<Made> => {
            let evaluated: Evaluated
            try {
                evaluated = evaluate(context, await attempt(), timed)
            } catch (error) {
                // Only a completed-but-unusable answer may be repaired; incomplete, timeout and ambiguous dispatch never.
                if (!isMalformed(error)) throw error
                evaluated = { ok: false, issues: ['response:not_json_or_not_schema'], reason: 'repair_failed' }
            }
            if (!evaluated.ok) {
                // The single repair covers structural AND semantic rejection of a completed answer; then whole fallback.
                if (evaluated.terminal === true) return failure(evaluated.reason)
                if (legacyGuide) return failure('invalid_output')
                repaired = true
                try {
                    evaluated = evaluate(context, await attempt(evaluated.issues), timed)
                } catch (error) {
                    if (isMalformed(error)) return failure('repair_failed')
                    throw error
                }
                if (!evaluated.ok) return failure(evaluated.reason)
            }
            const seen = observed()
            const document = assemble(
                context,
                evaluated.final,
                metadata(context, 'generated', {
                    ...seen,
                    origins: evaluated.final.origins,
                    ...groundingMeta(evaluated.tally),
                }),
            )
            if (document === null) return failure('invalid_output')
            return {
                document,
                cached: {
                    proposal: evaluated.proposal,
                    observed: { ...seen, generatedAt: document.metadata.generatedAt },
                },
            }
        }

        try {
            if (fixture !== null) return await run()
            return await work.run({ deadlineMs: workBudgetMs, signal }, run)
        } catch (error) {
            // A cancelled provider call reports a generic stop; the abort reason says why it was stopped.
            return failure(signal.reason instanceof StaleRevisionError ? 'stale' : reasonFor(error))
        }
    }

    async function generate(inputs: ScreenInputs, waiter?: AbortSignal, background = false): Promise<ScreenDocument> {
        const context = buildContext(inputs)
        if (mode === 'off' || (mode === 'steps' && context.kind !== 'guide')) {
            return deterministic(context, 'disabled')
        }
        if (provider === null && fixture === null) {
            return deterministic(context, options.runtimeMode === 'fixture' ? 'fixture' : 'unconfigured')
        }
        waiter?.throwIfAborted()
        const { manualId, revision } = context.bound
        if (manualId !== null && revision !== null && !guard.observe(manualId, revision)) {
            return deterministic(context, 'stale')
        }
        const key = cacheKey(context)
        const hit = cache.get(key)
        const served = hit === undefined ? null : fromCache(context, hit)
        if (served) return served
        return flights.run(
            flightKey(context),
            async (flightSignal) => {
                const controller = new AbortController()
                const link = (): void => controller.abort(flightSignal.reason)
                flightSignal.addEventListener('abort', link, { once: true })
                if (flightSignal.aborted) link()
                // Registered before waiting for capacity, so a newer revision cancels this work while it is queued.
                const unregister =
                    manualId !== null && revision !== null
                        ? guard.register(manualId, revision, controller)
                        : (): void => {}
                let release: (() => void) | null = null
                try {
                    release = background ? await work.acquire(controller.signal) : work.tryAcquire()
                    if (release === null) return deterministic(context, 'busy')
                    controller.signal.throwIfAborted()
                    const made = await generateWithModel(context, controller.signal)
                    if (made.cached) cache.set(key, made.cached)
                    return made.document
                } catch (error) {
                    return deterministic(
                        context,
                        controller.signal.reason instanceof StaleRevisionError ? 'stale' : reasonFor(error),
                    )
                } finally {
                    release?.()
                    unregister()
                    flightSignal.removeEventListener('abort', link)
                }
            },
            waiter,
        )
    }

    function stepInputs(session: ManualSession, stepId: string): ScreenInputs {
        return { kind: 'guide', session, stepId, captureId: null, result: null, failure: null }
    }

    return {
        mode,
        generate,
        fallback: (inputs, reason) => deterministic(buildContext(inputs), reason),
        observe: (manualId, revision) => guard.observe(manualId, revision),
        resolveStepScreen(session, stepId, screen): StepScreenContext | 'mismatch' | null {
            const context = buildContext(stepInputs(session, stepId))
            if (context.bound.contextKey !== screen.contextKey) return 'mismatch'
            const known = issued.get(screen.screenId)
            if (known === undefined) return null
            // The same kind, manual, revision, step and capture the page was issued for; nothing else can be paired.
            if (known.kind !== 'guide' || known.shown === null || !sameBound(known.bound, context.bound)) {
                return 'mismatch'
            }
            const { shown, facts } = resolveShown(known.shown, context)
            return {
                screenId: screen.screenId,
                contextKey: screen.contextKey,
                kind: 'guide',
                facts,
                ...(shown === undefined ? {} : { shown }),
            }
        },
        precompute(session, focusStepId): ScreenProgress {
            guard.observe(session.manualId, session.revision)
            // A fresh parse is prepared from its known raw facts; no build action is offered until it is reviewed.
            const steps =
                session.reviewStatus === 'reviewed' ? session.reviewedSteps : (session.rawExtraction?.steps ?? [])
            const contexts = steps.map((step) => buildContext(stepInputs(session, step.stepId)))
            const modeSteps = mode === 'off' ? [] : contexts
            return jobs.start(
                {
                    manualId: session.manualId,
                    revision: session.revision,
                    contextKey: sha256(canonicalJson(contexts.map((context) => context.bound.contextKey))),
                    mode,
                    steps: modeSteps.map((context) => ({
                        stepId: context.bound.stepId ?? '',
                        order: context.step?.order ?? 0,
                        key: flightKey(context),
                    })),
                    focusStepId,
                },
                async (stepId, signal) => {
                    const context = contexts.find((candidate) => candidate.bound.stepId === stepId)
                    if (!context) return { state: 'failed', screenId: null }
                    const document = await generate(stepInputs(session, stepId), signal, true)
                    finished.set(flightKey(context), document)
                    return {
                        state: document.metadata.source === 'generated' ? 'ready' : 'fallback',
                        screenId: document.screenId,
                    }
                },
            )
        },
        progress(manualId: string, revision: number, want: readonly string[]): ReturnType<ScreenService['progress']> {
            const progress = jobs.progress(manualId, revision)
            const documents = want.flatMap((stepId) => {
                const key = jobs.keyOf(manualId, revision, stepId)
                const document = key === null ? undefined : finished.get(key)
                return document ? [document] : []
            })
            return { progress, documents }
        },
        cancel(manualId: string, revision: number): ScreenProgress | null {
            jobs.cancel(manualId, revision, true)
            return jobs.progress(manualId, revision)
        },
    }
}
