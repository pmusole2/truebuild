import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    INTENT_TARGETS,
    SCREEN_KINDS_V2,
    TEXT_FIELD_BINDINGS,
    TOGGLE_BINDINGS,
    assembleDocumentV2,
    availableBoundKeysV2,
    coachTargetsForV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    intentAllowedV2,
    nodeIntentsV2,
    nodeTextRefsV2,
    screenContextJsonV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
    type ScreenVariantV2,
} from './index'
import { createHeroResponse } from './hero'

// Regression cases for the ten integration closures (notice, tips, quick-check figure, camera spine, back, home coach
// order, tooltip-only overlays). Each fails on the source before the integration pass.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }
const NOTICE = { notice: true } as const
const QUESTION: NonNullable<NonNullable<ScreenUiStateV2['review']>['currentQuestion']> = {
    questionId: 'q1',
    kind: 'orientation',
    stepId: 'step-1',
    stepOrder: 1,
    reason: 'Check this.',
    parts: [],
}

const baseUi: ScreenUiStateV2 = {
    library: {
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
        ],
        soleManualId: 'demo-divider',
    },
    pages: {
        items: [{ pageId: 'demo-page-1', width: 1200, height: 900 }],
        maxPages: 20,
        canRead: true,
        languageOptions: ['en', 'es'],
    },
    review: { currentQuestion: QUESTION, blockers: 0, canConfirm: true },
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['how-it-works', 'settings', 'about-this-check', 'tips'],
    language: { options: ['en', 'es'] },
    settings: { storage: true },
    camera: { mode: 'build-photo', permission: 'granted' },
    judge: { builtView: false },
}

const SESSIONLESS: readonly ScreenKindV2[] = ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare']
const STEP_BOUND: readonly ScreenKindV2[] = ['guide', 'result', 'questions', 'answer', 'recovery', 'camera']

function inputsFor(
    kind: ScreenKindV2,
    uiState: ScreenUiStateV2 = baseUi,
    session: ManualSession = createDemoManual(),
): ScreenContextInputsV2 {
    const base: ScreenContextInputsV2 = {
        kind,
        session: SESSIONLESS.includes(kind) ? null : session,
        stepId: STEP_BOUND.includes(kind) ? 'step-1' : null,
        captureId: ['result', 'answer', 'questions'].includes(kind) ? 'cap-1' : null,
        result: null,
        failure: kind === 'error' ? 'timeout' : null,
        uiState,
    }
    return kind === 'result' ? { ...base, result: { kind: 'check', value: createHeroResponse('reversed') } } : base
}

interface Built {
    material: ReturnType<typeof documentMaterialV2>
    document: ScreenDocumentV2
    schema: string[]
    verify: string[]
}

/** Composes, optionally edits the PROPOSAL, republishes with recomputed tables, and reports every rule that fires. */
function build(inputs: ScreenContextInputsV2, edit?: (proposal: ScreenProposalV2) => ScreenProposalV2): Built {
    const material = documentMaterialV2(inputs)
    const composed = buildFallbackProposalV2(material)
    const proposal = edit ? edit(composed) : composed
    const document = assembleDocumentV2(
        material,
        proposal,
        { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
        deps,
    )
    const parsed = screenDocumentV2Schema.safeParse(document)
    return {
        material,
        document,
        schema: parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
        verify: verifyDocumentAgainstInputsV2(document, inputs, sha256Hex),
    }
}
const fallbackFor = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })

const nodesOf = (variant: ScreenVariantV2, prefix = ''): ScreenNodeV2[] => {
    const out: ScreenNodeV2[] = []
    visitVariantNodesV2(variant, prefix, ({ node }) => out.push(node))
    return out
}
const variantOf = (document: ScreenDocumentV2, name: string): ScreenVariantV2 =>
    variantsOfV2(document).find((entry) => entry.name === name)!.variant
const noticeCount = (variant: ScreenVariantV2): number =>
    nodesOf(variant)
        .flatMap(nodeTextRefsV2)
        .filter((ref) => ref.kind === 'bound' && ref.key === 'operation-notice').length
