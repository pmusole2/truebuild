import {
    SCREEN_CATALOG_V2_VERSION,
    assembleDocumentV2,
    isManualDirectionFact,
    canonicalJson,
    buildFallbackProposalV2,
    manualDirectionFacts,
    screenContentJsonV2,
    screenDocumentV2Schema,
    visitVariantNodesV2,
    nodeFactIdsV2,
    VARIANT_STATES,
    variantsOfV2,
    type DocumentMetadataV2,
    type FactV2,
    type FallbackReasonV2,
    type ManualSession,
    type ScreenBound,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import type { PrecomputeKindV2, ScreenProgressV2 } from '@truebuild/contracts/model'

import { DOCUMENT_PROMPT_VERSION } from '../../providers/document-prompt'
import {
    MetaProviderError,
    type CallTelemetry,
    type MetaProvider,
    type ScreenGeneration,
    type ScreenGenerationInput,
} from '../../providers/meta-provider'
import { BudgetError } from '../budget'
import { createDeadline, RequestStoppedError } from '../deadline'
import { withinModelDeadline } from '../model-multipart'
import { admission } from '../request-clock'
import { LEGACY_GUIDE_DEADLINE_MS, MAX_DEADLINE_MS, type AiPolicy, type GenerativeUiMode } from '../ai-policy'
import { PrecomputeRegistry, ScreenCache, SingleFlight, StaleGuard, StaleRevisionError } from '../screens/store'
import type { BackgroundWork, StepScreenContext } from '../screens/service'
import { buildDocumentContext, sha256, type DocumentContext } from './context'
import { evaluateProposal, evaluateWire, type Evaluation } from './ground'
import { normalizeDocumentWire } from './normalize-wire'
import { guideQualityIssues } from './guide-quality'
import { issueShownV2, resolveShownV2, type IssuedShownV2 } from './shown'

/** What a test-only synthetic generator is told about the document it is asked to compose. */
export interface DocumentFixtureRequest {
    kind: ScreenKindV2
    manualId: string | null
    revision: number | null
    stepId: string | null
    /** 1 for the first call, 2 for the single repair. */
    attempt: 1 | 2
    /** Everything a provider would be shown, with the grounded material the document must satisfy. */
    context: DocumentContext
}

/**
 * Explicit test/fixture composition source, wired only by `PROVIDER_MODE=fixture` or an injected test option, never as
 * a fallback for a live provider. It returns the raw flat wire value, which takes exactly the same decode, validation,
 * repair and fallback path as a provider response.
 */
export type DocumentFixtureGenerator = (request: DocumentFixtureRequest, signal: AbortSignal) => Promise<unknown>

export interface DocumentServiceOptions {
    provider: Pick<MetaProvider, 'generateDocument'> | null
    fixtureGenerator?: DocumentFixtureGenerator | null
    policy: AiPolicy
    runtimeMode: 'fixture' | 'meta'
    work: BackgroundWork
    cache?: ScreenCache<CachedDocument>
    /** Routes explicitly select legacy (1) when waitCopy=2 is absent; direct callers retain modern defaults. */
    waitCopy?: 1 | 2
    /** API routes set this from the query capability; in-process callers retain the existing repair behavior. */
    guideRepair?: boolean
    /** Preserve the previous facts/requirements for installed clients with strict local verification. */
    legacyDirections?: boolean
    precomputeConcurrency?: number
    now?: () => Date
}

export interface PrecomputeRequest {
    session: ManualSession
    focusKey: string | null
    uiState: ScreenUiStateV2 | null | undefined
    completedStepIds: readonly string[] | undefined
    /** A finite allowlist of the kinds to prepare; absent = the full set. The server's generative-UI mode still bounds it. */
    requestedKinds?: readonly PrecomputeKindV2[] | undefined
}

export interface DocumentService {
    generate(inputs: ScreenContextInputsV2, waiter?: AbortSignal): Promise<ScreenDocumentV2>
    /** Complete deterministic document for an already-known failure (for example a route timeout); never calls the model. */
    fallback(inputs: ScreenContextInputsV2, reason: FallbackReasonV2): ScreenDocumentV2
    precompute(request: PrecomputeRequest): ScreenProgressV2
    progress(
        manualId: string,
        revision: number,
        want: readonly string[],
        expectedContextKey?: string,
    ): { progress: ScreenProgressV2 | null; documents: ScreenDocumentV2[] }
    cancel(manualId: string, revision: number, expectedContextKey?: string): ScreenProgressV2 | null
    /** Exact selected job identity, recomputed from request inputs and the server mode. */
    jobContextKey(request: PrecomputeRequest): string
    /** Documents are only ever composed for the newest revision of a manual. */
    observe(manualId: string, revision: number): boolean
    /**
     * Resolves the guide or camera document a check, question or overlay names. `mismatch`: this server issued the id
     * for another identity, or the manual no longer states what the page showed. `null`: not an id this service issued.
     */
    resolveStepScreen(
        session: ManualSession,
        stepId: string,
        screen: { screenId: string; contextKey: string },
    ): StepScreenContext | 'mismatch' | null
    readonly mode: GenerativeUiMode
}

/** The accepted model output for one document content, with what was observed producing it. */
export interface CachedDocument {
    proposal: ScreenProposalV2
    observed: Pick<
        DocumentMetadataV2,
        'model' | 'effort' | 'repaired' | 'rejectedIssues' | 'timing' | 'usage' | 'generatedAt'
    >
}

interface IssuedDocument {
    contextKey: string
    kind: ScreenKindV2
    bound: ScreenBound
    facts: { id: string; kind: string; text: string }[]
    /** The page's composition (guide and camera pages only), re-verified against the manual when it is used. */
    shown: IssuedShownV2 | null
}

function reasonFor(error: unknown): FallbackReasonV2 {
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

/** Items a precompute prepares for one manual, in the order a person meets them. */
export function precomputeItems(request: PrecomputeRequest): {
    key: string
    kind: ScreenKindV2
    stepId: string | null
    order: number
    inputs: ScreenContextInputsV2
}[] {
    const { session, uiState } = request
    const reviewed = session.reviewStatus === 'reviewed'
    const steps = reviewed ? session.reviewedSteps : (session.rawExtraction?.steps ?? [])
    const common = { session, stepId: null, captureId: null, result: null, failure: null, uiState } as const
    const items: ReturnType<typeof precomputeItems> = [
        { key: 'reading', kind: 'reading', stepId: null, order: 0, inputs: { ...common, kind: 'reading' } },
        ...steps.map((step, index) => ({
            key: `guide:${step.stepId}`,
            kind: 'guide' as const,
            stepId: step.stepId,
            order: 1 + index,
            inputs: { ...common, kind: 'guide' as const, stepId: step.stepId },
        })),
    ]
    let order = steps.length + 1
    if (reviewed) {
        items.push({
            key: 'completion',
            kind: 'completion',
            stepId: null,
            order: order++,
            inputs: {
                ...common,
                kind: 'completion',
                ...(request.completedStepIds === undefined ? {} : { completedStepIds: request.completedStepIds }),
            },
        })
    }
    const sessionless = { ...common, session: null }
    if (uiState?.judge || uiState?.sections) {
        items.push({
            key: 'judge',
            kind: 'judge',
            stepId: null,
            order: order++,
            inputs: { ...sessionless, kind: 'judge' },
        })
    }
    if ((uiState?.library?.entries.length ?? 0) >= 2) {
        items.push({
            key: 'compare',
            kind: 'compare',
            stepId: null,
            order: order++,
            inputs: { ...sessionless, kind: 'compare' },
        })
    }
    if (uiState?.library) {
        items.push({
            key: 'home',
            kind: 'home',
            stepId: null,
            order,
            inputs: { ...sessionless, kind: 'home' },
        })
    }
    const wanted = request.requestedKinds
    return wanted === undefined ? items : items.filter((item) => (wanted as readonly string[]).includes(item.kind))
}

function parseKey(key: string): { kind: ScreenKindV2; stepId: string | null } {
    return key.startsWith('guide:')
        ? { kind: 'guide', stepId: key.slice('guide:'.length) }
        : { kind: key as ScreenKindV2, stepId: null }
}

export function createDocumentService(options: DocumentServiceOptions): DocumentService {
    const { provider, policy, work } = options
    const generateDocument = provider?.generateDocument
    const fixture = options.runtimeMode === 'fixture' && provider === null ? (options.fixtureGenerator ?? null) : null
    const now = options.now ?? ((): Date => new Date())
    const deps = { sha256Hex: sha256, now }
    const cache = options.cache ?? new ScreenCache<CachedDocument>()
    /** Every precomputed result, including deterministic fallbacks, so progress readers can fetch what a job made. */
    const finished = new ScreenCache<ScreenDocumentV2>(512)
    const flights = new SingleFlight<ScreenDocumentV2>()
    const guard = new StaleGuard()
    const jobs = new PrecomputeRegistry(options.precomputeConcurrency ?? 4)
    const mode = policy.generativeUi
    const issued = new ScreenCache<IssuedDocument>(1_024)
    const contextFor = (inputs: ScreenContextInputsV2): DocumentContext =>
        buildDocumentContext(inputs, options.legacyDirections === true)
    const evidence: DocumentMetadataV2['evidence'] = options.runtimeMode === 'fixture' ? 'synthetic-fixture' : 'live'

    const preparedItems = (request: PrecomputeRequest): ReturnType<typeof precomputeItems> =>
        (mode === 'off' ? [] : precomputeItems(request)).filter((item) => mode !== 'steps' || item.kind === 'guide')
    const jobContextKey = (request: PrecomputeRequest): string =>
        sha256(canonicalJson(preparedItems(request).map((item) => contextFor(item.inputs).bound.contextKey)))

    /** Model-output cache key: the grounded content plus the model/effort/prompt that produced it. */
    function cacheKey(context: DocumentContext): string {
        const stagePolicy = policy.stages[context.stage]
        // A Guide's model-authored READY composition does not change with shell activity. Cache only that content;
        // fromCache rechecks READY and rebuilds the exact activity's shell, bound identity and issued screen id.
        const contentKey =
            context.inputs.kind === 'guide'
                ? sha256(
                      screenContentJsonV2({
                          ...context.inputs,
                          uiState: { ...context.inputs.uiState, busy: null },
                      }),
                  )
                : context.contentKey
        return sha256(
            canonicalJson({
                contentKey,
                reviewed: context.material.reviewed,
                model: provider === null ? 'fixture' : stagePolicy.model,
                effort:
                    provider === null
                        ? 'fixture'
                        : context.inputs.kind === 'quick-check'
                          ? (stagePolicy.quickCheckEffort ?? stagePolicy.effort)
                          : stagePolicy.effort,
                prompt: DOCUMENT_PROMPT_VERSION,
                waitCopy: options.waitCopy ?? 2,
                legacyDirections: options.legacyDirections === true,
                catalog: SCREEN_CATALOG_V2_VERSION,
            }),
        )
    }
    /** One computation per exact identity (the cache key hashes content only, so identities must not share a flight). */
    const flightKey = (context: DocumentContext): string =>
        sha256(canonicalJson({ cache: cacheKey(context), bound: context.bound }))

    function publish(candidate: ScreenDocumentV2): ScreenDocumentV2 | null {
        const parsed = screenDocumentV2Schema.safeParse(candidate)
        if (!parsed.success) {
            console.info(
                JSON.stringify({
                    event: 'document_rejection',
                    contextKey: candidate.bound.contextKey,
                    kind: candidate.kind,
                    attempt: 'publication',
                    issueCodes: parsed.error.issues.map(
                        (issue) => `${issue.path.map(String).join('.') || 'root'}:${issue.code}`,
                    ),
                }),
            )
            return null
        }
        const document = parsed.data
        const stated = new Set<string>()
        for (const { name, prefix, variant } of variantsOfV2(document)) {
            if (name !== 'ready') continue
            visitVariantNodesV2(variant, prefix, (entry) => {
                for (const id of nodeFactIdsV2(entry.node)) stated.add(id)
            })
        }
        const byId = new Map(document.facts.map((fact): [string, FactV2] => [fact.factId, fact]))
        issued.set(document.screenId, {
            contextKey: document.bound.contextKey,
            kind: document.kind,
            bound: document.bound,
            facts: [...new Set([...stated, ...document.requirements.facts])].flatMap((id) => {
                const fact = byId.get(id)
                return fact === undefined || fact.basis === 'result' ? [] : [{ id, kind: fact.kind, text: fact.text }]
            }),
            shown: document.kind === 'guide' || document.kind === 'camera' ? issueShownV2(document) : null,
        })
        return document
    }

    /** The complete deterministic document of the same catalog; never calls the model. */
    function deterministic(
        context: DocumentContext,
        reason: FallbackReasonV2,
        extra: Partial<CachedDocument['observed']> = {},
        shellHome = false,
    ): ScreenDocumentV2 {
        const document = publish(
            assembleDocumentV2(
                context.material,
                buildFallbackProposalV2(context.material, reason, options.waitCopy === 1),
                {
                    ...extra,
                    source: 'fallback',
                    evidence,
                    fallbackReason: reason,
                    promptVersion: DOCUMENT_PROMPT_VERSION,
                    ...(shellHome ? { shellHome: true } : {}),
                },
                deps,
            ),
        )
        // The deterministic composition is validated by tests; if it ever failed, publish nothing rather than garbage.
        if (document === null) throw new Error('invalid_document_composition')
        return document
    }

    function generated(
        context: DocumentContext,
        proposal: ScreenProposalV2,
        observed: CachedDocument['observed'],
        cacheHit: boolean,
    ): ScreenDocumentV2 | null {
        return publish(
            assembleDocumentV2(
                context.material,
                options.waitCopy === 1
                    ? { ...proposal, states: buildFallbackProposalV2(context.material, undefined, true).states }
                    : proposal,
                {
                    ...observed,
                    source: 'generated',
                    // The model authored the ready screen only; every state it carries is the shell's template.
                    shellStates: VARIANT_STATES.filter((state) => proposal.states[state] !== null),
                    evidence,
                    fallbackReason: null,
                    cacheHit,
                    promptVersion: DOCUMENT_PROMPT_VERSION,
                },
                deps,
            ),
        )
    }

    /** Static validator codes only: never log the rejected model text, prompt or manual facts. */
    function logRejection(
        context: DocumentContext,
        attempt: 'cache' | 'initial' | 'repair',
        issues: readonly string[],
    ): void {
        console.info(
            JSON.stringify({
                event: 'document_rejection',
                contextKey: context.bound.contextKey,
                kind: context.inputs.kind,
                attempt,
                issueCodes: issues,
            }),
        )
    }

    /** Re-checks an accepted proposal against the requesting context; null if it no longer satisfies it. */
    function fromCache(context: DocumentContext, cached: CachedDocument): ScreenDocumentV2 | null {
        const checked = evaluateProposal(cached.proposal, context)
        if (!checked.ok) logRejection(context, 'cache', checked.issues)
        return checked.ok ? generated(context, checked.proposal, cached.observed, true) : null
    }

    interface Made {
        document: ScreenDocumentV2
        cached: CachedDocument | null
    }

    async function generateWithModel(context: DocumentContext, signal: AbortSignal): Promise<Made> {
        const stagePolicy = policy.stages[context.stage]
        const legacyGuide = context.inputs.kind === 'guide' && options.guideRepair === false
        const workBudgetMs = legacyGuide
            ? Math.min(LEGACY_GUIDE_DEADLINE_MS, stagePolicy.deadlineMs)
            : Math.min(MAX_DEADLINE_MS, stagePolicy.deadlineMs * 2 + 2_000)
        const workStarted = performance.now()
        if ((provider === null || !generateDocument) && fixture === null) {
            return { document: deterministic(context, 'unconfigured'), cached: null }
        }
        // The work gate may settle before a producer that ignores cancellation. Its remaining attempt must then stop
        // too, rather than continue into publication after the request already received a timeout fallback.
        const lifetime = new AbortController()
        const active = AbortSignal.any([signal, lifetime.signal])
        const started = admission.getStore()?.start ?? performance.now()
        const base: ScreenGenerationInput = {
            requestId: `document-${context.bound.contextKey.slice(0, 16)}`,
            stage: context.stage,
            stable: context.view.stable,
            dynamic: context.view.dynamic,
        }
        const telemetry: CallTelemetry[] = []
        let dispatched = 0
        let repaired = false
        let rejectedIssues: number | null = null
        let validationMs = 0
        const timed = <T>(fn: () => T): T => {
            const at = performance.now()
            try {
                return fn()
            } finally {
                validationMs += performance.now() - at
            }
        }
        const observed = (): CachedDocument['observed'] => {
            const generatedAt = now().toISOString()
            if (evidence === 'synthetic-fixture') {
                // A fixture/test runtime's document is a synthetic example whatever produced it (the generator, or a
                // scripted provider injected under the fixture runtime): no model, effort, timing or usage is claimed.
                return {
                    model: null,
                    effort: null,
                    repaired,
                    rejectedIssues,
                    generatedAt,
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
                rejectedIssues,
                generatedAt,
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
        const failure = (reason: FallbackReasonV2): Made => {
            const { generatedAt: _at, ...seen } = observed()
            // Home is the app's own root screen: after a failed composition the shell's Home carries no model claim.
            const honest = context.inputs.kind === 'home' ? { ...seen, model: null, effort: null } : seen
            return { document: deterministic(context, reason, honest, context.inputs.kind === 'home'), cached: null }
        }

        /**
         * One call of the model (or of the synthetic generator). A rejected call reports what it observed. Stopping a
         * call is a request, not a guarantee: an answer that arrives once the work was stopped (every request gone, or
         * the revision superseded) is dropped here, so nothing of it is repaired, published or cached.
         */
        const attempt = async (repairIssues?: readonly string[]): Promise<unknown> => {
            // A Guide's primary and optional repair share the existing work ceiling. A slow completed primary may
            // use more than one old 45s slice; a repair can use only what remains, never a fresh full budget.
            const attemptMs =
                context.inputs.kind === 'guide' && fixture === null
                    ? workBudgetMs - (performance.now() - workStarted)
                    : legacyGuide
                      ? workBudgetMs
                      : stagePolicy.deadlineMs
            if (attemptMs <= 0) throw new RequestStoppedError('timeout')
            dispatched += 1
            const deadline = createDeadline(attemptMs, active)
            const callAbort = new AbortController()
            const stop = (): void => callAbort.abort(deadline.signal.reason)
            deadline.signal.addEventListener('abort', stop, { once: true })
            try {
                deadline.checkpoint()
                if (fixture !== null) {
                    const answer = await withinModelDeadline(
                        fixture(
                            {
                                kind: context.inputs.kind,
                                manualId: context.bound.manualId,
                                revision: context.bound.revision,
                                stepId: context.bound.stepId,
                                attempt: repairIssues === undefined ? 1 : 2,
                                context,
                            },
                            callAbort.signal,
                        ),
                        deadline,
                    )
                    deadline.checkpoint()
                    return answer
                }
                const call = (): Promise<ScreenGeneration> =>
                    generateDocument!.call(
                        provider,
                        repairIssues === undefined ? base : { ...base, repairIssues },
                        callAbort.signal,
                        context.inputs.kind === 'guide' ? attemptMs : undefined,
                    )
                const generation = await withinModelDeadline(
                    repairIssues === undefined ? call() : work.repair(call),
                    deadline,
                ).catch((error: unknown) => {
                    // A call that answered but was unusable still spent time and tokens; report them honestly.
                    if (error instanceof MetaProviderError && error.telemetry) telemetry.push(error.telemetry)
                    throw error
                })
                telemetry.push(generation.telemetry)
                deadline.checkpoint()
                return generation.value
            } finally {
                // A completed producer keeps a successful signal; disposal must not send it a new cancellation.
                deadline.signal.removeEventListener('abort', stop)
                deadline.dispose()
            }
        }
        const isMalformed = (error: unknown): boolean =>
            error instanceof MetaProviderError && error.code === 'invalid_output' && error.detail === 'malformed'

        const evaluateResponse = (value: unknown, attempt: 'initial' | 'repair'): Evaluation => {
            // Normalize only provider-authored wire documents; synthetic fixture generators retain their strict oracle.
            const normalized =
                policy.documentNormalization && fixture === null
                    ? normalizeDocumentWire(value, context)
                    : { value, issueCodes: [] }
            const perEvent = 24
            for (let offset = 0; offset < normalized.issueCodes.length; offset += perEvent) {
                console.info(
                    JSON.stringify({
                        event: 'document_normalization',
                        contextKey: context.bound.contextKey,
                        kind: context.inputs.kind,
                        attempt,
                        droppedCount: normalized.issueCodes.length,
                        chunk: offset / perEvent,
                        issueCodes: normalized.issueCodes.slice(offset, offset + perEvent),
                    }),
                )
            }
            const evaluated = evaluateWire(normalized.value, context)
            if (!evaluated.ok) return evaluated
            // A completed Guide without usable directions gets the same single bounded repair as a bad graph.
            // The floor is unchanged; apply it to the repair too, before anything can be published or cached.
            const quality = guideQualityIssues(evaluated.proposal, context)
            return quality.length === 0 ? evaluated : { ok: false, issues: quality }
        }

        const run = async (): Promise<Made> => {
            let evaluated: Evaluation
            try {
                const value = await attempt()
                evaluated = timed(() => evaluateResponse(value, 'initial'))
            } catch (error) {
                // Only a completed-but-unusable answer may be repaired; incomplete, timeout and ambiguous dispatch never.
                if (!isMalformed(error)) throw error
                evaluated = { ok: false, issues: ['response:not_json_or_not_schema'] }
            }
            if (!evaluated.ok) {
                // The single repair covers structural AND semantic rejection of a completed answer; then whole fallback.
                logRejection(context, 'initial', evaluated.issues)
                rejectedIssues = evaluated.issues.length
                // Result already shows the app's verdict/photo shell; rejected background composition never delays it.
                if (context.inputs.kind === 'result' || legacyGuide) return failure('invalid_output')
                repaired = true
                try {
                    const value = await attempt(evaluated.issues)
                    evaluated = timed(() => evaluateResponse(value, 'repair'))
                } catch (error) {
                    if (isMalformed(error)) {
                        logRejection(context, 'repair', ['response:not_json_or_not_schema'])
                        return failure('repair_failed')
                    }
                    throw error
                }
                if (!evaluated.ok) {
                    logRejection(context, 'repair', evaluated.issues)
                    return failure('repair_failed')
                }
            }
            const seen = observed()
            const document = generated(context, evaluated.proposal, seen, false)
            if (document === null) return failure('invalid_output')
            return { document, cached: { proposal: evaluated.proposal, observed: seen } }
        }

        try {
            if (fixture !== null) return await run()
            return await work.run({ deadlineMs: workBudgetMs, signal: active }, run)
        } catch (error) {
            // A cancelled provider call reports a generic stop; the abort reason says why it was stopped.
            return failure(signal.reason instanceof StaleRevisionError ? 'stale' : reasonFor(error))
        } finally {
            lifetime.abort(new RequestStoppedError('cancelled'))
        }
    }

    async function generate(
        inputs: ScreenContextInputsV2,
        waiter?: AbortSignal,
        background = false,
    ): Promise<ScreenDocumentV2> {
        const context = contextFor(inputs)
        if (mode === 'off' || (mode === 'steps' && context.inputs.kind !== 'guide')) {
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
        if (
            context.inputs.kind === 'guide' &&
            !context.material.facts.some((fact) =>
                context.material.legacyDirections
                    ? fact.kind !== 'safety' &&
                      fact.kind !== 'title' &&
                      (fact.basis === 'direction' || fact.basis === 'unclassified-step')
                    : isManualDirectionFact(fact),
            )
        ) {
            // No authored Guide can meet its instruction floor without inventing a direction: skip the paid call.
            return deterministic(context, 'missing_requirement')
        }
        const key = cacheKey(context)
        const hit = cache.get(key)
        const served = hit === undefined ? null : fromCache(context, hit)
        if (served) return served
        return flights.run(
            flightKey(context),
            async (flightSignal) => {
                const controller = new AbortController()
                let release: (() => void) | null = null
                const returnCapacity = (): void => {
                    const held = release
                    release = null
                    held?.()
                }
                // A new intentional request may arrive before this cancelled flight's async finally runs.
                controller.signal.addEventListener('abort', returnCapacity, { once: true })
                const link = (): void => controller.abort(flightSignal.reason)
                flightSignal.addEventListener('abort', link, { once: true })
                if (flightSignal.aborted) link()
                // Registered before waiting for capacity, so a newer revision cancels this work while it is queued.
                const unregister =
                    manualId !== null && revision !== null
                        ? guard.register(manualId, revision, controller)
                        : (): void => {}
                try {
                    release = background ? await work.acquire(controller.signal) : work.tryAcquire()
                    if (release === null) return deterministic(context, 'busy')
                    controller.signal.throwIfAborted()
                    const made = await generateWithModel(context, controller.signal)
                    // Work that was stopped while it finished is not kept, however it ended.
                    if (made.cached && !controller.signal.aborted) cache.set(key, made.cached)
                    return made.document
                } catch (error) {
                    return deterministic(
                        context,
                        controller.signal.reason instanceof StaleRevisionError ? 'stale' : reasonFor(error),
                    )
                } finally {
                    returnCapacity()
                    unregister()
                    flightSignal.removeEventListener('abort', link)
                    controller.signal.removeEventListener('abort', returnCapacity)
                }
            },
            waiter,
        )
    }

    const toProgress = (progress: ReturnType<PrecomputeRegistry['progress']>): ScreenProgressV2 | null =>
        progress === null
            ? null
            : {
                  manualId: progress.manualId,
                  revision: progress.revision,
                  contextKey: progress.contextKey,
                  mode: progress.mode,
                  items: progress.steps.map((step) => ({
                      key: step.stepId,
                      ...parseKey(step.stepId),
                      state: step.state,
                      screenId: step.screenId,
                  })),
              }

    return {
        mode,
        generate,
        jobContextKey,
        fallback: (inputs, reason) => deterministic(contextFor(inputs), reason),
        observe: (manualId, revision) => guard.observe(manualId, revision),
        resolveStepScreen(session, stepId, screen): StepScreenContext | 'mismatch' | null {
            const known = issued.get(screen.screenId)
            if (known === undefined) return null
            if (
                known.contextKey !== screen.contextKey ||
                (known.kind !== 'guide' && known.kind !== 'camera') ||
                known.bound.manualId !== session.manualId ||
                known.bound.revision !== session.revision ||
                known.bound.stepId !== stepId
            ) {
                return 'mismatch'
            }
            // Re-verified against THIS request's manual: a fact is reported only if the manual still states it so.
            const legacyFacts = options.legacyDirections === true || known.kind !== 'guide'
            const current = new Map(
                manualDirectionFacts(session, stepId, legacyFacts).map((fact) => [fact.factId, fact.text]),
            )
            const shown = known.shown === null ? undefined : resolveShownV2(known.shown, session, stepId, legacyFacts)
            return {
                screenId: screen.screenId,
                contextKey: screen.contextKey,
                kind: 'guide',
                facts: known.facts.filter((fact) => current.get(fact.id) === fact.text),
                ...(shown === undefined ? {} : { shown }),
            }
        },
        precompute(request): ScreenProgressV2 {
            const { session } = request
            guard.observe(session.manualId, session.revision)
            // What is prepared is what was asked for, bounded by the mode: `off` prepares nothing and `steps` only guides.
            const prepared = preparedItems(request).map((item) => ({
                ...item,
                context: contextFor(item.inputs),
            }))
            const progress = jobs.start(
                {
                    manualId: session.manualId,
                    revision: session.revision,
                    contextKey: jobContextKey(request),
                    mode,
                    steps: prepared.map((item) => ({
                        stepId: item.key,
                        order: item.order,
                        key: flightKey(item.context),
                    })),
                    focusStepId: request.focusKey,
                },
                async (key, signal) => {
                    const item = prepared.find((candidate) => candidate.key === key)
                    if (!item) return { state: 'failed', screenId: null }
                    const document = await generate(item.inputs, signal, true)
                    finished.set(flightKey(item.context), document)
                    return {
                        state: document.metadata.source === 'generated' ? 'ready' : 'fallback',
                        screenId: document.screenId,
                    }
                },
            )
            return toProgress(progress)!
        },
        progress(manualId, revision, want, expectedContextKey): ReturnType<DocumentService['progress']> {
            const current = jobs.progress(manualId, revision)
            if (expectedContextKey !== undefined && current?.contextKey !== expectedContextKey) {
                return { progress: null, documents: [] }
            }
            const documents = want.flatMap((key) => {
                const flight = jobs.keyOf(manualId, revision, key)
                const document = flight === null ? undefined : finished.get(flight)
                return document ? [document] : []
            })
            return { progress: toProgress(jobs.progress(manualId, revision)), documents }
        },
        cancel(manualId, revision, expectedContextKey): ScreenProgressV2 | null {
            if (
                expectedContextKey !== undefined &&
                jobs.progress(manualId, revision)?.contextKey !== expectedContextKey
            )
                return null
            jobs.cancel(manualId, revision, true)
            return toProgress(jobs.progress(manualId, revision))
        },
    }
}
