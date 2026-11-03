import type { ManualStep } from './index'
import {
    DOCUMENT_V2_LIMITS,
    HELD_QUESTION_KEY_V2,
    INTENTS_BY_KIND_V2,
    OPERATION_NOTICE_KEY_V2,
    OVERVIEW_FACT_PREFIX_V2,
    READING_CANCELLATION_V2,
    STEP_KINDS_V2,
    UNRESOLVED_SAFETY_FACT_ID_V2,
    UNRESOLVED_SAFETY_TEXT_V2,
    isRequiredFactV2,
    sourceKeyV2,
    sourceResolverV2,
    type DocumentSourceV2,
    type FactV2,
    type HeaderV2,
    type RequirementsV2,
} from './document-v2'
import {
    baseKindV2,
    cameraAccessV2,
    captureWitnessV2,
    completionFigureV2,
    moreScopedV2,
    pendingCheckV2,
    resultOfKindV2,
    screenUiForKindV2,
    usableRefsOf,
    usedScopeV2,
    type ScreenContextInputsV2,
} from './document-v2-context'
import { completionWitnessed } from './screen-context'
import { isManualCheckFact, manualDirectionFacts, unresolvedSafetyNotes } from './screen-facts'
import { screenFacts } from './screen-context'
import type { AppIntent } from './screen'
import type { ScreenKindV2, ScreenUiStateV2, TextRefV2 } from './document-v2'

export type VerdictV2 = 'pass' | 'refuse' | 'cannot_verify'

/**
 * Everything a version 2 composition may state or point at, derived ONLY from the validated inputs: the manual facts of
 * the step with their own sources, the actual result, the bounded source table, the live parts, and the mandatory
 * witnesses. Pure and portable: the app, the server's fallback, its prompt and its validation all read this one value.
 */
export interface DocumentMaterialV2 {
    inputs: ScreenContextInputsV2
    /** Server-only compatibility mode; never added to the public document or request. */
    legacyDirections?: true
    step: ManualStep | null
    stepIndex: number
    stepCount: number
    /** True when the facts are the person's reviewed steps; a fresh parse never offers a build action. */
    reviewed: boolean
    /** True when the facts include the overview of a fully known manual (quick check only, see `overviewStepsOf`). */
    overview: boolean
    stepBound: boolean
    /**
     * Every fact the screen may state. A step-bound screen leads with the one `unresolved-safety` statement when the
     * step's extraction left a safety note unreadable, then the step's known safety notes and directions, then any
     * overview and result facts.
     */
    facts: FactV2[]
    sources: DocumentSourceV2[]
    /**
     * `region`: every distinct page-and-region reference has its own entry. `page`: there were too many distinct regions
     * (or too much citation load) to cite each one, so the table holds one whole-page entry per manual page and every
     * reference resolves to its page. Either way no mandatory reference is dropped.
     */
    sourcePrecision: 'region' | 'page'
    requirements: RequirementsV2
    decision: VerdictV2 | null
    /**
     * True when this is the held photo of a check that has not returned (`pendingCheckV2`): a result screen with the
     * actual capture, no result, no verdict and nothing to confirm.
     */
    pendingCheck: boolean
    completion: 'witnessed' | 'unwitnessed'
    /** Parts of the current step whose names are known (a tile resolves name and quantity from the session). */
    partIds: string[]
    /**
     * Ids a native piece node may name: a guide's step catalog (`stepPieces`, never the whole registry), otherwise the
     * supplied piece registry. Empty when none is known: a piece node is then refused (`piece_unavailable`).
     */
    pieceIds: string[]
    /** Indexes of the step's own diagram sources (empty when the step cites none). */
    diagram: number[]
}

/** One placement rule: saved titles are the single fallback direction; action manuals keep their title in the header. */
export function guideHeaderTextV2(material: DocumentMaterialV2): Pick<HeaderV2, 'title' | 'subtitle'> {
    if (material.step === null) return { title: { kind: 'literal', text: 'This step' }, subtitle: null }
    const savedTitle = !material.legacyDirections && material.facts.some((fact) => fact.factId === 'title')
    return {
        title: { kind: 'bound', key: 'step-position' },
        subtitle: savedTitle ? null : { kind: 'bound', key: 'step-title' },
    }
}

