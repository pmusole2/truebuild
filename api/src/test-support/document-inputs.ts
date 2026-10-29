import { createHeroResponse } from '@truebuild/contracts/hero'
import {
    createDemoManual,
    questionResultSchema,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenKindV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'

export const SAFETY_NOTE = 'Keep fingers clear of the groove while the panel is lifted.'

export function demoSession(options: { safety?: boolean; manualId?: string; revision?: number } = {}): ManualSession {
    const manual = createDemoManual()
    if (options.safety !== false) {
        manual.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'n1',
                note: { state: 'known', value: SAFETY_NOTE, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
            },
        ]
    }
    if (options.manualId) manual.manualId = options.manualId
    if (options.revision) manual.revision = options.revision
    return manual
}

export const libraryUi = {
    entries: [
        {
            manualId: 'demo-divider',
            title: 'Demo',
            updatedAt: '2026-01-01T00:00:00.000Z',
            stopStepId: 'step-1',
            completed: 0,
            total: 2,
            firstPageId: 'demo-page-1',
        },
        {
            manualId: 'second-manual',
            title: 'Second',
            updatedAt: '2026-01-02T00:00:00.000Z',
            stopStepId: null,
            completed: 0,
            total: 3,
            firstPageId: null,
        },
    ],
    soleManualId: null,
}

export const fullUi: ScreenUiStateV2 = {
    library: libraryUi,
    pages: {
        items: [{ pageId: 'demo-page-1', width: 1200, height: 900 }],
        maxPages: 20,
        canRead: true,
        languageOptions: ['en'],
    },
    review: {
        currentQuestion: {
            questionId: 'q1',
            kind: 'orientation',
            stepId: 'step-1',
            stepOrder: 1,
            reason: 'Check this.',
            parts: [],
        },
        blockers: 0,
        canConfirm: true,
    },
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['settings', 'about-this-check', 'tips'],
    camera: { mode: 'build-photo', permission: 'granted' },
    judge: { builtView: false },
}

const SESSIONLESS: readonly ScreenKindV2[] = ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare']
const STEP_BOUND: readonly ScreenKindV2[] = ['guide', 'result', 'questions', 'answer', 'recovery', 'camera']
const WITH_CAPTURE: readonly ScreenKindV2[] = ['result', 'answer', 'questions']

export function documentInputs(
    kind: ScreenKindV2,
    session: ManualSession = demoSession(),
    uiState: ScreenUiStateV2 = fullUi,
): ScreenContextInputsV2 {
    const base: ScreenContextInputsV2 = {
        kind,
        session: SESSIONLESS.includes(kind) ? null : session,
        stepId: STEP_BOUND.includes(kind) ? 'step-1' : null,
        captureId: WITH_CAPTURE.includes(kind) ? 'cap-1' : null,
        result: null,
        failure: kind === 'error' ? 'timeout' : null,
        uiState,
    }
    if (kind === 'result') return { ...base, result: { kind: 'check', value: createHeroResponse('reversed') } }
    if (kind === 'answer') {
        return {
            ...base,
            result: {
                kind: 'question',
                question: 'Which way?',
                value: questionResultSchema.parse({
                    answer: 'The groove faces inward toward the divider.',
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                    missingEvidence: ['A closer photo would help.'],
                }),
            },
        }
    }
    return base
}
