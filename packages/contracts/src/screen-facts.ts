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

/**
 * Every known safety note and physical direction of a step, in manual order: explicit safety notes first, then the
 * unclassified title, selected alternative, orientation, connection, visible checks and correction actions.
 *
 * A step with an explicit safety classification (`safetyNotes` is an array, possibly empty) requires exactly its known
 * safety notes; its other directions are available (`direction`) but not required. A step that was never classified
 * (older data, no field) cannot be assumed to have no hazard, so every known direction is conservatively required
 * (`unclassified-step`): no keyword list decides what is safety-relevant.
 */
export function manualDirectionFacts(session: ManualSession, stepId: string): ManualFact[] {
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
    if (step.safetyNotes == null && step.sourceRefs.length > 0) {
        facts.push({
            factId: 'title',
            kind: 'title',
            basis,
            text: step.title,
            sourceRefs: copyRefs(step.sourceRefs),
        })
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
    for (const action of step.correction?.actions ?? []) {
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

/** The facts every screen of this step must show. A step or session without them returns an empty list. */
export function requiredManualFacts(session: ManualSession, stepId: string): ManualFact[] {
    return manualDirectionFacts(session, stepId).filter(isRequiredManualFact)
}

/** Safety notes the extraction could not read: unresolved, never shown as a fact, resolved only by a clearer page. */
export function unresolvedSafetyNotes(session: ManualSession, stepId: string): { noteId: string; reason: string }[] {
    const step = stepsOf(session).find((candidate) => candidate.stepId === stepId)
    return (step?.safetyNotes ?? []).flatMap((entry) =>
        entry.note.state === 'unknown' ? [{ noteId: entry.noteId, reason: entry.note.reason }] : [],
    )
}
