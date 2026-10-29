import { createHash } from 'node:crypto'

import {
    canonicalJson,
    completionWitnessed,
    isPlainScreenText,
    manualDirectionFacts,
    screenContentJson,
    screenContextJson,
    screenContextParts,
    screenFacts,
    screenUiForKind,
    type Fact,
    type ManualFact,
    type ManualSession,
    type ManualStep,
    type NormalizedBox,
    type PartRegion,
    type ScreenBound,
    type ScreenContextInputs,
    type ScreenKind,
    type ScreenUiState,
    type SourceRef,
} from '@truebuild/contracts'

import { clauses, normalize, sentencesOf } from './text'

/** The inputs a screen is composed from: exactly the shared contracts type the app builds its request from. */
export type ScreenInputs = ScreenContextInputs

export { canonicalJson }

/** Screens bound to one step of a manual: they carry the step's mandatory manual facts. */
export const STEP_KINDS: ReadonlySet<ScreenKind> = new Set(['guide', 'result', 'questions', 'answer', 'recovery'])

export type Decision = 'pass' | 'refuse' | 'cannot_verify'

export type WitnessKind =
    | 'title'
    | 'orientation'
    | 'connection'
    | 'check'
    | 'alternative'
    | 'correction'
    | 'part'
    | 'safety'
    | 'manual'
    | 'verdict'
    | 'answer'
    | 'missing'

/**
 * A complete unit of validated evidence a screen may state as fact: the exact text of a manual fact (or one complete
 * sentence of it) or of the actual validated result, together with the source references that actually support it.
 * Everything a screen says about the manual or the result must resolve to one of these; nothing is matched loosely.
 */
export interface Witness {
    id: string
    kind: WitnessKind
    /** Plain display text, complete (never clipped). */
    text: string
    /** Indexes into `GroundingContext.sources` of the references that support this unit (the fact's own). */
    refs: readonly number[]
    /** Id of the complete fact when this is one sentence of it. */
    whole: string | null
    /** Advisory only (decides a warning's tone); never what must be shown. See `GroundingContext.manualFacts`. */
    critical: boolean
    /**
     * False when a source of the fact did not fit the bounded source table. Such a unit can never be restated by a
     * composed block (its citations would be incomplete); the mandatory fact payload carries every source regardless.
     */
    complete: boolean
}

/** Everything a screen may state as fact. Built only from validated, known manual and result values. */
export interface GroundingContext extends ScreenInputs {
    step: ManualStep | null
    stepIndex: number
    stepCount: number
    /**
     * True when the facts are the person's reviewed steps. An unreviewed session (a fresh parse) is composed from the
     * known raw extraction facts so screens can be prepared early, but then no build action is ever offered.
     */
    reviewed: boolean
    partNames: ReadonlyMap<string, string>
    quantities: ReadonlyMap<string, number>
    stepPartIds: ReadonlySet<string>
    citedPageIds: ReadonlySet<string>
    /** Unique source references of the step, its facts and the result; citations index this table. */
    sources: readonly SourceRef[]
    witnesses: readonly Witness[]
    /** Normalized complete text to the units that state exactly it. */
    units: ReadonlyMap<string, readonly Witness[]>
    /**
     * Every known safety note and direction of the step (step screens only), complete with its own actual sources,
     * required ones first-class: see `requiredManualFacts`. This, not wording, decides what must be visible.
     */
    manualFacts: readonly ManualFact[]
    /** Live app state the kind uses (library, pages, review question, held capture, sections). */
    ui: ScreenUiState | null
    /** Completion wording is factual only when the app supplied saved progress covering every reviewed step. */
    completion: 'witnessed' | 'unwitnessed'
    decision: Decision | null
    regions: { next: PartRegion | null; target: PartRegion | null; observed: NormalizedBox | null }
    bound: ScreenBound
    /**
     * Hash of the content a composition is grounded in (everything in `bound.contextKey` except manual identity and
     * review state), so a proposal can be re-grounded for a later revision of identical facts without a new model call.
     */
    contentKey: string
    /** Exactly what the provider is shown; `bound.contextKey` hashes it, so a changed input is a changed key. */
    view: { stable: Record<string, unknown>; dynamic: Record<string, unknown> }
}