const intent = <I extends AppIntent['intent']>(
    name: I,
    target: Extract<AppIntent, { intent: I }>['target'],
): AppIntent => ({ intent: name, target }) as AppIntent

/** Most citation nodes (facts and chips) the exact-region table may ask of one variant; beyond it citations go page-level. */
const CITATION_LOAD_BUDGET = 600

/**
 * The complete source registry, computed BEFORE any limit applies: every reference of every published fact and of the
 * step diagram, deduplicated by page and region, mandatory references first. It is exact while the distinct references
 * fit the cap and a bounded citation load; otherwise it is the page-level table (one entry per manual page, at most
 * `LIMITS.manualPages`), which still cites every reference's page. Nothing is ever silently dropped.
 */

function sourceRegistry(
    diagram: readonly DocumentSourceV2[],
    published: readonly FactV2[],
): { sources: DocumentSourceV2[]; precision: 'region' | 'page' } {
    const required = published.filter(isRequiredFactV2)
    const optional = published.filter((fact) => !isRequiredFactV2(fact))
    const ordered: DocumentSourceV2[] = [
        ...diagram,
        ...required.flatMap((fact) => fact.sourceRefs),
        ...optional.flatMap((fact) => fact.sourceRefs),
    ]
    const seen = new Set<string>()
    const exact: DocumentSourceV2[] = []
    for (const ref of ordered) {
        const source: DocumentSourceV2 = { pageId: ref.pageId, region: ref.region }
        const key = sourceKeyV2(source)
        if (seen.has(key)) continue
        seen.add(key)
        exact.push(source)
    }
    if (exact.length <= DOCUMENT_V2_LIMITS.sources) {
        const resolve = sourceResolverV2(exact)
        const chips = (refs: readonly DocumentSourceV2[]): number =>
            Math.ceil(resolve(refs).length / DOCUMENT_V2_LIMITS.citationIndexes)
        const load =
            published
                .filter((fact) => fact.basis !== 'result')
                .reduce((sum, fact) => sum + 1 + chips(fact.sourceRefs), 0) +
            chips(required.flatMap((fact) => fact.sourceRefs))
        if (load <= CITATION_LOAD_BUDGET) return { sources: exact, precision: 'region' }
    }
    const pages = [...new Set(ordered.map((ref) => ref.pageId))]
    return { sources: pages.map((pageId) => ({ pageId, region: null })), precision: 'page' }
}

/** Whether this kind (with this camera mode) is bound to one step of a reviewed manual. */
export function isStepBoundV2(inputs: Pick<ScreenContextInputsV2, 'kind' | 'uiState' | 'stepId'>): boolean {
    if (inputs.kind === 'more') return moreScopedV2(inputs)
    return inputs.kind === 'camera' ? inputs.uiState?.camera?.mode === 'build-photo' : STEP_KINDS_V2.has(inputs.kind)
}

const uniqueIntents = (list: AppIntent[]): AppIntent[] =>
    list.filter(
        (candidate, at) =>
            list.findIndex((other) => other.intent === candidate.intent && other.target === candidate.target) === at,
    )

/** The way forward of a camera that cannot be used: ask for the permission, open the device settings, or retry. */
const CAMERA_WAY_FORWARD: Readonly<Record<ReturnType<typeof cameraAccessV2>, AppIntent[]>> = {
    ready: [],
    allow: [intent('confirm', 'camera-permission')],
    settings: [intent('open-details', 'device-settings')],
    retry: [intent('retry', 'camera')],
}