const noticeText: ScreenNodeV2 = {
    type: 'Text',
    content: { kind: 'bound', key: 'operation-notice' },
    role: 'body',
    emphasis: 'normal',
    tone: 'neutral',
    align: 'start',
}
/** The tree without any node of this type (containers keep their other children). */
const dropNodes = (node: ScreenNodeV2, type: ScreenNodeV2['type']): ScreenNodeV2 =>
    'children' in node
        ? {
              ...node,
              children: node.children.filter((child) => child.type !== type).map((child) => dropNodes(child, type)),
          }
        : node
const stackOf = (children: ScreenNodeV2[]): ScreenNodeV2 => ({ type: 'Stack', gap: 'md', align: 'stretch', children })
const withState = (
    proposal: ScreenProposalV2,
    name: keyof ScreenProposalV2['states'],
    patch: Partial<ScreenVariantV2>,
): ScreenProposalV2 => ({
    ...proposal,
    states: { ...proposal.states, [name]: { ...proposal.states[name]!, ...patch } },
})

describe('1 operation notice', () => {
    const witnessed = (kind: 'error' | 'recovery' | 'reading'): ScreenContextInputsV2 =>
        inputsFor(kind, { ...baseUi, failure: NOTICE })

    it.each([
        ['error', ['ready', 'error', 'recovery']],
        ['recovery', ['ready', 'error', 'recovery']],
        ['reading', ['error', 'recovery']],
    ] as const)('%s states the bound notice exactly once where a failure is shown, and nowhere else', (kind, shown) => {
        const built = build(witnessed(kind))
        expect(built.material.requirements.notice).toBe(true)
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        for (const entry of variantsOfV2(built.document)) {
            expect(noticeCount(entry.variant), `${kind} ${entry.name}`).toBe(
                (shown as readonly string[]).includes(entry.name) ? 1 : 0,
            )
        }
    })

    it('is an available bound key only with the witness on error, recovery and reading', () => {
        for (const kind of ['error', 'recovery', 'reading', 'guide', 'home'] as const) {
            const keys = availableBoundKeysV2(documentMaterialV2(inputsFor(kind, { ...baseUi, failure: NOTICE })))
            const without = availableBoundKeysV2(documentMaterialV2(inputsFor(kind)))
            expect(without, kind).not.toContain('operation-notice')
            expect(keys.includes('operation-notice'), kind).toBe(['error', 'recovery', 'reading'].includes(kind))
        }
    })

    it('is part of the context key for error, recovery and reading, and not for a guide', () => {
        for (const kind of ['error', 'recovery', 'reading'] as const) {
            expect(screenContextJsonV2(witnessed(kind)), kind).not.toBe(screenContextJsonV2(inputsFor(kind)))
        }
        expect(screenContextJsonV2(inputsFor('guide', { ...baseUi, failure: NOTICE }))).toBe(
            screenContextJsonV2(inputsFor('guide')),
        )
        expect(documentMaterialV2(inputsFor('recovery')).requirements.notice).toBe(false)
    })

    it('rejects a document that omits, duplicates or misplaces the notice', () => {
        const inputs = witnessed('recovery')
        const missing = build(inputs, (proposal) => withState(proposal, 'error', { body: stackOf([]) }))
        expect(missing.schema.join()).toMatch(/notice/iu)
        const twice = build(inputs, (proposal) => ({ ...proposal, body: stackOf([proposal.body, noticeText]) }))
        expect(twice.schema.join()).toMatch(/notice/iu)
        const busy = build(inputs, (proposal) =>
            withState(proposal, 'busy', { body: stackOf([proposal.states.busy!.body, noticeText]) }),
        )
        expect(busy.schema.join()).toMatch(/notice/iu)
        const reading = witnessed('reading')
        const early = build(reading, (proposal) => ({ ...proposal, body: stackOf([proposal.body, noticeText]) }))
        expect(early.schema.join()).toMatch(/notice/iu)
    })

    it('does not accept the notice without the witness, or outside Text.content', () => {
        const unwitnessed = build(inputsFor('recovery'), (proposal) => ({
            ...proposal,
            body: stackOf([proposal.body, noticeText]),
        }))
        expect(unwitnessed.schema.join()).toMatch(/notice/iu)
        expect(unwitnessed.verify).toContain('bound_unavailable')
        const header = screenProposalV2Schema.safeParse({
            ...buildFallbackProposalV2(documentMaterialV2(witnessed('error'))),
            header: {
                title: { kind: 'bound', key: 'operation-notice' },
                subtitle: null,
                back: null,
                actions: [],
            },
        })
        expect(header.success).toBe(false)
    })
})

