import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    BOUND_TEXT_KEYS,
    BUSY_ACTIVITIES_V2,
    SCREEN_KINDS_V2,
    composeFallbackDocumentV2,
    createDemoManual,
    documentMaterialV2,
    earnedStateIssuesV2,
    intentAllowedV2,
    manualDisplayTitleV2,
    nodeIntentsV2,
    nodeTextRefsV2,
    questionResultSchema,
    requiredStatesV2,
    screenContextJsonV2,
    screenDocumentV2Schema,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenUiStateV2,
} from './index'
import { createHeroResponse } from './hero'
import { modelScreensV2MetadataSchema, screensV2GenerateRequest } from './model'

// Regression cases for the six authored-UX closures of the second corrections pass. Each fails on the previous source.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }
const WITNESS = { cancellation: 'confirm-before-stop' } as const

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

function inputsFor(
    kind: ScreenKindV2,
    uiState: ScreenUiStateV2 = baseUi,
    session = createDemoManual(),
): ScreenContextInputsV2 {
    const sessionless = ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare'].includes(kind)
    const stepBound = ['guide', 'result', 'questions', 'answer', 'recovery'].includes(kind)
    const base: ScreenContextInputsV2 = {
        kind,
        session: sessionless ? null : session,
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

const compose = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    composeFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })

/** Re-publishes an edited document with its derived tables recomputed, so only the edit under test can fail. */
function nodesOf(document: ScreenDocumentV2, name: 'ready' | string): ScreenNodeV2[] {
    const out: ScreenNodeV2[] = []
    for (const entry of variantsOfV2(document)) {
        if (entry.name !== name) continue
        visitVariantNodesV2(entry.variant, entry.prefix, ({ node }) => out.push(node))
    }
    return out
}

const literalsOf = (document: ScreenDocumentV2, name: string): string[] =>
    nodesOf(document, name).flatMap((node) =>
        nodeTextRefsV2(node).flatMap((ref) => (ref.kind === 'literal' ? [ref.text] : [])),
    )
const intentsIn = (document: ScreenDocumentV2, name: string): string[] => {
    const entry = variantsOfV2(document).find((variant) => variant.name === name)
    if (!entry) return []
    const out = nodesOf(document, name).flatMap(nodeIntentsV2)
    return [
        ...out,
        ...(entry.variant.header.back ? [entry.variant.header.back.intent] : []),
        ...entry.variant.header.actions.map((action) => action.intent),
    ].map((intent) => `${intent.intent}/${intent.target}`)
}