function requiredActions(inputs: ScreenContextInputsV2, reviewed: boolean, decision: VerdictV2 | null): AppIntent[] {
    const ui = inputs.uiState
    switch (inputs.kind) {
        case 'home':
            return [intent('navigate', 'add')]
        case 'add':
            return [intent('capture', 'take-photo')]
        case 'pages':
            return ui?.pages?.canRead ? [intent('confirm', 'reading')] : []
        case 'quick-check':
            return ui?.review?.canConfirm ? [intent('confirm', 'facts')] : []
        case 'guide':
            return [reviewed ? intent('capture', 'take-photo') : intent('navigate', 'quick-check')]
        case 'recovery':
            return [reviewed ? intent('retry', 'last-action') : intent('navigate', 'quick-check')]
        case 'camera':
            return CAMERA_WAY_FORWARD[cameraAccessV2(ui?.camera)]
        case 'result':
            // Before the check returns there is nothing to confirm or retake: the way out is back to the guide.
            return pendingCheckV2(inputs)
                ? [intent('navigate', 'guide')]
                : [decision === 'pass' ? intent('confirm', 'step') : intent('capture', 'retake')]
        case 'questions':
            return [intent('ask', 'about-step')]
        case 'answer':
            return [intent('navigate', 'guide')]
        case 'more':
        case 'judge':
        case 'compare':
            // Sheet-like screens always offer a way to close what is open.
            return [intent('navigate', 'back')]
        case 'completion':
            return [intent('navigate', 'home')]
        case 'error':
            return [intent('retry', 'last-action')]
        default:
            return []
    }
}

function requiredNodes(inputs: ScreenContextInputsV2): RequirementsV2['nodes'] {
    const ui = inputs.uiState
    const nodes: RequirementsV2['nodes'] = []
    switch (inputs.kind) {
        case 'camera':
            // The raw camera only where it can run: permission granted and the camera not failed.
            if (cameraAccessV2(ui?.camera) === 'ready') nodes.push('CameraView')
            break
        case 'result':
        case 'answer':
            // A check that has not returned has no verdict to place.
            if (!pendingCheckV2(inputs)) nodes.push('VerdictCard')
            break
        case 'judge':
            // The built-view flag is the one device-persistent setting: the panel and its toggle both belong here.
            nodes.push('JudgePanel', 'Toggle')
            break
        case 'compare':
            nodes.push('CompareColumns')
            break
        default:
            break
    }
    if (inputs.kind === 'home' && (ui?.library?.entries.length ?? 0) > 0) nodes.push('ManualList')
    if ((inputs.kind === 'pages' || inputs.kind === 'add') && (ui?.pages?.items.length ?? 0) > 0) nodes.push('PageList')
    if (inputs.kind === 'quick-check' && ui?.review?.currentQuestion) nodes.push('FactEditor')
    if (inputs.kind === 'questions' && ui?.capture) nodes.push('TextField')
    return nodes
}

/**
 * The reading cancellation witness: only a reading whose app confirms before it stops owns the two confirmation
 * intents (Stop = back to the pages after the runtime cancels, Keep = dismiss without touching the reading).
 */
export const READING_STOP_V2: AppIntent = { intent: 'navigate', target: 'pages' }
export const READING_KEEP_V2: AppIntent = { intent: 'navigate', target: 'reading' }
const readingConfirmation = (inputs: ScreenContextInputsV2): AppIntent[] =>
    inputs.kind === 'reading' && inputs.uiState?.reading?.cancellation === READING_CANCELLATION_V2
        ? [READING_STOP_V2, READING_KEEP_V2]
        : []

/** Kinds that can show a problem notice, and whether the app holds one (the witness is presence only). */
const NOTICE_KINDS_V2: ReadonlySet<ScreenKindV2> = new Set<ScreenKindV2>(['error', 'recovery', 'reading'])
export const operationNoticeHeld = (inputs: Pick<ScreenContextInputsV2, 'kind' | 'uiState'>): boolean =>
    (NOTICE_KINDS_V2.has(inputs.kind) && inputs.uiState?.failure?.notice === true) ||
    // The only other notice: the pages a cancelled reading returned to (the actual cancellation, never a problem).
    (inputs.kind === 'pages' && inputs.uiState?.cancelled?.reading === true)

/**
 * The step the quick check's current question is about, from the reviewed steps (or the raw extraction of a manual
 * that is not reviewed yet). Null for every other screen, without a question, or when the step is not in the manual.
 */
function questionStepOf(
    inputs: Pick<ScreenContextInputsV2, 'kind' | 'uiState'>,
    facts: ReturnType<typeof screenFacts>,
): ManualStep | null {
    if (inputs.kind !== 'quick-check' || facts === null) return null
    const question = inputs.uiState?.review?.currentQuestion
    return question ? (facts.steps.find((candidate) => candidate.stepId === question.stepId) ?? null) : null
}