describe('2 tips replay and the judge flag', () => {
    it('more offers a Show tips again action, not a tips toggle', () => {
        const document = fallbackFor(inputsFor('more'))
        const ready = nodesOf(document)
        expect(ready.some((node) => node.type === 'Toggle')).toBe(false)
        const action = ready.find((node) => node.type === 'SecondaryAction' && node.intent.intent === 'show-tips')
        expect(action).toMatchObject({ label: 'Show tips again', intent: { intent: 'show-tips', target: 'screen' } })
        expect(verifyDocumentAgainstInputsV2(document, inputsFor('more'), sha256Hex)).toEqual([])
    })

    it('offers it only where the app has the tips section', () => {
        const without = inputsFor('more', { ...baseUi, sections: ['settings'] })
        expect(intentAllowedV2({ intent: 'show-tips', target: 'screen' }, documentMaterialV2(without))).toBe(false)
        expect(intentAllowedV2({ intent: 'show-tips', target: 'screen' }, documentMaterialV2(inputsFor('more')))).toBe(
            true,
        )
        expect(
            nodesOf(fallbackFor(without)).some((node) => nodeIntentsV2(node).some((i) => i.intent === 'show-tips')),
        ).toBe(false)
    })

    it('rejects the unimplemented tips toggle and fact-answer text field bindings', () => {
        expect(TOGGLE_BINDINGS).toEqual(['built-view'])
        expect(TEXT_FIELD_BINDINGS).toEqual(['question'])
        const proposal = buildFallbackProposalV2(documentMaterialV2(inputsFor('more')))
        const tips = screenProposalV2Schema.safeParse({
            ...proposal,
            body: stackOf([
                { type: 'Toggle', binding: 'tips', label: { kind: 'literal', text: 'Show tips' } } as never,
            ]),
        })
        expect(tips.success).toBe(false)
        const field = screenProposalV2Schema.safeParse({
            ...proposal,
            body: stackOf([
                {
                    type: 'TextField',
                    binding: 'fact-answer',
                    label: { kind: 'literal', text: 'Your question' },
                    placeholder: null,
                } as never,
            ]),
        })
        expect(field.success).toBe(false)
    })

    it('a generated judge must carry the built-view toggle as well as the panel', () => {
        const inputs = inputsFor('judge')
        const material = documentMaterialV2(inputs)
        expect(material.requirements.nodes).toEqual(expect.arrayContaining(['JudgePanel', 'Toggle']))
        expect(build(inputs).schema).toEqual([])
        const built = build(inputs, (proposal) => ({ ...proposal, body: dropNodes(proposal.body, 'Toggle') }))
        expect(built.schema.join()).toMatch(/Toggle/u)
    })
})

