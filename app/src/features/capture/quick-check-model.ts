import { stepEvidenceRequirements, type ManualSession, type ManualStep } from '@truebuild/contracts'
import { unresolvedCriticalFacts } from './controller'

/** The two missing facts `acceptStepFacts` can fill: an unknown orientation, or no visible checks at all. */
export type QuestionKind = 'orientation' | 'checks'
export type Question = {
    readonly id: string
    readonly kind: QuestionKind
    readonly step: ManualStep
    readonly stepIndex: number
    // The manual's own stated reason, when it gave one. Shown as context, never as an answer.
    readonly reason: string | null
}

/** Editable questions in step order. Each corresponds to exactly one unresolved critical fact. */
export function editableQuestions(session: ManualSession): Question[] {
    const questions: Question[] = []
    session.reviewedSteps.forEach((step, stepIndex) => {
        const required = stepEvidenceRequirements(step)
        if (required.orientation && step.orientation.state === 'unknown') {
            questions.push({
                id: `${step.stepId}:orientation`,
                kind: 'orientation',
                step,
                stepIndex,
                reason: step.orientation.reason,
            })
        }
        if (required.visibleChecks && step.visibleChecks.length === 0) {
            questions.push({ id: `${step.stepId}:checks`, kind: 'checks', step, stepIndex, reason: null })
        }
    })
    return questions
}

/** Unresolved critical facts that cannot be filled from here (they need clearer pages and a new read). */
export function otherBlockers(session: ManualSession): string[] {
    return unresolvedCriticalFacts(session).filter((issue) => !isEditableIssue(session, issue))
}

function isEditableIssue(session: ManualSession, issue: string): boolean {
    return session.reviewedSteps.some((step) => {
        const required = stepEvidenceRequirements(step)
        const label = `Step ${step.order}`
        return (
            (required.orientation &&
                step.orientation.state === 'unknown' &&
                issue === `${label} orientation: ${step.orientation.reason}`) ||
            (required.visibleChecks &&
                step.visibleChecks.length === 0 &&
                issue === `${label}: visible checks are missing.`)
        )
    })
}