/**
 * The steps a quick check states when there is nothing left to ask: the app holds a review state that can be confirmed
 * and has no current question, so every critical detail is known. Null in every other case (a question to ask, a
 * review that cannot be confirmed, no review state, no step read yet), where nothing about the manual is claimed.
 * Steps come from the same source as every other screen: the reviewed steps, or the known raw extraction.
 */
function overviewStepsOf(
    inputs: Pick<ScreenContextInputsV2, 'kind' | 'uiState'>,
    facts: ReturnType<typeof screenFacts>,
): readonly ManualStep[] | null {
    const review = inputs.uiState?.review
    if (inputs.kind !== 'quick-check' || facts === null || !review) return null
    if (review.currentQuestion || !review.canConfirm) return null
    return facts.steps.length > 0 ? facts.steps : null
}

/**
 * A result or answer screen holds the person's photo: its waiting variants show that photo, not the verdict. So does the
 * photo of a check that has not returned (it has no verdict to hold back yet, but it is the same photo-first screen), and
 * the question sheet over the photo the app holds (it has no result at all, yet the Answer that follows shows the same
 * photo). `inputs.captureId` is already the witnessed capture here (`usedInputs`), so a sheet with no witness owes none.
 */
const heldPhotoRequired = (inputs: ScreenContextInputsV2): boolean =>
    ((inputs.kind === 'result' || inputs.kind === 'answer' || moreScopedV2(inputs)) &&
        inputs.result !== null &&
        inputs.captureId !== null) ||
    pendingCheckV2(inputs) ||
    (inputs.kind === 'questions' && inputs.captureId !== null)

/**
 * The capture a document may show or name, or null. A live photo is part of a screen only when its identity is in the
 * context key: a held result carries the capture it was made from (`identity.captureId`), and a question screen carries
 * the held capture in the app state it uses. Anything else (a guide, a camera) has no photo whatever the caller sends,
 * so a cached document can never ask the renderer for "the" photo without naming which one it was composed for.
 */

/**
 * A document may only rely on the app state its kind actually uses, which is exactly the state the context key covers,
 * and on a capture that key names. Anything else the caller happened to send is dropped here, so a cached document never
 * depends on data a later request (with the same key) would not have.
 */
function usedInputs(raw: ScreenContextInputsV2): ScreenContextInputsV2 {
    const inputs = usedScopeV2(raw)
    return {
        ...inputs,
        captureId: captureWitnessV2(inputs),
        uiState: screenUiForKindV2(inputs.kind, inputs.uiState, {
            stepScoped: moreScopedV2(inputs),
        }) as ScreenUiStateV2 | null,
    }
}