describe('1 reading cancellation confirmation', () => {
    const witnessed = inputsFor('reading', { ...baseUi, reading: WITNESS })

    it('requires a full authored confirming variant with exactly Keep and Stop, only with the witness', () => {
        const document = compose(witnessed)
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(document.requirements.confirm).toEqual([
            { intent: 'navigate', target: 'pages' },
            { intent: 'navigate', target: 'reading' },
        ])
        const confirming = document.states.confirming
        expect(confirming).not.toBeNull()
        expect(confirming!.header.back).toBeNull()
        expect(confirming!.bar.primary.label).toBe('Keep reading')
        expect(confirming!.bar.primary.intent).toEqual({ intent: 'navigate', target: 'reading' })
        expect(confirming!.bar.secondary?.label).toBe('Stop reading')
        expect(confirming!.bar.secondary?.intent).toEqual({ intent: 'navigate', target: 'pages' })
        expect([...new Set(intentsIn(document, 'confirming'))].sort()).toEqual(['navigate/pages', 'navigate/reading'])
        expect(verifyDocumentAgainstInputsV2(document, witnessed, sha256Hex)).toEqual([])
        // The reading screen's other variants never offer Keep.
        for (const name of ['ready', 'busy', 'pending', 'error', 'recovery']) {
            expect(intentsIn(document, name)).not.toContain('navigate/reading')
        }
        expect(requiredStatesV2('reading', document.requirements)).toContain('confirming')
    })

    it('has no confirming variant, and refuses Keep, without the witness', () => {
        const plain = inputsFor('reading', baseUi)
        const document = compose(plain)
        expect(document.states.confirming).toBeNull()
        expect(document.requirements.confirm).toEqual([])
        expect(intentAllowedV2({ intent: 'navigate', target: 'reading' }, documentMaterialV2(plain))).toBe(false)
        expect(intentAllowedV2({ intent: 'navigate', target: 'reading' }, documentMaterialV2(witnessed))).toBe(true)
        // A confirming variant claimed without the witness is rejected.
        const forged = { ...document, states: { ...document.states, confirming: compose(witnessed).states.confirming } }
        expect(screenDocumentV2Schema.safeParse(forged).success).toBe(false)
    })

    it('is bound into the context key and rejects a confirming variant that offers more than Stop and Keep', () => {
        expect(screenContextJsonV2(witnessed)).not.toBe(screenContextJsonV2(inputsFor('reading', baseUi)))
        const document = compose(witnessed)
        const confirming = document.states.confirming!
        const extra = {
            ...document,
            states: {
                ...document.states,
                confirming: {
                    ...confirming,
                    header: {
                        ...confirming.header,
                        actions: [
                            {
                                label: 'More',
                                icon: 'more' as const,
                                intent: { intent: 'navigate' as const, target: 'more' as const },
                            },
                        ],
                    },
                },
            },
        }
        expect(screenDocumentV2Schema.safeParse(extra).success).toBe(false)
        const missing = { ...document, states: { ...document.states, confirming: null } }
        expect(screenDocumentV2Schema.safeParse(missing).success).toBe(false)
    })
})

describe('2 busy activity witness', () => {
    it('authors the busy variant from the activity and binds the activity into the key', () => {
        const copy: Record<string, string> = {
            'second-opinion': 'Taking a closer look…',
            'question-waiting': 'Still thinking…',
            checking: 'Checking your photo…',
            asking: 'Asking…',
            saving: 'Saving…',
            working: 'Working…',
            reading: 'Reading your manual. This can take a minute.',
        }
        expect([...BUSY_ACTIVITIES_V2].sort()).toEqual(Object.keys(copy).sort())
        const keys = new Set<string>()
        for (const activity of BUSY_ACTIVITIES_V2) {
            const inputs = inputsFor('result', { ...baseUi, busy: { activity } })
            keys.add(screenContextJsonV2(inputs))
            const document = compose(inputs)
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            expect(literalsOf(document, 'busy')).toContain(copy[activity])
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        }
        expect(keys.size).toBe(BUSY_ACTIVITIES_V2.length)
    })

    it('rejects busy copy for another activity and ignores the witness where it is not used', () => {
        const second = inputsFor('result', { ...baseUi, busy: { activity: 'second-opinion' } })
        const checking = inputsFor('result', { ...baseUi, busy: { activity: 'checking' } })
        expect(verifyDocumentAgainstInputsV2(compose(checking), second, sha256Hex).join()).toContain(
            'literal_not_listed',
        )
        const a = inputsFor('error', { ...baseUi, busy: { activity: 'checking' } })
        const b = inputsFor('error', baseUi)
        expect(screenContextJsonV2(a)).toBe(screenContextJsonV2(b))
    })
})

