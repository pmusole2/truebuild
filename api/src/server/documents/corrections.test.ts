import {
    buildFallbackProposalV2,
    documentMaterialV2,
    manualSessionSchema,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenVariantV2,
} from '@truebuild/contracts'
import { createHeroResponse } from '@truebuild/contracts/hero'
import { describe, expect, it } from 'vitest'

import { createDocumentFixtureGenerator } from '../../providers/document-fixtures'
import { demoSession, documentInputs, fullUi } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { BackgroundWork } from '../screens/service'
import { buildDocumentContext } from './context'
import { checkProposal } from './ground'
import { createDocumentService, type DocumentService } from './service'

// Regression cases for the independent review of the whole-screen v2 gate and service. They pin the unsafe inputs the
// review proved were accepted, through the same production gate a provider answer takes.

const work: BackgroundWork = {
    run: (_options, job) => job(),
    repair: (job) => job(),
    tryAcquire: () => () => {},
    acquire: async () => () => {},
}
const policyFor = (env: Record<string, string> = {}): ReturnType<typeof aiPolicyFromEnvironment> =>
    aiPolicyFromEnvironment(env, {
        checkTimeoutMs: 8_000,
        parseModel: 'muse-spark-1.3',
        verdictModel: 'muse-spark-1.3',
        secondOpinionModel: 'muse-wonder-1.0',
    })
const serviceFor = (env: Record<string, string> = {}, fixtures = false): DocumentService =>
    createDocumentService({
        provider: null,
        ...(fixtures ? { fixtureGenerator: createDocumentFixtureGenerator() } : {}),
        policy: policyFor(env),
        runtimeMode: 'fixture',
        work,
    })

const withBody = (proposal: ScreenProposalV2, node: ScreenNodeV2): ScreenProposalV2 => ({
    ...proposal,
    body: { type: 'Stack', gap: 'md', align: 'stretch', children: [proposal.body, node] },
})
const text = (content: string): ScreenNodeV2 => ({
    type: 'Text',
    content: { kind: 'literal', text: content },
    role: 'body',
    emphasis: 'normal',
    tone: 'neutral',
    align: 'start',
})
const has = (issues: string[], rule: string): boolean => issues.some((issue) => issue.includes(rule))