export function documentMaterialV2(raw: ScreenContextInputsV2, legacyDirections = false): DocumentMaterialV2 {
    const inputs = usedInputs(raw)
    const { session, result } = inputs
    const facts = screenFacts(session)
    const stepBound = isStepBoundV2(inputs)
    const stepIndex = facts && inputs.stepId ? facts.steps.findIndex((step) => step.stepId === inputs.stepId) : -1
    const step = stepIndex >= 0 && facts ? (facts.steps[stepIndex] ?? null) : null
    const manual =
        session !== null && step !== null && stepBound
            ? manualDirectionFacts(session, step.stepId, legacyDirections || inputs.kind !== 'guide')
            : []
    const published: FactV2[] = manual.map((fact) => ({
        factId: fact.factId,
        kind: fact.kind,
        basis: !legacyDirections && inputs.kind === 'guide' && isManualCheckFact(fact) ? 'direction' : fact.basis,
        text: fact.text,
        sourceRefs: fact.sourceRefs.slice(0, 100).map((ref) => ({ pageId: ref.pageId, region: ref.region })),
    }))
    // A safety note the extraction could not read is not a known manual fact, so `manualDirectionFacts` never returns it,
    // yet the person must still learn that a printed warning exists. One fixed statement about the extraction (however
    // many notes were unreadable) leads the step's safety facts and qualifies the notes below it. It comes from the same
    // basis as every other fact of the step (the reviewed steps, else the raw extraction), is required in every variant
    // like a known safety note, and has no source and no reason of its own: there is no manual text to cite or to quote.
    if (session !== null && step !== null && stepBound && unresolvedSafetyNotes(session, step.stepId).length > 0) {
        published.unshift({
            factId: UNRESOLVED_SAFETY_FACT_ID_V2,
            kind: 'safety',
            basis: 'unresolved-safety',
            text: UNRESOLVED_SAFETY_TEXT_V2,
            sourceRefs: [],
        })
    }
    // A held check states `result:verdict` (+ `result:missing:N`); a held answer, alone or beside that check, states
    // `result:answer` (+ `result:answer-missing:N`): one namespace per result type, so each card states only its own.
    const refsOf = (value: {
        sourceRefs: readonly { pageId: string; region: DocumentSourceV2['region'] }[]
    }): DocumentSourceV2[] => value.sourceRefs.slice(0, 100).map((ref) => ({ pageId: ref.pageId, region: ref.region }))
    const publishResult = (held: NonNullable<typeof result>): void => {
        const refs = refsOf(held.value)
        published.push({
            factId: held.kind === 'check' ? 'result:verdict' : 'result:answer',
            kind: held.kind === 'check' ? 'verdict' : 'answer',
            basis: 'result',
            text: held.kind === 'check' ? held.value.reason : held.value.answer,
            sourceRefs: refs,
        })
        held.value.missingEvidence.forEach((entry, index) => {
            published.push({
                factId: `${held.kind === 'check' ? 'result:missing' : 'result:answer-missing'}:${index}`,
                kind: 'missing',
                basis: 'result',
                text: entry,
                sourceRefs: refs,
            })
        })
    }
    // The overview: each step's own title with the pages it cites (only pages this manual has), in manual order.
    const overviewSteps = overviewStepsOf(inputs, facts)
    for (const overviewStep of overviewSteps ?? []) {
        published.push({
            factId: `${OVERVIEW_FACT_PREFIX_V2}${overviewStep.stepId}`,
            kind: 'title',
            basis: 'overview',
            text: overviewStep.title,
            sourceRefs: usableRefsOf(overviewStep, session),
        })
    }
    if (result !== null) publishResult(result)
    const companion = result?.kind === 'check' ? resultOfKindV2(inputs, 'question') : null
    if (companion !== null) publishResult(companion)
    const required = published.filter(isRequiredFactV2)
    // The picture a screen shows is its step's own source. The quick check has no step of its own (it edits one question
    // at a time), so its picture is the question step's source: only references to pages this manual really has.
    // A step-scoped More shows its own step's picture the same way (exact source, or the honest absence).
    // The overview's picture is the first step that cites a page this manual has (never an invented or empty frame).
    const figureStep =
        moreScopedV2(inputs) && stepBound
            ? step
            : (questionStepOf(inputs, facts) ??
              overviewSteps?.find((candidate) => usableRefsOf(candidate, session).length > 0) ??
              null)
    // The finished build shows the manual's own picture (the only source its table holds): see `completionFigureV2`.
    const completionFigure = inputs.kind === 'completion' ? completionFigureV2(session) : null
    const diagramRefs =
        completionFigure !== null
            ? [completionFigure.ref]
            : figureStep === null
              ? (step?.sourceRefs ?? [])
              : figureStep.sourceRefs.filter((ref) => session?.pages.some((page) => page.pageId === ref.pageId))
    const registry = sourceRegistry(diagramRefs, published)
    const resolve = sourceResolverV2(registry.sources)
    const diagram = resolve(diagramRefs)
    const requiredSources = resolve(required.flatMap((fact) => fact.sourceRefs))

    const decision = result?.kind === 'check' ? result.value.decision : null
    const reviewed = facts?.reviewed ?? false
    const knownPart = (partId: string): boolean =>
        facts?.parts.some((candidate) => candidate.partId === partId && candidate.name.state === 'known') === true
    // The overview lists every known part of the manual (at most 256, the manual's own bound): never a silent subset.
    const partIds =
        overviewSteps === null
            ? (step?.parts ?? []).flatMap((part) => (knownPart(part.partId) ? [part.partId] : []))
            : [...new Set((facts?.parts ?? []).flatMap((part) => (knownPart(part.partId) ? [part.partId] : [])))]
    return {
        ...(legacyDirections ? { legacyDirections: true as const } : {}),
        inputs,
        step,
        stepIndex,
        stepCount: facts?.steps.length ?? 0,
        reviewed,
        overview: overviewSteps !== null,
        stepBound,
        facts: published,
        sources: registry.sources,
        sourcePrecision: registry.precision,
        requirements: {
            facts: required.map((fact) => fact.factId),
            sources: requiredSources,
            actions: uniqueIntents(requiredActions(inputs, reviewed, decision)),
            nodes: requiredNodes(inputs),
            confirm: readingConfirmation(inputs),
            capture: heldPhotoRequired(inputs),
            figure: figureStep === null && completionFigure === null ? null : (diagram[0] ?? null),
            notice: operationNoticeHeld(inputs),
            parts: overviewSteps === null ? [] : partIds,
        },
        decision,
        pendingCheck: pendingCheckV2(inputs),
        completion: completionWitnessed({
            kind: baseKindV2(inputs.kind),
            session,
            completedStepIds: inputs.completedStepIds,
        })
            ? 'witnessed'
            : 'unwitnessed',
        partIds: overviewSteps === null ? partIds.slice(0, 12) : partIds,
        pieceIds:
            inputs.kind === 'guide'
                ? (inputs.stepPieces ?? []).map((piece) => piece.pieceId)
                : (inputs.pieces ?? []).map((piece) => piece.id),
        diagram,
    }
}