describe('3 quick-check source picture', () => {
    const quick = (patch: Partial<ScreenUiStateV2> = {}, session = createDemoManual()): ScreenContextInputsV2 =>
        inputsFor('quick-check', { ...baseUi, ...patch }, session)
    const figureNode = (document: ScreenDocumentV2, index: number): ScreenNodeV2 | undefined =>
        nodesOf(variantOf(document, 'ready')).find(
            (node) => node.type === 'Image' && node.source.kind === 'source' && node.source.index === index,
        )

    it('shows the question step own source as an exact source Image and requires it', () => {
        const built = build(quick())
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        const index = built.material.requirements.figure
        expect(index).not.toBeNull()
        expect(built.document.sources[index!]).toEqual({ pageId: 'demo-page-1', region: null })
        expect(figureNode(built.document, index!)).toBeDefined()
        expect(built.material.step).toBeNull()
        expect(built.document.bound.stepId).toBeNull()
        expect(built.document.facts).toEqual([])
        expect(availableBoundKeysV2(built.material)).not.toContain('step-title')
        const dropped = build(quick(), (proposal) => ({ ...proposal, body: dropNodes(proposal.body, 'Image') }))
        expect(dropped.schema.join()).toMatch(/source picture|figure/iu)
    })

    it('uses the raw extraction step of an unreviewed manual', () => {
        const raw = createDemoManual()
        const unreviewed = { ...raw, reviewStatus: 'unreviewed', reviewedSteps: [] } as ManualSession
        const built = build(quick({}, unreviewed))
        expect(built.material.requirements.figure).not.toBeNull()
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
    })

    it('copies the exact region of the step source, never a geometry of its own', () => {
        const session = createDemoManual()
        const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }
        session.reviewedSteps[0]!.sourceRefs = [{ pageId: 'demo-page-1', region }]
        const built = build(quick({}, session))
        expect(built.document.sources[built.material.requirements.figure!]).toEqual({ pageId: 'demo-page-1', region })
    })

    it.each([
        [
            'an unknown page',
            (step: ManualSession['reviewedSteps'][number]): void => {
                step.sourceRefs = [{ pageId: 'ghost', region: null }]
            },
        ],
        [
            'no source at all',
            (step: ManualSession['reviewedSteps'][number]): void => {
                step.sourceRefs = []
            },
        ],
    ])('says so honestly when the step has %s (no invented figure)', (_name, mutate) => {
        const session = createDemoManual()
        mutate(session.reviewedSteps[0]!)
        const built = build(quick({}, session))
        expect(built.material.requirements.figure).toBeNull()
        expect(built.document.sources.some((source) => source.pageId === 'ghost')).toBe(false)
        const ready = nodesOf(variantOf(built.document, 'ready'))
        expect(ready.some((node) => node.type === 'Image')).toBe(false)
        expect(ready.flatMap(nodeTextRefsV2)).toContainEqual({
            kind: 'literal',
            text: 'No picture to show for this detail.',
        })
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
    })

    it('lists that wording only when the picture is really missing', () => {
        const built = build(quick(), (proposal) => ({
            ...proposal,
            body: stackOf([
                proposal.body,
                {
                    ...(noticeText as ScreenNodeV2 & { type: 'Text' }),
                    content: { kind: 'literal', text: 'No picture to show for this detail.' },
                },
            ]),
        }))
        expect(built.verify).toContain('literal_not_listed')
    })

    it('asks for nothing without a question or when the step is unknown', () => {
        const none = build(quick({ review: { currentQuestion: null, blockers: 0, canConfirm: false } }))
        expect(none.material.requirements.figure).toBeNull()
        expect(nodesOf(variantOf(none.document, 'ready')).some((node) => node.type === 'Image')).toBe(false)
        const stale = build(
            quick({
                review: { currentQuestion: { ...QUESTION, stepId: 'step-missing' }, blockers: 0, canConfirm: true },
            }),
        )
        expect(stale.material.requirements.figure).toBeNull()
        expect(stale.schema).toEqual([])
    })

    it('the context key already covers the sources of every step', () => {
        const session = createDemoManual()
        const before = screenContextJsonV2(quick({}, session))
        session.reviewedSteps[0]!.sourceRefs = [
            { pageId: 'demo-page-1', region: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        ]
        expect(screenContextJsonV2(quick({}, session))).not.toBe(before)
    })
})

