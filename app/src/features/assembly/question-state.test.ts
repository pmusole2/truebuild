import { createDemoManual, type ApiResult, type CaptureBinding, type QuestionResult } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import {
    createQuestionState,
    QUESTION_MAX_LENGTH,
    questionReady,
    questionReducer,
    stepPartChoices,
    type QuestionState,
} from './question-state'

const binding: CaptureBinding = {
    kind: 'capture',
    manualId: 'demo-divider',
    revision: 1,
    stepId: 'step-1',
    captureId: 'capture-1',
}
const answer = (requestId: string): ApiResult<QuestionResult> => ({
    status: 'ok',
    requestId,
    mode: 'model',
    binding,
    value: { answer: 'Groove inward.', sourceRefs: [{ pageId: 'demo-page-1', region: null }], missingEvidence: [] },
})

function asked(): QuestionState {
    let state = createQuestionState(binding)
    state = questionReducer(state, { type: 'questionChanged', question: 'Which way?' })
    state = questionReducer(state, { type: 'targetChanged', target: { kind: 'part', partId: 'side-panel' } })
    state = questionReducer(state, { type: 'started', requestId: 'q-1' })
    return questionReducer(state, { type: 'finished', requestId: 'q-1', binding, result: answer('q-1') })
}

describe('question state', () => {
    it('is ready only with a non-empty bounded question and a target', () => {
        const base = createQuestionState(binding)
        expect(questionReady(base)).toBe(false)
        const withText = questionReducer(base, { type: 'questionChanged', question: 'Which way?' })
        expect(questionReady(withText)).toBe(false)
        const withTarget = questionReducer(withText, {
            type: 'targetChanged',
            target: { kind: 'point', x: 0.5, y: 0.5 },
        })
        expect(questionReady(withTarget)).toBe(true)
        const tooLong = questionReducer(withTarget, {
            type: 'questionChanged',
            question: 'x'.repeat(QUESTION_MAX_LENGTH + 1),
        })
        expect(questionReady(tooLong)).toBe(false)
    })

    it('publishes an answer for the pending request and binding only', () => {
        const state = asked()
        expect(state.result).toMatchObject({ status: 'ok', value: { answer: 'Groove inward.' } })
        expect(state.pendingRequestId).toBeNull()
    })

    it('drops a late answer for an earlier request or a different capture', () => {
        let state = createQuestionState(binding)
        state = questionReducer(state, { type: 'questionChanged', question: 'Which way?' })
        state = questionReducer(state, { type: 'targetChanged', target: { kind: 'point', x: 0.1, y: 0.1 } })
        state = questionReducer(state, { type: 'started', requestId: 'q-2' })

        const wrongRequest = questionReducer(state, {
            type: 'finished',
            requestId: 'q-1',
            binding,
            result: answer('q-1'),
        })
        const otherCapture = questionReducer(state, {
            type: 'finished',
            requestId: 'q-2',
            binding: { ...binding, captureId: 'capture-2' },
            result: answer('q-2'),
        })

        expect(wrongRequest).toBe(state)
        expect(otherCapture).toBe(state)
    })

    it('clears the answer and target when the capture changes, but keeps the wording', () => {
        const next = questionReducer(asked(), {
            type: 'bindingSynced',
            binding: { ...binding, captureId: 'capture-2' },
        })

        expect(next.result).toBeNull()
        expect(next.target).toBeNull()
        expect(next.question).toBe('Which way?')
    })

    it('clears a visible answer when the wording or target is edited', () => {
        const edited = questionReducer(asked(), { type: 'questionChanged', question: 'Is it seated?' })
        const retargeted = questionReducer(asked(), { type: 'targetChanged', target: null })

        expect(edited.result).toBeNull()
        expect(retargeted.result).toBeNull()
    })

    it('lists only the parts the current step uses, labelled from the registry', () => {
        const session = createDemoManual()
        const step = session.reviewedSteps.find((candidate) => candidate.stepId === 'step-2')
        expect(step).toBeDefined()
        const choices = stepPartChoices(session, step!)

        expect(choices.map((choice) => choice.partId)).toEqual(['side-panel', 'divider'])
        expect(choices.every((choice) => choice.label.length > 0)).toBe(true)
    })
})