describe('every textual field is grounded (finding 1)', () => {
    const FACTUAL = 'Bolts are tight and the panel is flat.'
    const context = buildDocumentContext(documentInputs('guide'))
    const good = buildFallbackProposalV2(context.material)

    it('accepts the deterministic composition', () => {
        expect(checkProposal(good, context)).toEqual([])
    })

    it('rejects factual prose with no digits and a false completion claim', () => {
        const issues = checkProposal(withBody(good, text('This step is complete. The groove faces outward.')), context)
        expect(has(issues, 'literal_not_listed')).toBe(true)
    })

    const slots: [string, ScreenKindV2, ScreenNodeV2][] = [
        ['Badge', 'guide', { type: 'Badge', label: { kind: 'literal', text: FACTUAL }, tone: 'success' }],
        [
            'Image caption',
            'guide',
            {
                type: 'Image',
                source: { kind: 'source', index: 0 },
                fit: 'contain',
                ratio: 'wide',
                caption: { kind: 'literal', text: FACTUAL },
            },
        ],
        [
            'Citation label',
            'guide',
            { type: 'Citation', sources: [0], label: { kind: 'literal', text: FACTUAL }, display: 'chip' },
        ],
        [
            'Checklist label',
            'guide',
            { type: 'Checklist', items: [{ label: { kind: 'literal', text: FACTUAL }, state: 'todo' }] },
        ],
        ['Progress label', 'guide', { type: 'Progress', binding: 'step', label: { kind: 'literal', text: FACTUAL } }],
        [
            'Meter label',
            'guide',
            { type: 'Meter', binding: 'build', label: { kind: 'literal', text: FACTUAL }, tone: 'success' },
        ],
        ['Toggle label', 'judge', { type: 'Toggle', binding: 'built-view', label: { kind: 'literal', text: FACTUAL } }],
        [
            'Choice prompt',
            'guide',
            {
                type: 'Choice',
                prompt: { kind: 'literal', text: FACTUAL },
                options: {
                    mode: 'intents',
                    items: [
                        { label: 'Home', intent: { intent: 'navigate', target: 'home' } },
                        { label: 'More', intent: { intent: 'navigate', target: 'more' } },
                    ],
                },
            },
        ],
        [
            'Section title',
            'guide',
            {
                type: 'Section',
                title: { kind: 'literal', text: FACTUAL },
                collapsible: false,
                initiallyOpen: true,
                children: [text('Safety')],
            },
        ],
        [
            'TextField label',
            'questions',
            { type: 'TextField', binding: 'question', label: { kind: 'literal', text: FACTUAL }, placeholder: null },
        ],
        [
            'TextField placeholder',
            'questions',
            {
                type: 'TextField',
                binding: 'question',
                label: { kind: 'literal', text: 'Your question' },
                placeholder: FACTUAL,
            },
        ],
        [
            'FactEditor label',
            'quick-check',
            { type: 'FactEditor', kind: 'orientation', label: FACTUAL, saveLabel: 'Save', cancelLabel: 'Cancel' },
        ],
        [
            'FactEditor save',
            'quick-check',
            {
                type: 'FactEditor',
                kind: 'orientation',
                label: 'Orientation',
                saveLabel: FACTUAL,
                cancelLabel: 'Cancel',
            },
        ],
        [
            'ManualPage label',
            'guide',
            {
                type: 'ManualPage',
                sources: [0],
                fit: 'contain',
                label: { kind: 'literal', text: FACTUAL },
                initiallyOpen: true,
            },
        ],
    ]
    it.each(slots)('rejects an unlisted literal in a %s', (_slot, kind, node) => {
        const target = buildDocumentContext(documentInputs(kind))
        const proposal = withBody(buildFallbackProposalV2(target.material), node)
        expect(has(checkProposal(proposal, target), 'literal_not_listed')).toBe(true)
    })

    it('rejects an unlisted literal in a header, subtitle and state variant', () => {
        const header = { ...good.header, subtitle: { kind: 'literal' as const, text: FACTUAL } }
        expect(has(checkProposal({ ...good, header }, context), 'literal_not_listed')).toBe(true)
        const busy = good.states.busy!
        const states = { ...good.states, busy: { ...busy, header: { ...busy.header, title: header.subtitle } } }
        expect(has(checkProposal({ ...good, states }, context), 'literal_not_listed')).toBe(true)
    })

    it('does not simply blacklist: a different unsupported phrase fails and a listed one passes', () => {
        expect(has(checkProposal(withBody(good, text('Panel seated correctly')), context), 'literal_not_listed')).toBe(
            true,
        )
        expect(checkProposal(withBody(good, text('Safety')), context)).toEqual([])
    })

    it('binds a done checklist item to an earned witness, not to the model flag', () => {
        const fact = context.material.requirements.facts[0]!
        const done = (state: 'done' | 'todo'): ScreenNodeV2 => ({
            type: 'Checklist',
            items: [{ label: { kind: 'fact', factId: fact }, state }],
        })
        expect(has(checkProposal(withBody(good, done('done')), context), 'checklist_done_unearned')).toBe(true)
        expect(has(checkProposal(withBody(good, done('todo')), context), 'checklist_done_unearned')).toBe(false)
        const icon: ScreenNodeV2 = { type: 'Icon', name: 'check', tone: 'success', size: 'md' }
        expect(has(checkProposal(withBody(good, icon), context), 'icon_unearned')).toBe(true)
    })

    it('lets a witnessed completion and a held pass earn their wording and no more', () => {
        const done = buildDocumentContext({
            ...documentInputs('completion'),
            session: demoSession(),
            completedStepIds: ['step-1', 'step-2'],
        })
        expect(done.material.completion).toBe('witnessed')
        const proposal = buildFallbackProposalV2(done.material)
        expect(checkProposal(proposal, done)).toEqual([])
        const checklist: ScreenNodeV2 = {
            type: 'Checklist',
            items: [{ label: { kind: 'bound', key: 'completion-summary' }, state: 'done' }],
        }
        expect(has(checkProposal(withBody(proposal, checklist), done), 'checklist_done_unearned')).toBe(false)
        const open = buildDocumentContext({ ...documentInputs('completion'), session: demoSession() })
        expect(open.material.completion).toBe('unwitnessed')
        expect(
            has(
                checkProposal(withBody(buildFallbackProposalV2(open.material), checklist), open),
                'checklist_done_unearned',
            ),
        ).toBe(true)
        const refused = buildDocumentContext(documentInputs('result'))
        expect(
            has(
                checkProposal(withBody(buildFallbackProposalV2(refused.material), text('Looks right')), refused),
                'literal_not_listed',
            ),
        ).toBe(true)
    })
})