export function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

/** Advisory tone only: a warning block that states one of these is shown as critical. Never decides what is shown. */
const CRITICAL =
    /\b(danger|never|do not|don't|electric(?:al)?|shock|injur(?:y|ies)|tip(?:s|ped)? over|topple|crush)\b/iu

/** Replaces anything the plain-text rule rejects and clamps to a code-point length; never returns an empty string. */
export function plain(text: string, max = Number.POSITIVE_INFINITY, fallback = '—'): string {
    const cleaned = Array.from(text)
        .map((character) => ((character.codePointAt(0) ?? 0) < 0x20 ? ' ' : character))
        .join('')
        .replace(/\S*(?:\/\/|www\.|(?:https?|ftp|file|data|javascript|mailto):)\S*/giu, '')
        // A numeric comparison ("< 5 kg", ">= 2 mm") is plain text and changes a fact if removed (see isPlainScreenText).
        // Any other angle bracket opens or closes markup and is dropped, as is every backtick.
        .replace(/`/gu, '')
        .replace(/[<>](?!\s*=?\s*[+-]?\d)/gu, '')
        .replace(/\]\(/gu, '] (')
        .replace(/\s+/gu, ' ')
        .trim()
    const characters = Array.from(cleaned)
    const clipped =
        characters.length > max
            ? `${characters
                  .slice(0, max - 1)
                  .join('')
                  .trimEnd()}…`
            : cleaned
    return clipped !== '' && isPlainScreenText(clipped) ? clipped : fallback
}

type Facts = NonNullable<ReturnType<typeof screenFacts>>
const factsOf = screenFacts

function knownName(facts: Facts, partId: string): { value: string; sourceRefs: SourceRef[] } | undefined {
    const part = facts.parts.find((candidate) => candidate.partId === partId)
    return part?.name.state === 'known' ? { value: part.name.value, sourceRefs: part.name.sourceRefs } : undefined
}

function known<T>(fact: Fact<T>): { value: T; sourceRefs: SourceRef[] } | undefined {
    return fact.state === 'known' ? { value: fact.value, sourceRefs: fact.sourceRefs } : undefined
}

class SourceTable {
    readonly refs: SourceRef[] = []
    readonly #index = new Map<string, number>()

    constructor(readonly limit = 64) {}

    add(ref: SourceRef): number | null {
        const key = `${ref.pageId}|${canonicalJson(ref.region)}`
        const existing = this.#index.get(key)
        if (existing !== undefined) return existing
        if (this.refs.length >= this.limit) return null
        this.#index.set(key, this.refs.length)
        this.refs.push({ pageId: ref.pageId, region: ref.region })
        return this.refs.length - 1
    }

    /** Indexes of the references, and whether every one of them fit the bounded table (never silently partial). */
    all(refs: readonly SourceRef[]): { indexes: number[]; complete: boolean } {
        const indexes = refs.map((ref) => this.add(ref))
        return {
            indexes: [...new Set(indexes.flatMap((index) => index ?? []))],
            complete: indexes.every((index) => index !== null),
        }
    }
}

interface Fragment {
    id: string
    kind: WitnessKind
    text: string
    refs: readonly SourceRef[]
}

/** The known textual facts of a step with the sources that support each, in manual order. */
function stepFragments(facts: Facts, step: ManualStep, partIds: ReadonlySet<string>): Fragment[] {
    const out: Fragment[] = []
    const orientation = known(step.orientation)
    const connection = known(step.connection)
    const factRefs = [
        ...(orientation?.sourceRefs ?? []),
        ...(connection?.sourceRefs ?? []),
        ...step.visibleChecks.flatMap((check) => known(check.description)?.sourceRefs ?? []),
    ]
    out.push({
        id: 'title',
        kind: 'title',
        text: step.title,
        refs: step.sourceRefs.length > 0 ? step.sourceRefs : factRefs,
    })
    if (orientation) {
        out.push({
            id: 'orientation',
            kind: 'orientation',
            text: orientation.value.description,
            refs: orientation.sourceRefs,
        })
    }
    if (connection) {
        out.push({
            id: 'connection',
            kind: 'connection',
            text: connection.value.description,
            refs: connection.sourceRefs,
        })
    }
    for (const check of step.visibleChecks) {
        const description = known(check.description)
        if (description) {
            out.push({
                id: `check:${check.checkId}`,
                kind: 'check',
                text: description.value,
                refs: description.sourceRefs,
            })
        }
    }
    for (const entry of step.safetyNotes ?? []) {
        const note = known(entry.note)
        if (note) {
            out.push({ id: `safety:${entry.noteId}`, kind: 'safety', text: note.value, refs: note.sourceRefs })
        }
    }
    for (const alternative of step.alternatives ?? []) {
        out.push({
            id: `alt:${alternative.alternativeId}`,
            kind: 'alternative',
            text: alternative.description,
            refs: alternative.sourceRefs,
        })
        out.push({
            id: `alt:${alternative.alternativeId}:titled`,
            kind: 'alternative',
            text: `${alternative.title}. ${alternative.description}`,
            refs: alternative.sourceRefs,
        })
    }
    if (step.correction?.reviewed === true) {
        for (const action of step.correction.actions) {
            out.push({
                id: `fix:${action.actionId}`,
                kind: 'correction',
                text: action.instruction,
                refs: action.sourceRefs,
            })
        }
    }
    for (const partId of partIds) {
        const name = knownName(facts, partId)
        if (name) out.push({ id: `part:${partId}`, kind: 'part', text: name.value, refs: name.sourceRefs })
    }
    return out
}

/**
 * Builds the grounding context for a validated request. All values come from the supplied ManualSession and the
 * current result; nothing here is model output. `contextKey` hashes exactly what the provider is shown plus every
 * identity the grounding uses (pages, facts with their sources, result, completion witness).
 */
export function buildContext(inputs: ScreenInputs): GroundingContext {
    const { session, stepId, result } = inputs
    const facts = factsOf(session)
    const stepIndex = facts && stepId ? facts.steps.findIndex((step) => step.stepId === stepId) : -1
    const step = stepIndex >= 0 && facts ? (facts.steps[stepIndex] ?? null) : null
    const partNames = new Map<string, string>()
    const quantities = new Map<string, number>()
    const stepPartIds = new Set<string>()
    if (facts && step) {
        const involved = new Set<string>([
            ...step.parts.map((part) => part.partId),
            ...(step.orientation.state === 'known' ? [step.orientation.value.partId] : []),
            ...(step.connection.state === 'known' ? step.connection.value.partIds : []),
        ])
        for (const partId of involved) {
            stepPartIds.add(partId)
            const name = knownName(facts, partId)
            if (name !== undefined) partNames.set(partId, name.value)
        }
        for (const part of step.parts) {
            if (part.quantity.state === 'known') quantities.set(part.partId, part.quantity.value)
        }
    }

    const table = new SourceTable()
    for (const ref of step?.sourceRefs ?? []) table.add(ref)
    const witnesses: Witness[] = []
    // A unit is restatable only if its sources all fit the table and the plain-text rule did not alter its words.
    const addUnit = (
        unit: Omit<Witness, 'refs' | 'complete'> & { refs: readonly SourceRef[]; lossless?: boolean },
    ): void => {
        const { lossless = true, ...rest } = unit
        const { indexes, complete } = table.all(unit.refs)
        witnesses.push({ ...rest, refs: indexes, complete: complete && lossless })
    }

    if (session) {
        addUnit({
            id: 'manual:title',
            kind: 'manual',
            text: plain(session.title),
            refs: [],
            whole: null,
            critical: false,
        })
    }
    const fragments = facts && step ? stepFragments(facts, step, stepPartIds) : []
    for (const fragment of fragments) {
        const whole = plain(fragment.text)
        // Stripping markup characters can delete a meaningful operator (for example a comparison): such a text is
        // never restated by a composed block; the mandatory fact payload shows the manual's own words instead.
        const lossless = whole === fragment.text.replace(/\s+/gu, ' ').trim()
        addUnit({
            id: fragment.id,
            kind: fragment.kind,
            text: whole,
            refs: fragment.refs,
            whole: null,
            critical: clauses(whole).some((part) => CRITICAL.test(part)),
            lossless,
        })
        if (sentencesOf(whole).length > 1) {
            for (const [index, sentence] of sentencesOf(whole).entries()) {
                addUnit({
                    id: `${fragment.id}#${index}`,
                    kind: fragment.kind,
                    text: sentence,
                    refs: fragment.refs,
                    whole: fragment.id,
                    critical: CRITICAL.test(sentence),
                    lossless,
                })
            }
        }
    }

    // Quick check has no current step: what was read is confirmed step by step, so each step title is a unit.
    if (inputs.kind === 'quick-check' && facts) {
        for (const read of facts.steps) {
            addUnit({
                id: `title:${read.stepId}`,
                kind: 'title',
                text: plain(read.title),
                refs:
                    read.sourceRefs.length > 0
                        ? read.sourceRefs
                        : [
                              ...(known(read.orientation)?.sourceRefs ?? []),
                              ...(known(read.connection)?.sourceRefs ?? []),
                              ...read.visibleChecks.flatMap((check) => known(check.description)?.sourceRefs ?? []),
                          ],
                whole: null,
                critical: false,
            })
        }
    }

    // Actual validated result units (the result's own reason/answer and missing evidence).
    if (result) {
        const main = result.kind === 'check' ? result.value.reason : result.value.answer
        const mainKind: WitnessKind = result.kind === 'check' ? 'verdict' : 'answer'
        // A validated result is an authoritative witness. Sanitizing it could erase a comparison or negation.
        // Unsupported markup instead makes composition fail validation and use the native fallback.
        const mainText = main
        addUnit({
            id: mainKind,
            kind: mainKind,
            text: mainText,
            refs: result.value.sourceRefs,
            whole: null,
            critical: false,
        })
        if (sentencesOf(mainText).length > 1) {
            for (const [index, sentence] of sentencesOf(mainText).entries()) {
                addUnit({
                    id: `${mainKind}#${index}`,
                    kind: mainKind,
                    text: sentence,
                    refs: result.value.sourceRefs,
                    whole: mainKind,
                    critical: false,
                })
            }
        }
        for (const [index, entry] of result.value.missingEvidence.entries()) {
            addUnit({
                id: `missing:${index}`,
                kind: 'missing',
                text: entry,
                refs: result.value.sourceRefs,
                whole: null,
                critical: false,
            })
        }
    }

    const units = new Map<string, Witness[]>()
    for (const witness of witnesses) {
        const key = normalize(witness.text)
        units.set(key, [...(units.get(key) ?? []), witness])
    }

    const regions =
        result?.kind === 'check' || result?.kind === 'question'
            ? {
                  next: result.value.nextPartRegion ?? null,
                  target: result.value.targetRegion ?? null,
                  observed: result.value.observedRegion ?? null,
              }
            : { next: null, target: null, observed: null }
    const decision = result?.kind === 'check' ? result.value.decision : null
    const { identity } = screenContextParts(inputs)
    const completion: GroundingContext['completion'] = completionWitnessed(inputs) ? 'witnessed' : 'unwitnessed'

    // Every known safety note and direction of the step with its own actual sources: the mandatory payload.
    const manualFacts =
        session !== null && step !== null && STEP_KINDS.has(inputs.kind)
            ? manualDirectionFacts(session, step.stepId)
            : []

    const citedPageIds = new Set(table.refs.map((ref) => ref.pageId))
    const ui = screenUiForKind(inputs.kind, inputs.uiState) as { [key: string]: unknown } | null
    const stepCount = facts?.steps.length ?? 0
    const view = providerView({
        kind: inputs.kind,
        session,
        facts,
        step,
        stepIndex,
        stepCount,
        partNames,
        quantities,
        stepPartIds,
        sources: table.refs,
        witnesses,
        manualFacts,
        completion,
        decision,
        regions,
        result,
        failure: inputs.failure,
        captureId: identity.captureId,
        citedPageIds,
        ui,
    })
    // The key hashes the shared canonical inputs (the app computes the same bytes). The provider view is a pure
    // function of those inputs plus this code, whose changes are versioned by the prompt and catalog versions.
    const bound: ScreenBound = {
        manualId: identity.manualId,
        revision: identity.revision,
        stepId: identity.stepId,
        captureId: identity.captureId,
        contextKey: sha256(screenContextJson(inputs)),
    }
    return {
        ...inputs,
        captureId: identity.captureId,
        step,
        stepIndex,
        stepCount,
        reviewed: facts?.reviewed ?? false,
        contentKey: sha256(screenContentJson(inputs)),
        partNames,
        quantities,
        stepPartIds,
        citedPageIds,
        sources: table.refs,
        witnesses,
        units,
        manualFacts,
        ui: inputs.uiState ?? null,
        completion,
        decision,
        regions,
        bound,
        view,
    }
}