/**
 * Whether an intent may appear in a document built from this material. Besides the per-kind table: a fresh parse
 * (unreviewed facts) never offers a build action, and every confirmation needs its own witness: a step is advanced past
 * only on a held `pass` (on every screen and variant), the manual facts only when the review can be confirmed, the
 * reading only when the pages can be read, and the manual only when its completion is witnessed.
 */
export function intentAllowedV2(candidate: AppIntent, material: DocumentMaterialV2): boolean {
    const { kind, uiState } = material.inputs
    if (!INTENTS_BY_KIND_V2[kind].includes(candidate.intent)) return false
    // The camera's own intents exist only on the camera screen and only with the witness that earns each one.
    const access = kind === 'camera' ? cameraAccessV2(uiState?.camera) : null
    if (candidate.intent === 'confirm' && candidate.target === 'camera-permission') return access === 'allow'
    if (candidate.intent === 'open-details' && candidate.target === 'device-settings') {
        return access === 'settings' || (kind === 'more' && uiState?.settings?.storage === true)
    }
    if (candidate.intent === 'retry' && candidate.target === 'camera') return access === 'retry'
    // A check that has not returned has nothing to confirm, retake, check again or ask about: only a way out or on.
    if (material.pendingCheck) {
        switch (candidate.intent) {
            case 'navigate':
                return ['guide', 'home', 'back', 'more'].includes(candidate.target)
            case 'retry':
                return candidate.target === 'last-action' || candidate.target === 'screen'
            case 'open-details':
                return candidate.target !== 'result'
            case 'show-tips':
                return true
            default:
                return false
        }
    }
    // Back closes or returns: home is the root and has nothing to return to.
    if (candidate.intent === 'navigate' && candidate.target === 'back') return kind !== 'home'
    // Tips have no preference to set, only the replay the More screen offers while the app has its tips section.
    if (candidate.intent === 'show-tips' && kind === 'more') return uiState?.sections?.includes('tips') === true
    // The shutter needs a camera that runs.
    if (candidate.intent === 'capture' && access !== null && access !== 'ready') return false
    // A More only asks, captures or confirms about a reviewed step it actually holds: the held photo for a retake, a
    // held check pass (never a refusal or an answer) for the next step. A global More has none of these.
    if (kind === 'more' && ['ask', 'capture', 'confirm'].includes(candidate.intent)) {
        if (!(material.stepBound && material.reviewed && material.step !== null)) return false
        if (candidate.intent === 'ask') return candidate.target === 'about-step'
        if (candidate.intent === 'capture') {
            return (
                candidate.target === 'take-photo' ||
                (candidate.target === 'retake' && material.inputs.captureId !== null)
            )
        }
        return candidate.target === 'step' && material.decision === 'pass'
    }
    // Keep (dismiss the cancellation) exists only on a reading that confirms before it stops.
    if (candidate.intent === 'navigate' && candidate.target === 'reading')
        return material.requirements.confirm.length > 0
    if (!material.reviewed && material.stepBound) {
        return (
            candidate.intent === 'navigate' || candidate.intent === 'open-details' || candidate.intent === 'show-tips'
        )
    }
    if (candidate.intent !== 'confirm') return true
    switch (candidate.target) {
        case 'step':
            return material.decision === 'pass'
        case 'facts':
            return uiState?.review?.canConfirm === true
        case 'reading':
            return uiState?.pages?.canRead === true
        case 'manual':
            return material.completion === 'witnessed'
        case 'camera-permission':
            return false
    }
}