describe('3 header More and the More document', () => {
    it('the client rejects app-owned text outside its available screen bindings', () => {
        const inputs = inputsFor('home')
        const document = compose(inputs)
        document.header.title = { kind: 'bound', key: 'step-title' }
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toContain('bound_unavailable')
        document.header.title = { kind: 'literal', text: 'Your manuals' }
        document.body = {
            type: 'Text',
            content: { kind: 'bound', key: 'storage-summary' },
            role: 'body',
            emphasis: 'normal',
            tone: 'neutral',
            align: 'start',
        }
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toContain('bound_unavailable')
    })
    const moreKinds: ScreenKindV2[] = [
        'home',
        'add',
        'pages',
        'quick-check',
        'guide',
        'result',
        'answer',
        'recovery',
        'completion',
    ]

    it('authors a header More where the app previously had one and nowhere it must not', () => {
        for (const kind of SCREEN_KINDS_V2) {
            const document = compose(inputsFor(kind))
            const has = document.header.actions.some((action) => action.intent.target === 'more')
            expect(has, kind).toBe(moreKinds.includes(kind))
        }
    })

    it('restores privacy, settings, how it works and language on More with bound text only', () => {
        const inputs = inputsFor('more')
        const document = compose(inputs)
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        const nodes = nodesOf(document, 'ready')
        const bound = new Set(
            nodes.flatMap((node) => nodeTextRefsV2(node).flatMap((ref) => (ref.kind === 'bound' ? [ref.key] : []))),
        )
        for (const key of [
            'privacy-stay',
            'privacy-read',
            'privacy-check',
            'privacy-ask',
            'privacy-camera',
            'privacy-library',
            'privacy-once',
            'storage-summary',
            'storage-note',
            'help-scan',
            'help-look',
            'help-next',
            'help-ask',
        ] as const) {
            expect(BOUND_TEXT_KEYS).toContain(key)
            expect(bound.has(key), key).toBe(true)
        }
        expect(
            nodes.some(
                (node) =>
                    node.type === 'Choice' && node.options.mode === 'bound' && node.options.binding === 'language',
            ),
        ).toBe(true)
        const titles = literalsOf(document, 'ready')
        for (const title of ['Privacy', 'Settings', 'How it works']) expect(titles).toContain(title)
    })

    it('keeps the language/settings fields in the key and omits sections the app does not have', () => {
        const withLanguage = screenContextJsonV2(inputsFor('more'))
        expect(withLanguage).not.toBe(screenContextJsonV2(inputsFor('more', { ...baseUi, language: null })))
        expect(withLanguage).not.toBe(screenContextJsonV2(inputsFor('more', { ...baseUi, settings: null })))
        // Presence only: the saved-build count is live bound text, never part of the key.
        expect(withLanguage).toBe(screenContextJsonV2(inputsFor('more', { ...baseUi, pages: null, capture: null })))
        const bare = compose(inputsFor('more', { sections: ['about-this-check'] }))
        const keys = nodesOf(bare, 'ready').flatMap((node) =>
            nodeTextRefsV2(node).flatMap((ref) => (ref.kind === 'bound' ? [ref.key] : [])),
        )
        expect(keys.some((key) => key.startsWith('help-') || key.startsWith('storage-'))).toBe(false)
        expect(keys).toContain('privacy-read')
    })

    it('states the privacy line on pages and add', () => {
        for (const kind of ['pages', 'add'] as const) {
            const keys = nodesOf(compose(inputsFor(kind)), 'ready').flatMap((node) =>
                nodeTextRefsV2(node).flatMap((ref) => (ref.kind === 'bound' ? [ref.key] : [])),
            )
            expect(keys, kind).toContain('privacy-stay')
        }
    })
})

