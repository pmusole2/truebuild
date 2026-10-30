import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    BUSY_ACTIVITIES_V2,
    BUSY_COPY_V2,
    SCREEN_KINDS_V2,
    buildFallbackDocumentV2,
    createDemoManual,
    documentMaterialV2,
    literalIssuesV2,
    questionResultSchema,
    screenDocumentV2Schema,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenUiStateV2,
} from './index'
import { createHeroResponse } from './hero'

// Native finding: an Android questions sheet keeps its scroll offset while busy, so the body's `Still thinking…` was
// off screen and the persistent header still said `Ask about this step`. The fixed header must state the activity.
// Second finding: the completion body published a Progress and a Meter for the same build count.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

const baseUi: ScreenUiStateV2 = {
    pages: {
        items: [{ pageId: 'demo-page-1', width: 1200, height: 900 }],
        maxPages: 20,
        canRead: true,
        languageOptions: ['en', 'es'],
    },
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['how-it-works', 'settings', 'about-this-check', 'tips'],
    language: { options: ['en', 'es'] },
    settings: { storage: true },
}

function inputsFor(kind: ScreenKindV2, uiState: ScreenUiStateV2 = baseUi): ScreenContextInputsV2 {
    const sessionless = ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare'].includes(kind)
    const stepBound = ['guide', 'result', 'questions', 'answer', 'recovery'].includes(kind)
    const base: ScreenContextInputsV2 = {
        kind,
        session: sessionless ? null : createDemoManual(),
        stepId: stepBound ? 'step-1' : null,
        captureId: ['result', 'answer', 'questions'].includes(kind) ? 'cap-1' : null,
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
                    missingEvidence: [],
                }),
            },
        }
    }
    return base
}

const fallbackFor = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })
const clone = <T>(value: T): T => structuredClone(value)

function nodesOf(document: ScreenDocumentV2, name: string): ScreenNodeV2[] {
    const out: ScreenNodeV2[] = []
    for (const entry of variantsOfV2(document)) {
        if (entry.name === name) visitVariantNodesV2(entry.variant, entry.prefix, ({ node }) => out.push(node))
    }
    return out
}

describe('busy header states the current activity', () => {
    // Error, More, judge and compare are never busy: the context key drops the activity for them.
    const NEVER_BUSY: readonly ScreenKindV2[] = ['error', 'more', 'judge', 'compare']
    const busyKinds = SCREEN_KINDS_V2.filter((kind) => !NEVER_BUSY.includes(kind))
    const cases = busyKinds.flatMap((kind) => BUSY_ACTIVITIES_V2.map((activity) => [kind, activity] as const))

    it.each(cases)('%s busy header is the %s heading, whatever the body scroll', (kind, activity) => {
        const inputs = inputsFor(kind, { ...baseUi, busy: { activity } })
        const document = fallbackFor(inputs)
        const busy = document.states.busy
        expect(busy).not.toBeNull()
        expect(busy!.header.title).toEqual({ kind: 'literal', text: BUSY_COPY_V2[activity].heading })
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it.each(NEVER_BUSY)('%s keeps its header: the activity is not part of its context', (kind) => {
        const plain = fallbackFor(inputsFor(kind))
        const named = inputsFor(kind, { ...baseUi, busy: { activity: 'asking' } })
        expect(fallbackFor(named)).toEqual(plain)
        expect(literalIssuesV2(plain, documentMaterialV2(named))).toEqual([])
    })

    it('the questions sheet header says Still thinking… / Asking… while busy, and keeps its context and back', () => {
        for (const activity of ['question-waiting', 'asking'] as const) {
            const document = fallbackFor(inputsFor('questions', { ...baseUi, busy: { activity } }))
            const ready = document.header
            const busy = document.states.busy!.header
            expect(busy.title).toEqual({ kind: 'literal', text: BUSY_COPY_V2[activity].heading })
            expect(busy.subtitle).toEqual(ready.subtitle)
            expect(busy.back).toEqual(ready.back)
            expect(ready.title).toEqual({ kind: 'literal', text: 'Ask about this step' })
        }
        const second = fallbackFor(inputsFor('result', { ...baseUi, busy: { activity: 'second-opinion' } }))
        expect(second.states.busy!.header.title).toEqual({ kind: 'literal', text: 'Taking a closer look…' })
    })

    it('rejects a busy variant that keeps the ready heading, in the server gate and the request-bound client', () => {
        const inputs = inputsFor('questions', { ...baseUi, busy: { activity: 'question-waiting' } })
        const stale = clone(fallbackFor(inputs))
        stale.states.busy = {
            ...stale.states.busy!,
            header: { ...stale.states.busy!.header, title: stale.header.title },
        }
        expect(literalIssuesV2(stale, documentMaterialV2(inputs))).toContain('states.busy.header:busy_header_mismatch')
        expect(verifyDocumentAgainstInputsV2(stale, inputs, sha256Hex)).toContain('busy_header_mismatch')

        // The wrong activity's (listed elsewhere) heading is rejected too; only the current one is accepted.
        const wrong = clone(fallbackFor(inputs))
        wrong.states.busy = {
            ...wrong.states.busy!,
            header: { ...wrong.states.busy!.header, title: { kind: 'literal', text: BUSY_COPY_V2.asking.heading } },
        }
        expect(literalIssuesV2(wrong, documentMaterialV2(inputs))).toContain('states.busy.header:busy_header_mismatch')

        // A bound or fact reference cannot stand in for the activity wording either.
        const bound = clone(fallbackFor(inputs))
        bound.states.busy = {
            ...bound.states.busy!,
            header: { ...bound.states.busy!.header, title: { kind: 'bound', key: 'step-title' } },
        }
        expect(literalIssuesV2(bound, documentMaterialV2(inputs))).toContain('states.busy.header:busy_header_mismatch')
    })

    it('leaves other states unchanged and is silent without a named activity', () => {
        for (const kind of SCREEN_KINDS_V2) {
            const inputs = inputsFor(kind)
            const document = fallbackFor(inputs)
            expect(literalIssuesV2(document, documentMaterialV2(inputs)), kind).toEqual([])
            const named = fallbackFor(inputsFor(kind, { ...baseUi, busy: { activity: 'checking' } }))
            for (const name of ['pending', 'empty', 'error', 'recovery', 'confirming'] as const) {
                expect(named.states[name], `${kind} ${name}`).toEqual(document.states[name])
            }
        }
    })
})

describe('completion publishes one build indicator', () => {
    it('the ready body carries one Progress and no Meter for the same build count', () => {
        for (const ui of [baseUi, { ...baseUi, busy: { activity: 'saving' as const } }]) {
            const inputs = inputsFor('completion', ui)
            const document = fallbackFor(inputs)
            const ready = nodesOf(document, 'ready')
            expect(ready.filter((node) => node.type === 'Progress')).toHaveLength(1)
            expect(ready.filter((node) => node.type === 'Meter')).toHaveLength(0)
            expect(
                ready.some(
                    (node) =>
                        node.type === 'Text' &&
                        node.content.kind === 'bound' &&
                        node.content.key === 'completion-summary',
                ),
            ).toBe(true)
            expect(document.header.subtitle).toEqual({ kind: 'bound', key: 'manual-title' })
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        }
    })
})
