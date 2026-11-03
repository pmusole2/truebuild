import { createDemoManual, type ManualSession } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { outgoingInputs, outgoingManualSession } from './outgoing-session'

const PROPOSED = 'A proposed fix that no person has reviewed.'

/** A saved session whose reviewed step and raw extraction both carry an unreviewed correction. */
function sessionWithUnreviewedCorrections(): ManualSession {
    const session = createDemoManual()
    const step = session.reviewedSteps[0]!
    const sourceRefs = step.correction!.actions[0]!.sourceRefs
    const unreviewed = { reviewed: false, actions: [{ actionId: 'proposed', instruction: PROPOSED, sourceRefs }] }
    session.reviewedSteps[0] = { ...step, correction: unreviewed }
    session.rawExtraction = {
        ...session.rawExtraction!,
        steps: session.rawExtraction!.steps.map((raw) => ({ ...raw, correction: unreviewed })),
    }
    return session
}

describe('outgoing manual session', () => {
    it('sends no unreviewed correction in reviewed steps or raw extraction', () => {
        const outgoing = outgoingManualSession(sessionWithUnreviewedCorrections())
        expect(outgoing.reviewedSteps[0]!.correction).toBeNull()
        expect(outgoing.reviewedSteps.some((step) => step.correction?.reviewed === false)).toBe(false)
        expect(outgoing.rawExtraction!.steps.every((step) => step.correction === null)).toBe(true)
        expect(JSON.stringify(outgoing)).not.toContain(PROPOSED)
    })

    it('leaves the saved session exactly as it was', () => {
        const saved = sessionWithUnreviewedCorrections()
        const before = structuredClone(saved)
        outgoingManualSession(saved)
        expect(saved).toEqual(before)
    })

    it('keeps a reviewed correction, which is a person-approved fact', () => {
        const session = createDemoManual()
        const step = session.reviewedSteps[0]!
        const reviewed = {
            reviewed: true,
            actions: [{ actionId: 'fix', instruction: 'Turn back.', sourceRefs: step.sourceRefs }],
        }
        session.reviewedSteps[0] = { ...step, correction: reviewed }
        expect(outgoingManualSession(session).reviewedSteps[0]!.correction).toEqual(reviewed)
    })

    it('projects the inputs of a request the same way as the session it carries', () => {
        const saved = sessionWithUnreviewedCorrections()
        const inputs = outgoingInputs({
            kind: 'guide',
            session: saved,
            stepId: saved.reviewedSteps[0]!.stepId,
            captureId: null,
            result: null,
            failure: null,
            uiState: null,
        })
        expect(inputs.session).toEqual(outgoingManualSession(saved))
        expect(saved.reviewedSteps[0]!.correction).not.toBeNull()
    })
})