describe('4 held result: pending keeps the photo and never shows the verdict', () => {
    it('does not let a held pass leak a success icon or done checklist into a waiting variant', () => {
        const inputs: ScreenContextInputsV2 = {
            ...inputsFor('result'),
            result: { kind: 'check', value: createHeroResponse('correct') },
        }
        const document = compose(inputs)
        const pending = document.states.pending!
        pending.body = {
            type: 'Stack',
            gap: 'sm',
            align: 'stretch',
            children: [
                pending.body,
                { type: 'Icon', name: 'check', tone: 'success', size: 'md' },
                { type: 'Checklist', items: [{ label: { kind: 'fact', factId: 'result:verdict' }, state: 'done' }] },
            ],
        }
        expect(
            earnedStateIssuesV2(document, documentMaterialV2(inputs)).some((issue) => issue.endsWith(':icon_unearned')),
        ).toBe(true)
        expect(
            earnedStateIssuesV2(document, documentMaterialV2(inputs)).some((issue) =>
                issue.endsWith(':checklist_done_unearned'),
            ),
        ).toBe(true)
    })
    it('a verdict banner that hides its reason does not discharge the required witnessed explanation', () => {
        const document = compose(inputsFor('result'))
        const verdict = nodesOf(document, 'ready').find((node) => node.type === 'VerdictCard')
        if (verdict?.type !== 'VerdictCard') throw new Error('expected composed verdict')
        verdict.showReason = false
        const checked = screenDocumentV2Schema.safeParse(document)
        expect(checked.success).toBe(false)
        if (!checked.success)
            expect(
                checked.error.issues.some(
                    (issue) => issue.message === 'A required fact is missing from the ready variant',
                ),
            ).toBe(true)
    })
    it('binds a question photo before an answer exists and changes identity for another held photo', () => {
        const questions = inputsFor('questions')
        const first = compose(questions)
        expect(first.bound.captureId).toBe('cap-1')
        const secondInputs = {
            ...questions,
            captureId: 'cap-2',
            uiState: { ...baseUi, capture: { ...baseUi.capture!, captureId: 'cap-2' } },
        }
        const second = compose(secondInputs)
        expect(second.bound.captureId).toBe('cap-2')
        expect(second.bound.contextKey).not.toBe(first.bound.contextKey)
        expect(verifyDocumentAgainstInputsV2(first, secondInputs, sha256Hex)).toContain('bound_mismatch')
        expect(
            compose({ ...questions, captureId: null, uiState: { ...baseUi, capture: null } }).bound.captureId,
        ).toBeNull()
    })
    const result = inputsFor('result')

    it('requires the capture image in ready, busy and pending, calm header, no verdict', () => {
        const document = compose(result)
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(document.requirements.capture).toBe(true)
        for (const name of ['ready', 'busy', 'pending']) {
            expect(
                nodesOf(document, name).some((node) => node.type === 'Image' && node.source.kind === 'capture'),
                name,
            ).toBe(true)
        }
        for (const name of ['busy', 'pending'] as const) {
            const variant = document.states[name]!
            expect(
                nodesOf(document, name).some((node) => node.type === 'VerdictCard'),
                name,
            ).toBe(false)
            expect(JSON.stringify(variant)).not.toContain('result:')
            expect(JSON.stringify(variant.header)).not.toMatch(/Looks right|Not quite right|Cannot tell yet/u)
            expect(variant.header.title.kind).toBe('literal')
        }
        // The verdict stays in ready, error and recovery; none of them carries a live camera.
        expect(nodesOf(document, 'ready').some((node) => node.type === 'VerdictCard')).toBe(true)
        for (const name of ['error', 'recovery']) {
            expect(
                nodesOf(document, name).some((node) => node.type === 'CameraView'),
                name,
            ).toBe(false)
        }
        expect(verifyDocumentAgainstInputsV2(document, result, sha256Hex)).toEqual([])
    })

    it('rejects a pending variant that drops the photo or exposes the verdict', () => {
        const document = compose(result)
        const pending = document.states.pending!
        const dropPhoto = (node: ScreenNodeV2): ScreenNodeV2 =>
            'children' in node
                ? { ...node, children: node.children.filter((child) => !(child.type === 'Image')).map(dropPhoto) }
                : node
        const noPhoto = {
            ...document,
            states: { ...document.states, pending: { ...pending, body: dropPhoto(pending.body) } },
        }
        expect(screenDocumentV2Schema.safeParse(noPhoto).success).toBe(false)
        const verdict = {
            ...document,
            states: {
                ...document.states,
                pending: {
                    ...pending,
                    body: {
                        type: 'Stack' as const,
                        gap: 'md' as const,
                        align: 'stretch' as const,
                        children: [
                            pending.body,
                            {
                                type: 'VerdictCard' as const,
                                result: 'check' as const,
                                variant: 'card' as const,
                                showReason: true,
                                showRegions: true,
                            },
                        ],
                    },
                },
            },
        }
        expect(screenDocumentV2Schema.safeParse(verdict).success).toBe(false)
    })

    it('never gives a guide or a held-nothing screen a photo', () => {
        const guide = inputsFor('guide')
        const document = compose(guide)
        expect(document.requirements.capture).toBe(false)
        expect(documentMaterialV2(inputsFor('result', { ...baseUi })).requirements.capture).toBe(true)
        const withPhoto = {
            ...document,
            body: {
                type: 'Stack' as const,
                gap: 'md' as const,
                align: 'stretch' as const,
                children: [
                    document.body,
                    {
                        type: 'Image' as const,
                        source: { kind: 'capture' as const },
                        fit: 'cover' as const,
                        ratio: 'wide' as const,
                        caption: null,
                    },
                ],
            },
        }
        expect(verifyDocumentAgainstInputsV2(withPhoto, guide, sha256Hex)).toContain('capture_unwitnessed')
    })

    it('holds the same for an answer', () => {
        const document = compose(inputsFor('answer'))
        expect(document.requirements.capture).toBe(true)
        expect(nodesOf(document, 'pending').some((node) => node.type === 'Image')).toBe(true)
        expect(nodesOf(document, 'pending').some((node) => node.type === 'VerdictCard')).toBe(false)
    })
})

