import { describe, expect, it } from 'vitest'
import { documentKey } from '../document-runtime/store'
import { entry as flowEntry } from '../screens/test-support/route-harness'
import type { WorkflowState } from './controller'
import { documentInputs } from './document-inputs'
const idle: WorkflowState = {
    route: 'library',
    entries: [],
    selectedId: null,
    pending: null,
    notice: null,
    loading: false,
    storageReadOnly: false,
    cameraIntent: null,
    capture: null,
    check: null,
    answer: null,
    question: '',
    target: null,
    pageUris: {},
}
describe('the real v2 route document inputs', () => {
    it.each([
        ['Choosing manual pages…', 'working'],
        ['Preparing page 1 of 2…', 'working'],
        ['Saving on this device…', 'saving'],
        ['Reading manual pages…', 'reading'],
        ['Freezing photo…', 'checking'],
        ['Checking frozen photo…', 'checking'],
        ['Still checking your photo…', 'checking'],
        ['Taking a closer look…', 'second-opinion'],
        ['Asking about frozen photo…', 'asking'],
        ['Still thinking about your question…', 'question-waiting'],
    ])('keeps %s compatible with the closed activity contract', (pending, activity) => {
        const inputs = documentInputs('pages', { state: { ...idle, pending }, entry: undefined })
        expect(inputs.uiState?.busy?.activity).toBe(activity)
    })

    it('publishes the real sole library entry while keeping Home sessionless and never guessing a review question', () => {
        const entry = flowEntry('unread', 'unparsed')
        const sole = documentInputs('home', { state: { ...idle, entries: [entry] }, entry: undefined })
        expect(sole.session).toBeNull()
        expect(sole.uiState?.library?.soleManualId).toBe(entry.session.manualId)
        expect(sole.uiState?.review).toBeUndefined()
        expect(documentInputs('more', { state: idle, entry: undefined }).uiState?.language).toBeUndefined()
        expect(documentInputs('more', { state: idle, entry }).uiState?.language?.options).toEqual([
            'en',
            'es',
            'fr',
            'de',
            'pt-BR',
        ])
        const other = flowEntry('other', 'reviewed')
        expect(
            documentInputs('home', { state: { ...idle, entries: [entry, other] }, entry: undefined }).uiState?.library
                ?.soleManualId,
        ).toBeNull()
    })
    it('binds reading to available manual pages and quick check only to an actual supplied question', () => {
        const entry = flowEntry('read', 'unparsed')
        const reading = documentInputs('reading', { state: idle, entry })
        expect(reading.session).toBe(entry.session)
        expect(reading.stepId).toBeNull()
        expect(reading.captureId).toBeNull()
        expect(documentInputs('quick-check', { state: idle, entry }).uiState?.review?.currentQuestion).toBeNull()
    })
    it('preserves actual completed ids rather than predicting a not-yet-recorded finish', () => {
        const entry = { ...flowEntry('build', 'reviewed', 3), stepIndex: 2, completedStepIds: ['step-1', 'step-2'] }
        expect(documentInputs('completion', { state: idle, entry }).completedStepIds).toEqual(['step-1', 'step-2'])
        expect(entry.completedStepIds).toEqual(['step-1', 'step-2'])
    })
    it('never reuses a guide key across step, revision or page content', () => {
        const entry = flowEntry('build', 'reviewed', 3)
        const current = documentInputs('guide', { state: idle, entry })
        const revision = documentInputs('guide', {
            state: idle,
            entry: { ...entry, session: { ...entry.session, revision: entry.session.revision + 1 } },
        })
        const pages = documentInputs('guide', {
            state: idle,
            entry: {
                ...entry,
                session: {
                    ...entry.session,
                    pages: entry.session.pages.map((page) => ({ ...page, contentHash: 'b'.repeat(64) })),
                },
            },
        })
        const next = documentInputs('guide', { state: idle, entry: { ...entry, stepIndex: 1 } })
        expect(new Set([current, revision, pages, next].map(documentKey)).size).toBe(4)
    })
})