describe('overlays and state variants cannot discharge requirements through the gate (findings 2, 8)', () => {
    const context = buildDocumentContext(documentInputs('guide'))
    const good = buildFallbackProposalV2(context.material)

    it('rejects the only safety text moved into an unopened section', () => {
        const safety = context.material.facts.find((fact) => fact.kind === 'safety')!
        let moved: ScreenNodeV2 | undefined
        const strip = (node: ScreenNodeV2): ScreenNodeV2 =>
            !('children' in node)
                ? node
                : ({
                      ...node,
                      children: node.children.flatMap((child) => {
                          if (
                              child.type === 'Text' &&
                              child.content.kind === 'fact' &&
                              child.content.factId === safety.factId
                          ) {
                              moved = child
                              return []
                          }
                          return [strip(child)]
                      }),
                  } as ScreenNodeV2)
        const body = strip(good.body)
        const hidden: ScreenNodeV2 = {
            type: 'Section',
            title: null,
            collapsible: true,
            initiallyOpen: false,
            children: [moved!],
        }
        const issues = checkProposal(
            {
                ...good,
                body: { ...body, children: [...('children' in body ? body.children : []), hidden] } as ScreenNodeV2,
            },
            context,
        )
        expect(has(issues, 'required_fact_is_missing_from_the_ready_variant')).toBe(true)
    })

    it('rejects a state variant stripped of every citation', () => {
        const strip = (node: ScreenNodeV2): ScreenNodeV2 =>
            !('children' in node)
                ? node
                : ({
                      ...node,
                      children: node.children.filter((child) => child.type !== 'Citation').map(strip),
                  } as ScreenNodeV2)
        const states = Object.fromEntries(
            Object.entries(good.states).map(([name, variant]) => [
                name,
                variant === null ? null : ({ ...variant, body: strip(variant.body) } as ScreenVariantV2),
            ]),
        ) as ScreenProposalV2['states']
        expect(has(checkProposal({ ...good, states }, context), 'required_citation_is_missing_from_the')).toBe(true)
    })

    it('rejects a header or state header that states an unknown fact', () => {
        const ghost = { kind: 'fact' as const, factId: 'unknown-fact' }
        expect(has(checkProposal({ ...good, header: { ...good.header, title: ghost } }, context), 'unknown_fact')).toBe(
            true,
        )
        const busy = good.states.busy!
        const states = { ...good.states, busy: { ...busy, header: { ...busy.header, subtitle: ghost } } }
        expect(has(checkProposal({ ...good, states }, context), 'unknown_fact')).toBe(true)
    })
})

describe('capture content needs a captured identity (finding 5)', () => {
    const image: ScreenNodeV2 = {
        type: 'Image',
        source: { kind: 'capture' },
        fit: 'contain',
        ratio: 'wide',
        caption: null,
    }

    it('refuses a live photo on a guide whatever the raw capture id says', () => {
        for (const captureId of ['photo-a', 'photo-b']) {
            const context = buildDocumentContext({ ...documentInputs('guide'), captureId })
            const issues = checkProposal(withBody(buildFallbackProposalV2(context.material), image), context)
            expect(has(issues, 'no_capture'), captureId).toBe(true)
        }
    })

    it('accepts it where the capture is in the context key: a held result, a question with a capture', () => {
        for (const kind of ['result', 'questions'] as const) {
            const context = buildDocumentContext(documentInputs(kind))
            // Appended inside the screen's own stack, so a held photo already there keeps its spine in every variant.
            const proposal = buildFallbackProposalV2(context.material)
            const stack = proposal.body.type === 'Scroll' ? proposal.body.children[0] : undefined
            if (stack?.type !== 'Stack') throw new Error('unexpected composition')
            const appended = {
                ...proposal,
                body: { ...proposal.body, children: [{ ...stack, children: [...stack.children, image] }] },
            }
            expect(checkProposal(appended as ScreenProposalV2, context), kind).toEqual([])
        }
    })

    it('keeps two different captures on different keys wherever a photo can be shown', () => {
        const keyFor = (kind: ScreenKindV2, captureId: string, ui = fullUi): string =>
            buildDocumentContext({
                ...documentInputs(kind, demoSession(), {
                    ...ui,
                    capture: { ...ui.capture!, captureId },
                }),
                captureId,
            }).bound.contextKey
        expect(keyFor('result', 'a')).not.toBe(keyFor('result', 'b'))
        expect(keyFor('questions', 'a')).not.toBe(keyFor('questions', 'b'))
    })
})

