import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    SCREEN_KINDS_V2,
    buildFallbackDocumentV2,
    createDemoManual,
    documentMaterialV2,
    bindingIssuesV2,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenUiStateV2,
} from './index'

// A model may place a live-bound node (Progress, Meter, Stepper, Toggle) only where the app has that state to bind.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

const review = {
    currentQuestion: {
        questionId: 'q1',
        kind: 'orientation' as const,
        stepId: 'step-1',
        stepOrder: 1,
        reason: 'Check this.',
        parts: [],
    },
    blockers: 0,
    canConfirm: true,
}
const ui: ScreenUiStateV2 = {
    pages: {
        items: [{ pageId: 'demo-page-1', width: 1200, height: 900 }],
        maxPages: 20,
        canRead: true,
        languageOptions: ['en'],
    },
    review,
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['settings', 'tips'],
    judge: { builtView: false },
    camera: { mode: 'build-photo', permission: 'granted' },
}
const SESSIONLESS: readonly ScreenKindV2[] = ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare']
const inputsFor = (kind: ScreenKindV2, uiState: ScreenUiStateV2 = ui): ScreenContextInputsV2 => ({
    kind,
    session: SESSIONLESS.includes(kind) ? null : createDemoManual(),
    stepId: ['guide', 'result', 'questions', 'answer', 'recovery', 'camera'].includes(kind) ? 'step-1' : null,
    captureId: null,
    result: null,
    failure: kind === 'error' ? 'timeout' : null,
    uiState,
})
const fallbackFor = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })

/** The document with one extra live-bound node appended to its ready body. */
function withNode(document: ScreenDocumentV2, node: ScreenNodeV2): ScreenDocumentV2 {
    return { ...document, body: { type: 'Stack', gap: 'md', align: 'stretch', children: [document.body, node] } }
}
const issues = (document: ScreenDocumentV2, inputs: ScreenContextInputsV2): string[] =>
    bindingIssuesV2(document, documentMaterialV2(inputs))

describe('the fallback builder never binds what the screen cannot resolve', () => {
    it.each(SCREEN_KINDS_V2)('%s has no unavailable binding, with or without app state', (kind) => {
        for (const state of [ui, {}] as ScreenUiStateV2[]) {
            const inputs = inputsFor(kind, state)
            expect(issues(fallbackFor(inputs), inputs), `${kind} ${JSON.stringify(Object.keys(state))}`).toEqual([])
            expect(
                verifyDocumentAgainstInputsV2(fallbackFor(inputs), inputs).filter((code) => code.includes('binding')),
            ).toEqual([])
        }
    })
})

describe('an unsupported binding is refused wherever the app has no such state', () => {
    const progress = (binding: 'step' | 'build' | 'reading' | 'pages' | 'review'): ScreenNodeV2 => ({
        type: 'Progress',
        binding,
        label: null,
    })

    it('review progress exists only in the quick check with a current question', () => {
        for (const kind of SCREEN_KINDS_V2.filter((candidate) => candidate !== 'quick-check')) {
            const inputs = inputsFor(kind)
            expect(issues(withNode(fallbackFor(inputs), progress('review')), inputs).join(), kind).toContain(
                'binding_unavailable',
            )
        }
        const noQuestion = inputsFor('quick-check', { ...ui, review: { ...review, currentQuestion: null } })
        expect(issues(withNode(fallbackFor(noQuestion), progress('review')), noQuestion).join()).toContain(
            'binding_unavailable',
        )
        const quick = inputsFor('quick-check')
        expect(issues(withNode(fallbackFor(quick), progress('review')), quick)).toEqual([])
    })

    it('step, reading and pages progress need their own state', () => {
        const home = inputsFor('home')
        expect(issues(withNode(fallbackFor(home), progress('step')), home).join()).toContain('binding_unavailable')
        expect(issues(withNode(fallbackFor(home), progress('reading')), home).join()).toContain('binding_unavailable')
        expect(issues(withNode(fallbackFor(home), progress('pages')), home).join()).toContain('binding_unavailable')
        const guide = inputsFor('guide')
        expect(issues(withNode(fallbackFor(guide), progress('step')), guide)).toEqual([])
        expect(issues(withNode(fallbackFor(guide), progress('reading')), guide).join()).toContain('binding_unavailable')
        const pages = inputsFor('pages')
        expect(issues(withNode(fallbackFor(pages), progress('pages')), pages)).toEqual([])
        const reading = inputsFor('reading')
        expect(issues(withNode(fallbackFor(reading), progress('reading')), reading)).toEqual([])
    })

    it('meters and steppers need a build or pages', () => {
        const home = inputsFor('home')
        const meter: ScreenNodeV2 = { type: 'Meter', binding: 'steps-confirmed', label: null, tone: 'neutral' }
        const stepper: ScreenNodeV2 = { type: 'Stepper', binding: 'steps', label: null }
        for (const node of [meter, stepper]) {
            expect(issues(withNode(fallbackFor(home), node), home).join(), node.type).toContain('binding_unavailable')
        }
        const completion = inputsFor('completion')
        expect(issues(withNode(fallbackFor(completion), stepper), completion)).toEqual([])
    })

    it('the built-view toggle exists only on the judge screen', () => {
        const toggle: ScreenNodeV2 = {
            type: 'Toggle',
            binding: 'built-view',
            label: { kind: 'literal', text: 'Show how Meta AI built this' },
        }
        const more = inputsFor('more')
        expect(issues(withNode(fallbackFor(more), toggle), more).join()).toContain('binding_unavailable')
        const judge = inputsFor('judge')
        expect(issues(withNode(fallbackFor(judge), toggle), judge)).toEqual([])
    })

    it('the client verifier reports it for a document it receives', () => {
        const home = inputsFor('home')
        const forged = withNode(fallbackFor(home), progress('review'))
        expect(variantsOfV2(forged).length).toBeGreaterThan(0)
        expect(verifyDocumentAgainstInputsV2(forged, home)).toContain('binding_unavailable')
    })
})

it.each([false, true])('a question cannot bind a verdict card without a published result (reusable=%s)', (reusable) => {
    const request = {
        ...inputsFor('questions'),
        captureId: 'cap-1',
        uiState: { ...ui, capture: { ...ui.capture!, reusable } },
    }
    const document = withNode(fallbackFor(request), {
        type: 'VerdictCard',
        result: 'check',
        variant: 'card',
        showReason: true,
        showRegions: true,
    })
    expect(issues(document, request).join()).toContain('binding_unavailable')
    expect(verifyDocumentAgainstInputsV2(document, request)).toContain('binding_unavailable')
})