describe('4 camera ready: busy and pending keep the camera mounted', () => {
    const camera = (patch: Partial<NonNullable<ScreenUiStateV2['camera']>> = {}): ScreenContextInputsV2 =>
        inputsFor('camera', { ...baseUi, camera: { mode: 'build-photo', permission: 'granted', ...patch } })
    const spine = (variant: ScreenVariantV2): string[] => {
        const path: string[] = []
        const walk = (node: ScreenNodeV2, trail: string[]): boolean => {
            if (node.type === 'CameraView') {
                path.push(...trail)
                return true
            }
            return (
                'children' in node && node.children.some((child, at) => walk(child, [...trail, `${node.type}.${at}`]))
            )
        }
        return walk(variant.body, []) ? path : ['none']
    }

    it('ready, busy and pending hold the CameraView at one spine, first in its stack', () => {
        const document = fallbackFor(camera())
        const ready = spine(variantOf(document, 'ready'))
        expect(ready).toEqual(['Scroll.0', 'Stack.0'])
        expect(spine(variantOf(document, 'busy'))).toEqual(ready)
        expect(spine(variantOf(document, 'pending'))).toEqual(ready)
        expect(build(camera()).schema).toEqual([])
        expect(verifyDocumentAgainstInputsV2(document, camera(), sha256Hex)).toEqual([])
    })

    it('pending keeps an enabled authored Take photo primary, busy is a disabled-style Working', () => {
        const document = fallbackFor(camera())
        expect(document.states.pending!.bar.primary).toMatchObject({
            label: 'Take photo',
            intent: { intent: 'capture', target: 'take-photo' },
        })
        expect(document.states.busy!.bar.primary.label).toBe('Preparing camera…')
        expect(document.states.busy!.bar.primary.intent).toEqual({ intent: 'capture', target: 'take-photo' })
        const saving = fallbackFor({
            ...camera(),
            uiState: {
                ...baseUi,
                camera: { mode: 'build-photo', permission: 'granted' },
                busy: { activity: 'saving' },
            },
        })
        expect(saving.states.busy!.bar.primary.label).toBe('Saving…')
    })

    it('rejects a waiting variant that drops, moves or blocks the camera', () => {
        const dropped = build(camera(), (proposal) =>
            withState(proposal, 'busy', {
                body: { type: 'Scroll', axis: 'vertical', children: [stackOf([noticeText])] },
            }),
        )
        expect(dropped.schema.join()).toMatch(/CameraView/u)
        const moved = build(camera(), (proposal) =>
            withState(proposal, 'pending', {
                body: {
                    type: 'Scroll',
                    axis: 'vertical',
                    children: [
                        {
                            type: 'Card',
                            surface: 'plain',
                            tone: 'neutral',
                            padding: 'md',
                            children: nodesOf(proposal.states.pending!).filter((node) => node.type === 'CameraView'),
                        },
                    ],
                },
            }),
        )
        expect(moved.schema.join()).toMatch(/camera/iu)
        const blocked = build(camera(), (proposal) =>
            withState(proposal, 'pending', {
                bar: {
                    primary: {
                        ...proposal.states.pending!.bar.primary,
                        label: 'Preparing step…',
                        intent: { intent: 'navigate', target: 'guide' },
                    },
                    secondary: null,
                },
            }),
        )
        expect(blocked.schema.join()).toMatch(/action/iu)
    })

    it('error and recovery never hold a camera, and a camera that cannot run holds none anywhere', () => {
        const document = fallbackFor(camera())
        for (const name of ['error', 'recovery']) {
            expect(
                nodesOf(variantOf(document, name)).some((node) => node.type === 'CameraView'),
                name,
            ).toBe(false)
        }
        for (const patch of [{ permission: 'denied' as const }, { failed: true }]) {
            const blocked = fallbackFor(camera(patch))
            for (const entry of variantsOfV2(blocked)) {
                expect(
                    nodesOf(entry.variant).some((node) => node.type === 'CameraView'),
                    entry.name,
                ).toBe(false)
            }
        }
    })
})