describe('a step is only confirmed past a held pass (finding 7)', () => {
    const advance: ScreenNodeV2 = {
        type: 'SecondaryAction',
        label: 'Next step',
        icon: null,
        intent: { intent: 'confirm', target: 'step' },
    }

    it.each(['guide', 'recovery', 'answer'] as const)(
        'refuses Next step on a %s screen without a held pass',
        (kind) => {
            const context = buildDocumentContext(documentInputs(kind))
            const proposal = buildFallbackProposalV2(context.material)
            const next = { ...proposal, bar: { ...proposal.bar, secondary: advance } } as ScreenProposalV2
            expect(has(checkProposal(next, context), 'intent_not_allowed')).toBe(true)
        },
    )

    it('offers it after a held pass', () => {
        const context = buildDocumentContext({
            ...documentInputs('result'),
            result: { kind: 'check', value: createHeroResponse('correct') },
        })
        expect(checkProposal(buildFallbackProposalV2(context.material), context)).toEqual([])
    })
})

describe('the deterministic fallback never turns a valid manual into a failure (findings 3, 4)', () => {
    function big(notes: number, refs = 1): ManualSession {
        const session = demoSession({ safety: false })
        session.reviewedSteps[0]!.safetyNotes = Array.from({ length: notes }, (_, note) => ({
            noteId: `n${note}`,
            note: {
                state: 'known' as const,
                value: `Keep fingers clear near connection ${note}.`,
                sourceRefs: Array.from({ length: refs }, (_unused, ref) => ({
                    pageId: 'demo-page-1',
                    region: { x: (note % 100) / 200, y: (ref % 100) / 200, width: 0.004, height: 0.004 },
                })),
            },
        }))
        return session
    }

    it.each([
        ['33 safety notes', big(33)],
        ['100 safety notes with 100 regions each', big(100, 100)],
    ])('serves %s in generation, off and the timeout fallback without throwing', async (_name, session) => {
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        const inputs: ScreenContextInputsV2 = documentInputs('guide', session)
        const required = documentMaterialV2(inputs).requirements.facts
        expect(required.length).toBe(session.reviewedSteps[0]!.safetyNotes!.length)
        for (const service of [serviceFor(), serviceFor({ GENERATIVE_UI: 'off' }), serviceFor({}, true)]) {
            const document = await service.generate(inputs)
            expect(document.requirements.facts).toEqual(required)
            expect(service.fallback(inputs, 'timeout').requirements.sources).toEqual(document.requirements.sources)
        }
    })

    it('keeps a safety citation past the 64th distinct source', async () => {
        const session = demoSession({ safety: false })
        const step = session.reviewedSteps[0]!
        step.sourceRefs = Array.from({ length: 65 }, (_, index) => ({
            pageId: 'demo-page-1',
            region: { x: index / 100, y: 0, width: 0.005, height: 0.005 },
        }))
        const region = { x: 0.9, y: 0.9, width: 0.05, height: 0.05 }
        step.safetyNotes = [
            {
                noteId: 'late',
                note: { state: 'known', value: 'Keep fingers clear.', sourceRefs: [{ pageId: 'demo-page-1', region }] },
            },
        ]
        const context = buildDocumentContext(documentInputs('guide', session))
        expect(
            context.material.sources.some((source) => JSON.stringify(source.region) === JSON.stringify(region)),
        ).toBe(true)
        expect(checkProposal(buildFallbackProposalV2(context.material), context)).toEqual([])
        const prompt = context.view.dynamic.document as { facts: { sources: number[] }[] }
        expect(prompt.facts.find((fact) => fact.sources.length === 0)).toBeUndefined()
    })
})

describe('a part-target Choice needs a held photo and named parts', () => {
    const choice: ScreenNodeV2 = {
        type: 'Choice',
        prompt: null,
        options: { mode: 'bound', binding: 'part-target' },
    }
    it('is accepted with both and refused without a part registry', () => {
        const context = buildDocumentContext(documentInputs('questions'))
        expect(checkProposal(buildFallbackProposalV2(context.material), context)).toEqual([])
        const partless = demoSession()
        partless.reviewedSteps[0]!.parts = []
        const bare = buildDocumentContext(documentInputs('questions', partless))
        expect(
            has(checkProposal(withBody(buildFallbackProposalV2(bare.material), choice), bare), 'binding_unavailable'),
        ).toBe(true)
    })
})