describe('5 requestedKinds on precompute', () => {
    const session = createDemoManual()
    const precompute = (extra: Record<string, unknown>): ReturnType<typeof modelScreensV2MetadataSchema.safeParse> => {
        const generate = screensV2GenerateRequest('req-1', inputsFor('guide', undefined, session), sha256Hex)
        return modelScreensV2MetadataSchema.safeParse({
            ...generate,
            op: 'precompute',
            kind: null,
            stepId: null,
            captureId: null,
            contextKey: null,
            ...extra,
        })
    }

    it('accepts a finite strict allowlist on precompute and defaults to the existing full set', () => {
        expect(precompute({}).success).toBe(true)
        const parsed = precompute({ requestedKinds: ['guide'] })
        expect(parsed.success).toBe(true)
        expect(precompute({ requestedKinds: ['guide', 'reading'] }).success).toBe(true)
    })

    it('rejects unknown, duplicate and empty lists, and a list on a single-screen request', () => {
        expect(precompute({ requestedKinds: ['more'] }).success).toBe(false)
        expect(precompute({ requestedKinds: ['guide', 'guide'] }).success).toBe(false)
        expect(precompute({ requestedKinds: [] }).success).toBe(false)
        const generate = screensV2GenerateRequest('req-1', inputsFor('guide', undefined, session), sha256Hex)
        expect(modelScreensV2MetadataSchema.safeParse({ ...generate, requestedKinds: ['guide'] }).success).toBe(false)
    })
})

describe('6 manual display title', () => {
    const named = (patch: Partial<ManualSession>): ManualSession => ({ ...createDemoManual(), ...patch })

    it('keeps a saved title and derives a stable description only for a blank or Untitled one', () => {
        expect(manualDisplayTitleV2(named({ title: '  Garden bench  ' }))).toBe('Garden bench')
        const first = createDemoManual().reviewedSteps[0]!.title.trim()
        for (const title of ['', '   ', 'Untitled', 'untitled manual', 'Untitled build']) {
            expect(manualDisplayTitleV2(named({ title }))).toBe(first)
        }
        expect(manualDisplayTitleV2(named({ title: '' }))).toBe(manualDisplayTitleV2(named({ title: 'Untitled' })))
    })

    it('falls back to known part names, then the page count, never an invented product', () => {
        const base = createDemoManual()
        const noSteps = named({ title: '', reviewedSteps: [], rawExtraction: null })
        const parts = noSteps.parts
            .flatMap((part) => (part.name.state === 'known' ? [part.name.value] : []))
            .slice(0, 2)
        expect(manualDisplayTitleV2(noSteps)).toBe(
            parts.length > 0 ? parts.join(' · ') : `${base.pages.length} page manual`,
        )
        expect(manualDisplayTitleV2(named({ title: '', reviewedSteps: [], rawExtraction: null, parts: [] }))).toBe(
            `${base.pages.length} page manual`,
        )
    })
})
