import { createDemoManual, questionResultSchema, type ScreenContextInputsV2 } from '@truebuild/contracts'
import { createHeroResponse } from '@truebuild/contracts/hero'

export const checkContext = (orientation: 'correct' | 'reversed' | 'uncertain' = 'correct'): ScreenContextInputsV2 => ({
    kind: 'result',
    session: createDemoManual(),
    stepId: 'step-1',
    captureId: 'current-photo',
    result: { kind: 'check', value: createHeroResponse(orientation) },
    failure: null,
    uiState: { capture: { captureId: 'current-photo', reusable: true, target: null, questionDraftPresent: false } },
})
export const answerContext = (): ScreenContextInputsV2 => ({
    ...checkContext(),
    kind: 'answer',
    result: {
        kind: 'question',
        question: 'Which face is inward?',
        value: questionResultSchema.parse({
            answer: 'Use the inward face identified by the current instruction.',
            sourceRefs: [{ pageId: 'demo-page-1', region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }],
            missingEvidence: [],
        }),
    },
})

export const pendingCheckContext = (): ScreenContextInputsV2 => {
    const current = checkContext()
    return { ...current, result: null, uiState: { ...current.uiState, busy: { activity: 'checking' } } }
}

/** Dense, repeated current source geometry can exceed this particular record's expansion budget. */
export function largeContext(denseSafetySources = false): ScreenContextInputsV2 {
    const inputs = checkContext('uncertain')
    const step = inputs.session!.reviewedSteps[0]!
    const sourceRefs = [{ pageId: 'demo-page-1', region: null }]
    step.safetyNotes = Array.from({ length: denseSafetySources ? 25 : 100 }, (_, index) => ({
        noteId: `safety-${index}`,
        note: { state: 'known', value: `Current safety instruction ${index}.`, sourceRefs },
    }))
    step.visibleChecks = Array.from({ length: 100 }, (_, index) => ({
        checkId: `check-${index}`,
        description: { state: 'known', value: `Current visible instruction ${index}.`, sourceRefs },
    }))
    step.correction = {
        reviewed: true,
        actions: Array.from({ length: 50 }, (_, index) => ({
            actionId: `correction-${index}`,
            instruction: `Current correction ${index}.`,
            sourceRefs: denseSafetySources
                ? Array.from({ length: 100 }, (_, region) => ({
                      pageId: 'demo-page-1',
                      region: { x: region / 200, y: 0.1, width: 0.004, height: 0.004 },
                  }))
                : sourceRefs,
        })),
    }
    if (inputs.result?.kind !== 'check') throw new Error('check fixture')
    inputs.result.value.missingEvidence = Array.from(
        { length: 100 },
        (_, index) => `Current evidence ${index} is missing.`,
    )
    return inputs
}