describe('5 navigate/back', () => {
    it('is a finite navigate target', () => {
        expect(INTENT_TARGETS.navigate).toContain('back')
    })

    it('every authored header back is navigate/back, except home, and the confirmation has none', () => {
        const confirming = inputsFor('reading', { ...baseUi, reading: { cancellation: 'confirm-before-stop' } })
        for (const kind of SCREEN_KINDS_V2) {
            const document = fallbackFor(inputsFor(kind))
            const back = document.header.back
            if (kind === 'home') expect(back).toBeNull()
            else expect(back, kind).toMatchObject({ intent: { intent: 'navigate', target: 'back' } })
        }
        expect(fallbackFor(confirming).states.confirming!.header.back).toBeNull()
    })

    it('sheet-like kinds close with Close; more, judge and compare lead with it', () => {
        for (const kind of ['more', 'judge', 'compare'] as const) {
            const document = fallbackFor(inputsFor(kind))
            expect(document.header.back).toMatchObject({ label: 'Close', icon: 'close' })
            expect(document.bar.primary, kind).toMatchObject({
                label: 'Close',
                intent: { intent: 'navigate', target: 'back' },
            })
            expect(document.requirements.actions, kind).toEqual([{ intent: 'navigate', target: 'back' }])
        }
        expect(fallbackFor(inputsFor('questions')).header.back).toMatchObject({ label: 'Close' })
        expect(fallbackFor(inputsFor('questions')).bar.primary).toMatchObject({
            intent: { intent: 'ask', target: 'about-step' },
        })
    })

    it('explicit Home stays Home', () => {
        const completion = fallbackFor(inputsFor('completion'))
        expect(completion.bar.primary.intent).toEqual({ intent: 'navigate', target: 'home' })
        expect(completion.requirements.actions).toEqual([{ intent: 'navigate', target: 'home' }])
        expect(fallbackFor(inputsFor('error')).bar.secondary?.intent).toEqual({ intent: 'navigate', target: 'home' })
    })

    it('is not offered on home', () => {
        expect(intentAllowedV2({ intent: 'navigate', target: 'back' }, documentMaterialV2(inputsFor('home')))).toBe(
            false,
        )
        expect(intentAllowedV2({ intent: 'navigate', target: 'back' }, documentMaterialV2(inputsFor('guide')))).toBe(
            true,
        )
    })
})

describe('6 home coach order', () => {
    const targets = (patch: Partial<ScreenUiStateV2>): readonly string[] =>
        coachTargetsForV2(documentMaterialV2(inputsFor('home', { ...baseUi, ...patch })))

    it('leads with the target of the actual primary', () => {
        expect(targets({})).toEqual(['keep-building', 'home-add', 'header-more'])
        expect(targets({ library: { entries: [], soleManualId: null } })).toEqual(['home-add', 'header-more'])
        expect(targets({ library: null })).toEqual(['home-add', 'header-more'])
        const document = fallbackFor(inputsFor('home'))
        expect(document.overlays.map((overlay) => overlay.anchor)).toEqual(['keep-building', 'home-add', 'header-more'])
        expect(document.bar.primary.intent).toEqual({ intent: 'navigate', target: 'guide' })
    })

    it('keeps the other screens in their reading order', () => {
        const order = (kind: ScreenKindV2): readonly string[] => coachTargetsForV2(documentMaterialV2(inputsFor(kind)))
        expect(order('add')).toEqual(['take-page-photo', 'choose-pages'])
        expect(order('pages')).toEqual(['read-manual', 'add-page'])
    })
})

describe('7 overlays are tooltip coach marks only', () => {
    const coach: ScreenNodeV2 = {
        type: 'CoachMark',
        targetId: 'home-add',
        heading: 'Add a manual',
        body: 'Start here to add the manual you are building from.',
        placement: 'auto',
    }
    const withOverlays = (overlays: unknown[]): unknown => ({
        ...buildFallbackProposalV2(documentMaterialV2(inputsFor('home'))),
        overlays,
    })

    it('accepts the tooltip coach mark anchored to its own target', () => {
        expect(
            screenProposalV2Schema.safeParse(withOverlays([{ kind: 'tooltip', anchor: 'home-add', content: coach }]))
                .success,
        ).toBe(true)
    })

    it.each([
        ['a sheet', { kind: 'sheet', anchor: null, content: coach }],
        ['a tooltip without an anchor', { kind: 'tooltip', anchor: null, content: coach }],
        [
            'a tooltip around another node',
            {
                kind: 'tooltip',
                anchor: 'home-add',
                content: {
                    type: 'Text',
                    content: { kind: 'literal', text: 'Home' },
                    role: 'body',
                    emphasis: 'normal',
                    tone: 'neutral',
                    align: 'start',
                },
            },
        ],
    ])('rejects %s', (_name, overlay) => {
        expect(screenProposalV2Schema.safeParse(withOverlays([overlay])).success).toBe(false)
    })

    it('rejects a tooltip whose anchor is not its coach mark target', () => {
        const mismatch = build(inputsFor('home'), (proposal) => ({
            ...proposal,
            overlays: [{ kind: 'tooltip', anchor: 'header-more', content: coach }],
        }))
        expect(mismatch.schema.join()).toMatch(/anchor/iu)
    })
})