interface ViewInput {
    kind: ScreenKind
    session: ManualSession | null
    facts: Facts | null
    step: ManualStep | null
    stepIndex: number
    stepCount: number
    partNames: ReadonlyMap<string, string>
    quantities: ReadonlyMap<string, number>
    stepPartIds: ReadonlySet<string>
    sources: readonly SourceRef[]
    witnesses: readonly Witness[]
    manualFacts: readonly ManualFact[]
    completion: GroundingContext['completion']
    decision: Decision | null
    regions: GroundingContext['regions']
    result: ScreenInputs['result']
    failure: ScreenInputs['failure']
    captureId: string | null
    citedPageIds: ReadonlySet<string>
    ui: Record<string, unknown> | null
}

/**
 * The provider's whole input for one screen: stable manual-level context first (for provider prompt caching), then the
 * dynamic per-screen request. Facts are listed as complete units with the indexes of their own sources; the model may
 * only restate those texts, pick existing sources/figures by index, and compose. Never photos, never geometry.
 */
function providerView(input: ViewInput): GroundingContext['view'] {
    const { session, step, result } = input
    return {
        stable: {
            manual: session && {
                title: session.title,
                pages: session.pages.map((page) => ({
                    pageId: page.pageId,
                    assetId: page.assetId,
                    contentHash: page.contentHash,
                    mimeType: page.mimeType,
                    width: page.width,
                    height: page.height,
                })),
                steps: input.stepCount,
                parts: (input.facts?.parts ?? []).flatMap((part) =>
                    part.name.state === 'known' ? [{ partId: part.partId, name: part.name.value }] : [],
                ),
            },
        },
        dynamic: {
            screen: {
                kind: input.kind,
                captureId: input.captureId,
                failure: input.failure,
                completion: input.kind === 'completion' ? input.completion : null,
                step: step && {
                    order: step.order,
                    of: input.stepCount,
                    title: step.title,
                    parts: step.parts.flatMap((part) => {
                        const name = input.partNames.get(part.partId)
                        return name === undefined
                            ? []
                            : [{ partId: part.partId, name, quantity: input.quantities.get(part.partId) ?? null }]
                    }),
                },
                // Existing manual sources the model may emphasize by index (HeroFigure.sourceRefIndex); never geometry.
                sources: input.sources.map((ref, index) => ({ index, pageId: ref.pageId, region: ref.region })),
                figures: {
                    pageIds: [...input.citedPageIds],
                    partIds: [...input.stepPartIds],
                    captureId: input.captureId,
                },
                facts: input.witnesses
                    .filter(
                        (witness) =>
                            witness.kind !== 'part' &&
                            (witness.refs.length > 0 || ['verdict', 'answer', 'missing'].includes(witness.kind)),
                    )
                    .map((witness) => ({
                        id: witness.id,
                        kind: witness.kind,
                        text: witness.text,
                        sources: witness.refs,
                    })),
                // The step's complete manual facts, by id: a ManualDirections block names them; the server writes them.
                manualFacts: input.manualFacts.map((fact) => ({
                    id: fact.factId,
                    kind: fact.kind,
                    basis: fact.basis,
                    text: fact.text,
                    pages: [...new Set(fact.sourceRefs.map((ref) => ref.pageId))],
                })),
                // Live app data the heavy blocks bind to by reference (never written by the model).
                ui: input.ui,
                result:
                    result === null
                        ? null
                        : result.kind === 'check'
                          ? {
                                kind: 'check',
                                decision: result.value.decision,
                                regionParts: {
                                    next: input.regions.next?.partId ?? null,
                                    target: input.regions.target?.partId ?? null,
                                    observed: input.regions.observed !== null,
                                },
                            }
                          : { kind: 'question', question: result.question },
            },
        },
    }
}