type BoundKey = Extract<TextRefV2, { kind: 'bound' }>['key']

const PRIVACY_BY_KIND: Readonly<Partial<Record<string, readonly BoundKey[]>>> = {
    more: [
        'privacy-stay',
        'privacy-read',
        'privacy-check',
        'privacy-ask',
        'privacy-camera',
        'privacy-library',
        'privacy-once',
    ],
    add: ['privacy-stay', 'privacy-read'],
    pages: ['privacy-stay', 'privacy-read'],
    guide: ['privacy-check', 'privacy-ask'],
    result: ['privacy-check', 'privacy-ask'],
    answer: ['privacy-check', 'privacy-ask'],
    questions: ['privacy-check', 'privacy-ask'],
    recovery: ['privacy-check', 'privacy-ask'],
    camera: ['privacy-camera'],
}

/** The live-text keys this screen can actually resolve (a key outside the set is refused, never shown empty). */
export function availableBoundKeysV2(material: DocumentMaterialV2): BoundKey[] {
    const { inputs } = material
    const keys: BoundKey[] = []
    if (inputs.session !== null) keys.push('manual-title', 'steps-summary')
    if (material.step !== null) keys.push('step-position', 'step-title')
    if (inputs.uiState?.pages) keys.push('pages-summary')
    if (inputs.kind === 'completion') keys.push('completion-summary')
    if (inputs.uiState?.review?.currentQuestion?.reason) keys.push('review-reason')
    if (inputs.kind === 'quick-check' && inputs.uiState?.review?.currentQuestion) keys.push('review-position')
    if (operationNoticeHeld(inputs)) keys.push(OPERATION_NOTICE_KEY_V2)
    // The person's own question is quoted only where an answer to it is held (never from a draft, never as a fact).
    if (inputs.kind === 'more' && resultOfKindV2(inputs, 'question') !== null) keys.push(HELD_QUESTION_KEY_V2)
    keys.push(...(PRIVACY_BY_KIND[inputs.kind] ?? []))
    if (inputs.kind === 'more') {
        if (inputs.uiState?.settings) keys.push('storage-summary', 'storage-note')
        if (inputs.uiState?.sections?.includes('how-it-works'))
            keys.push('help-scan', 'help-look', 'help-next', 'help-ask')
    }
    return keys
}

const COACH_TARGETS_V2: Readonly<Partial<Record<ScreenKindV2, readonly string[]>>> = {
    home: ['home-add', 'keep-building', 'header-more'],
    add: ['take-page-photo', 'choose-pages'],
    pages: ['read-manual', 'add-page'],
    'quick-check': ['quick-check-fix', 'quick-check-skip', 'quick-check-clearer', 'quick-check-start'],
    guide: ['guide-hero', 'guide-primary'],
    camera: ['camera-shutter', 'guide-hero-frame'],
}

/** The existing coach targets a screen of this kind carries (the app drops a tip whose target is absent). */
export const coachTargetsV2 = (kind: ScreenKindV2): readonly string[] => (COACH_TARGETS_V2[kind] ?? []).slice(0, 4)

/**
 * The coach targets of THIS screen, in the order they are met. The tip of the control that is the bar's primary comes
 * first (Home leads with resuming a manual when there is one, otherwise with adding one), the camera's tips only exist
 * for a camera that is shown. The runtime keeps the order it is given.
 */
export const coachTargetsForV2 = (material: DocumentMaterialV2): readonly string[] => {
    const { inputs } = material
    if (inputs.kind === 'camera' && cameraAccessV2(inputs.uiState?.camera) !== 'ready') return []
    if (inputs.kind === 'home') {
        return (inputs.uiState?.library?.entries.length ?? 0) > 0
            ? ['keep-building', 'home-add', 'header-more']
            : ['home-add', 'header-more']
    }
    return coachTargetsV2(inputs.kind)
}