describe('the prompt names the closed copy (finding 1)', () => {
    it('hands the provider the literals it may use for this screen', () => {
        const context = buildDocumentContext(documentInputs('guide'))
        const view = context.view.dynamic.document as { literalCopy: Record<string, string[]> }
        expect(view.literalCopy.ready).toContain('Safety')
        expect(view.literalCopy.busy).toContain('Working on it')
        expect(JSON.stringify(view.literalCopy)).not.toContain('Looks right')
    })

    it('lists one stable calm wording for a generic wait, never a placeholder', () => {
        const context = buildDocumentContext(documentInputs('guide'))
        const view = context.view.dynamic.document as { literalCopy: Record<string, string[]> }
        for (const state of ['busy', 'pending'] as const) {
            expect(view.literalCopy[state], state).toEqual(
                expect.arrayContaining(['Working on it', 'One moment, please.']),
            )
            for (const retired of [
                'Getting this ready',
                'Your screen will appear here.',
                'This only takes a moment.',
            ]) {
                expect(view.literalCopy[state], `${state}: ${retired}`).not.toContain(retired)
            }
        }
    })
})

describe('the page a check names keeps its composition and is re-verified (stored guide projection)', () => {
    const REGION = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
    function withRegion(): ManualSession {
        const session = demoSession()
        session.reviewedSteps[0]!.sourceRefs = [{ pageId: 'demo-page-1', region: REGION }]
        return session
    }

    async function issue(session: ManualSession): Promise<{
        service: DocumentService
        screen: { screenId: string; contextKey: string }
    }> {
        const service = serviceFor({}, true)
        const document = await service.generate(documentInputs('guide', session))
        return { service, screen: { screenId: document.screenId, contextKey: document.bound.contextKey } }
    }
    type Shown = NonNullable<Extract<ReturnType<DocumentService['resolveStepScreen']>, { kind: 'guide' }>['shown']>
    const shownOf = (value: ReturnType<DocumentService['resolveStepScreen']>): Shown => {
        if (value === null || value === 'mismatch' || value.shown === undefined) throw new Error('no projection')
        return value.shown
    }

    it('preserves node order, layout, parts, the hero figure with the manual region, and the citations', async () => {
        const session = withRegion()
        const { service, screen } = await issue(session)
        const shown = shownOf(service.resolveStepScreen(session, 'step-1', screen))
        expect(shown.blocks[0]).toMatchObject({ path: 'body', type: 'Scroll', origin: 'generated' })
        const types = shown.blocks.map((block) => block.type)
        expect(types.indexOf('Image')).toBeLessThan(types.indexOf('Text'))
        const hero = shown.blocks.find((block) => block.type === 'Image')!
        expect(hero.figure).toEqual({ source: 'page', refId: 'demo-page-1', fit: 'contain', region: REGION })
        const safety = shown.blocks.find((block) => block.factIds?.includes('safety:n1'))
        expect(safety).toBeDefined()
        expect(shown.blocks.find((block) => block.type === 'PieceTile')?.parts?.length).toBe(1)
        expect(shown.blocks.some((block) => block.type === 'Citation' && (block.sources?.length ?? 0) > 0)).toBe(true)
        const collapsed = shown.blocks.find((block) => block.collapsed === true)
        expect(collapsed).toBeDefined()
        expect(shown.blocks.some((block) => block.path.startsWith(`${collapsed!.path}.`))).toBe(false)
        expect(shown.bar?.primary.intent).toBeDefined()
    })

    it('drops what the current manual no longer states, never repairing it', async () => {
        const session = withRegion()
        const { service, screen } = await issue(session)
        const edited = structuredClone(session)
        const step = edited.reviewedSteps[0]!
        step.sourceRefs = [{ pageId: 'demo-page-1', region: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } }]
        step.safetyNotes = [
            {
                noteId: 'n1',
                note: {
                    state: 'known',
                    value: 'A different note.',
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                },
            },
        ]
        const resolved = service.resolveStepScreen(edited, 'step-1', screen)
        if (resolved === null || resolved === 'mismatch') throw new Error('unresolved')
        expect(resolved.facts.map((fact) => fact.text)).not.toContain(
            (session.reviewedSteps[0]!.safetyNotes![0]!.note as { value: string }).value,
        )
        const shown = shownOf(resolved)
        expect(shown.blocks.find((block) => block.type === 'Image')?.figure?.region).toBeNull()
        expect(JSON.stringify(shown)).not.toContain(JSON.stringify(REGION))
    })

    it('refuses another identity', async () => {
        const session = withRegion()
        const { service, screen } = await issue(session)
        expect(service.resolveStepScreen(session, 'step-2', screen)).toBe('mismatch')
    })
})
