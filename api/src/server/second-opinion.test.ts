import { createDemoManual, type CheckResult } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import type { CheckStepInput } from '../providers/meta-provider'
import { SecondOpinionTickets, reconcileSecondOpinion } from './second-opinion'

const primary: CheckResult = {
    model: 'muse-spark-1.3',
    decision: 'cannot_verify',
    orientationAssessment: 'uncertain',
    reason: 'Not clear',
    sourceRefs: [],
    observedRegion: null,
    missingEvidence: ['Need orientation'],
}
function input(): CheckStepInput {
    const session = createDemoManual()
    return {
        requestId: 'request-1',
        binding: {
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: 'step-1',
            captureId: 'capture-1',
        },
        session,
        sourceImages: [{ page: session.pages[0]!, bytes: new Uint8Array([1, 2]) }],
        observation: { mimeType: 'image/png', width: 20, height: 16, bytes: new Uint8Array([3, 4]) },
    }
}

describe('bounded one-use second-opinion tickets', () => {
    it('atomically consumes once and binds every context and image byte', () => {
        const tickets = new SecondOpinionTickets()
        for (const change of [
            (v: CheckStepInput): void => {
                v.requestId = 'new'
            },
            (v: CheckStepInput): void => {
                v.binding.captureId = 'new'
            },
            (v: CheckStepInput): void => {
                v.session.title = 'new'
            },
            (v: CheckStepInput): void => {
                v.sourceImages[0]!.bytes[0] = 8
            },
            (v: CheckStepInput): void => {
                v.observation.bytes[0] = 8
            },
        ]) {
            const token = tickets.issue(input(), primary)!
            const altered = input()
            change(altered)
            expect(tickets.consume(token, altered)).toBeNull()
            expect(tickets.consume(token, input())).toBeNull()
        }
        const token = tickets.issue(input(), primary)!
        expect(tickets.consume(token, input())).toEqual(primary)
        expect(tickets.consume(token, input())).toBeNull()
    })
    it('expires at 120s and never retains more than 64 tickets', () => {
        let now = 0
        const tickets = new SecondOpinionTickets(() => now)
        for (let n = 0; n < 64; n++) expect(tickets.issue(input(), primary)).toEqual(expect.any(String))
        expect(tickets.issue(input(), primary)).toBeNull()
        now = 120_000
        const token = tickets.issue(input(), primary)!
        now += 120_000
        expect(tickets.consume(token, input())).toBeNull()
    })
    it('retains primary uncertainty on pass/conflict and accepts only grounded coherent refusal', () => {
        const refusal: CheckResult = {
            model: 'muse-wonder-1.0',
            decision: 'refuse',
            orientationAssessment: 'reversed',
            reason: 'Panel reversed',
            observedRegion: { x: 0, y: 0, width: 1, height: 1 },
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            missingEvidence: [],
        }
        const checkInput = input()
        expect(
            reconcileSecondOpinion(
                primary,
                { ...refusal, decision: 'pass', orientationAssessment: 'correct' },
                'muse-wonder-1.0',
                checkInput,
            ).decision,
        ).toBe('cannot_verify')
        expect(
            reconcileSecondOpinion(
                { ...primary, orientationAssessment: 'correct' },
                refusal,
                'muse-wonder-1.0',
                checkInput,
            ).decision,
        ).toBe('cannot_verify')
        expect(
            reconcileSecondOpinion(primary, { ...refusal, observedRegion: null }, 'muse-wonder-1.0', checkInput)
                .decision,
        ).toBe('cannot_verify')
        expect(reconcileSecondOpinion(primary, refusal, 'muse-wonder-1.0', checkInput)).toMatchObject({
            decision: 'refuse',
            model: 'muse-wonder-1.0',
            secondOpinion: { status: 'completed' },
        })
    })
    it.each(['orientation', 'visible-check'] as const)('accepts a refusal grounded only in a %s citation', (kind) => {
        const checkInput = input()
        const step = checkInput.session.reviewedSteps[0]!
        const ref = { pageId: 'demo-page-1', region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }
        if (kind === 'orientation' && step.orientation.state === 'known') step.orientation.sourceRefs = [ref]
        else
            step.visibleChecks[0]!.description = {
                state: 'known',
                value: 'Synthetic visible feature',
                sourceRefs: [ref],
            }
        const secondary: CheckResult = {
            decision: 'refuse',
            orientationAssessment: 'reversed',
            model: 'muse-wonder-1.0',
            reason: 'Synthetic grounded mismatch',
            sourceRefs: [ref],
            observedRegion: ref.region,
            missingEvidence: [],
        }
        expect(reconcileSecondOpinion(primary, secondary, 'muse-wonder-1.0', checkInput).decision).toBe('refuse')
    })
})
