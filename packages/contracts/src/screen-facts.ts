import type { Fact, ManualSession, ManualStep, SourceRef } from './index'
import { isRequiredManualFact, type ManualFact } from './screen'

/**
 * Pure, portable resolution of the manual facts a step screen must carry. The API and the app call the same function
 * on the same session, so the mandatory payload never depends on a model, a document or a network round trip.
 *
 * Nothing here is invented or classified by wording: every returned text is the manual's own complete text for that
 * field, with the fact's own actual source references.
 */

/** Reviewed steps when the session is reviewed, otherwise the known raw extraction (never merged or guessed). */
function stepsOf(session: ManualSession): readonly ManualStep[] {
    return session.reviewStatus === 'reviewed' ? session.reviewedSteps : (session.rawExtraction?.steps ?? [])
}

const copyRefs = (refs: readonly SourceRef[]): SourceRef[] =>
    refs.map((ref) => ({ pageId: ref.pageId, region: ref.region }))

function known<T>(fact: Fact<T>): { value: T; sourceRefs: SourceRef[] } | null {
    return fact.state === 'known' ? { value: fact.value, sourceRefs: copyRefs(fact.sourceRefs) } : null
}

/** Procedure facts use stable IDs and existing wire kinds so older strict document schemas stay valid. */
export function isManualDirectionFact(fact: Pick<ManualFact, 'factId'>): boolean {
    return fact.factId === 'title' || fact.factId.startsWith('action:')
}

/** Completed conditions are checks, never procedure instructions. */
export function isManualCheckFact(fact: { kind: string }): boolean {
    return fact.kind === 'orientation' || fact.kind === 'connection' || fact.kind === 'check'
}

/**
 * The procedure is the supplied actions, or the title for saved steps without them. Completed conditions remain
 * separate facts, and only reviewed fixes are available. Legacy mode is solely the server's old-client projection.
 * Explicit safety and unclassified detail keep their conservative non-Guide requirements.
 */
export function manualDirectionFacts(session: ManualSession, stepId: string, legacy = false): ManualFact[] {
    const step = stepsOf(session).find((candidate) => candidate.stepId === stepId)
    if (step === undefined) return []
    const basis = step.safetyNotes == null ? ('unclassified-step' as const) : ('direction' as const)
    const facts: ManualFact[] = []
    for (const entry of step.safetyNotes ?? []) {
        const note = known(entry.note)
        if (note !== null) {
            facts.push({
                factId: `safety:${entry.noteId}`,
                kind: 'safety',
                basis: 'safety-note',
                text: note.value,
                sourceRefs: note.sourceRefs,
            })
        }
    }
    if ((legacy ? step.safetyNotes == null : (step.actions?.length ?? 0) === 0) && step.sourceRefs.length > 0) {
        facts.push({
            factId: 'title',
            kind: 'title',
            basis,
            text: step.title,
            sourceRefs: copyRefs(step.sourceRefs),
        })
    }
    if (!legacy) {
        for (const action of step.actions ?? []) {
            facts.push({
                factId: `action:${action.actionId}`,
                // Keep the established instruction wire kind; the action: namespace identifies procedure entries.
                kind: 'correction',
                basis,
                text: action.instruction,
                sourceRefs: copyRefs(action.sourceRefs),
            })
        }
    }
    const selected = (step.alternatives ?? []).find((item) => item.alternativeId === step.selectedAlternativeId)
    if (selected !== undefined) {
        facts.push({
            factId: `alternative:${selected.alternativeId}`,
            kind: 'alternative',
            basis,
            text: `${selected.title}. ${selected.description}`,
            sourceRefs: copyRefs(selected.sourceRefs),
        })
    }
    const orientation = known(step.orientation)
    if (orientation !== null) {
        facts.push({
            factId: 'orientation',
            kind: 'orientation',
            basis,
            text: orientation.value.description,
            sourceRefs: orientation.sourceRefs,
        })
    }
    const connection = known(step.connection)
    if (connection !== null) {
        facts.push({
            factId: 'connection',
            kind: 'connection',
            basis,
            text: connection.value.description,
            sourceRefs: connection.sourceRefs,
        })
    }
    for (const check of step.visibleChecks) {
        const description = known(check.description)
        if (description !== null) {
            facts.push({
                factId: `check:${check.checkId}`,
                kind: 'check',
                basis,
                text: description.value,
                sourceRefs: description.sourceRefs,
            })
        }
    }
    for (const action of (legacy || step.correction?.reviewed === true ? step.correction?.actions : []) ?? []) {
        facts.push({
            factId: `correction:${action.actionId}`,
            kind: 'correction',
            basis,
            text: action.instruction,
            sourceRefs: copyRefs(action.sourceRefs),
        })
    }
    return facts
}

/** Legacy screen requirements retain their conservative facts; the v2 Guide publishes its own explicit groups. */
export function requiredManualFacts(session: ManualSession, stepId: string): ManualFact[] {
    return manualDirectionFacts(session, stepId, true).filter(isRequiredManualFact)
}

/** Safety notes the extraction could not read: unresolved, never shown as a fact, resolved only by a clearer page. */
export function unresolvedSafetyNotes(session: ManualSession, stepId: string): { noteId: string; reason: string }[] {
    const step = stepsOf(session).find((candidate) => candidate.stepId === stepId)
    return (step?.safetyNotes ?? []).flatMap((entry) =>
        entry.note.state === 'unknown' ? [{ noteId: entry.noteId, reason: entry.note.reason }] : [],
    )
}
