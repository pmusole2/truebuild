import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    assembleDocumentV2,
    composeFallbackDocumentV2,
    composeProposalV2,
    createDemoManual,
    documentMaterialV2,
    intentAllowedV2,
    nodeFactIdsV2,
    nodeIntentsV2,
    nodeTextRefsV2,
    screenContextJsonV2,
    screenDocumentV2Schema,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type AppIntent,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
    type ScreenVariantV2,
} from './index'

// The quick check of a manual that is fully known has no question to ask. It must still show the person what was
// understood (title, steps, picture, parts) so there is something to confirm, with one obvious next action.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

const REVIEW: NonNullable<ScreenUiStateV2['review']> = { currentQuestion: null, blockers: 0, canConfirm: true }
const QUESTION = {
    questionId: 'q1',
    kind: 'orientation' as const,
    stepId: 'step-1',
    stepOrder: 1,
    reason: 'Check this.',
    parts: [],
}

const quick = (
    review: ScreenUiStateV2['review'] = REVIEW,
    session: ManualSession = createDemoManual(),
): ScreenContextInputsV2 => ({
    kind: 'quick-check',
    session,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    uiState: { review },
})
const unreviewed = (): ManualSession =>
    ({ ...createDemoManual(), reviewStatus: 'unreviewed', reviewedSteps: [] }) as ManualSession

function build(
    inputs: ScreenContextInputsV2,
    edit?: (proposal: ScreenProposalV2) => ScreenProposalV2,
): { document: ScreenDocumentV2; schema: string[]; verify: string[] } {
    const material = documentMaterialV2(inputs)
    const composed = composeProposalV2(material)
    const document = assembleDocumentV2(
        material,
        edit ? edit(composed) : composed,
        { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
        deps,
    )
    const parsed = screenDocumentV2Schema.safeParse(document)
    return {
        document,
        schema: parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
        verify: verifyDocumentAgainstInputsV2(document, inputs, sha256Hex),
    }
}
const compose = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    composeFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })

const nodesOf = (variant: ScreenVariantV2): ScreenNodeV2[] => {
    const out: ScreenNodeV2[] = []
    visitVariantNodesV2(variant, '', ({ node }) => out.push(node))
    return out
}
const variantOf = (document: ScreenDocumentV2, name: string): ScreenVariantV2 =>
    variantsOfV2(document).find((entry) => entry.name === name)!.variant
const stated = (variant: ScreenVariantV2): string[] => nodesOf(variant).flatMap(nodeFactIdsV2)
const overviewIds = (document: ScreenDocumentV2): string[] =>
    document.facts.filter((fact) => fact.basis === 'overview').map((fact) => fact.factId)

it.each(['page image', 'part image', 'manual page', 'section title'] as const)(
    'withholds the overview through its %s alias',
    (alias) => {
        const inputs = quick()
        const image = { type: 'Image' as const, fit: 'contain' as const, ratio: 'wide' as const, caption: null }
        const node: ScreenNodeV2 =
            alias === 'page image'
                ? { ...image, source: { kind: 'page', pageId: inputs.session!.pages[0]!.pageId } }
                : alias === 'part image'
                  ? { ...image, source: { kind: 'part', partId: inputs.session!.parts[0]!.partId } }
                  : alias === 'manual page'
                    ? { type: 'ManualPage', sources: [0], fit: 'contain', label: null, initiallyOpen: true }
                    : {
                          type: 'Section',
                          title: { kind: 'bound', key: 'manual-title' },
                          collapsible: false,
                          initiallyOpen: true,
                          children: [],
                      }
        const output = build(inputs, (proposal) => {
            proposal.states.pending!.body = {
                type: 'Stack',
                gap: 'sm',
                align: 'stretch',
                children: [proposal.states.pending!.body, node],
            }
            return proposal
        })
        expect(output.schema).toContain('The pending variant states the manual overview before the ready screen')
    },
)
/** The tree without the nodes this predicate names (containers keep their other children). */
const without = (node: ScreenNodeV2, drop: (candidate: ScreenNodeV2) => boolean): ScreenNodeV2 =>
    'children' in node
        ? {
              ...node,
              children: node.children.filter((child) => !drop(child)).map((child) => without(child, drop)),
          }
        : node
const mapNodes = (node: ScreenNodeV2, change: (candidate: ScreenNodeV2) => ScreenNodeV2): ScreenNodeV2 => {
    const next = change(node)
    return 'children' in next
        ? ({ ...next, children: next.children.map((child) => mapNodes(child, change)) } as ScreenNodeV2)
        : next
}

describe('a fully known manual: the quick check states what was understood', () => {
    it.each([
        ['a reviewed manual', createDemoManual],
        ['a freshly parsed manual', unreviewed],
    ])('%s: every step title is stated by its own fact with its own cited source', (_name, make) => {
        const session = make()
        const built = build(quick(REVIEW, session))
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        const steps = session.reviewStatus === 'reviewed' ? session.reviewedSteps : session.rawExtraction!.steps
        const facts = built.document.facts.filter((fact) => fact.basis === 'overview')
        expect(facts.map((fact) => fact.text)).toEqual(steps.map((step) => step.title))
        expect(facts.every((fact) => fact.kind === 'title')).toBe(true)
        facts.forEach((fact, at) => expect(fact.sourceRefs).toEqual(steps[at]!.sourceRefs))
        // Stated by reference (the server's exact words), in manual order, visibly in the ready screen.
        expect(stated(variantOf(built.document, 'ready')).filter((id) => id.startsWith('overview:'))).toEqual(
            facts.map((fact) => fact.factId),
        )
    })

    it('shows the manual title, its own source picture and only the known parts, with one obvious next action', () => {
        const session = createDemoManual()
        session.parts.push({ partId: 'mystery', name: { state: 'unknown', reason: 'Not legible' } } as never)
        const built = build(quick(REVIEW, session))
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        const ready = variantOf(built.document, 'ready')
        const nodes = nodesOf(ready)
        expect(nodes.flatMap(nodeTextRefsV2)).toContainEqual({ kind: 'bound', key: 'manual-title' })
        const index = built.document.requirements.figure
        expect(index).not.toBeNull()
        expect(built.document.sources[index!]).toEqual({ pageId: 'demo-page-1', region: null })
        expect(
            nodes.some((node) => node.type === 'Image' && node.source.kind === 'source' && node.source.index === index),
        ).toBe(true)
        const tiles = nodes.flatMap((node) => (node.type === 'PieceTile' ? [node] : []))
        expect(tiles.map((tile) => tile.partId).sort()).toEqual(['divider', 'side-panel'])
        // A manual-wide list has no single count per part: no quantity is shown or guessed.
        expect(tiles.every((tile) => !tile.showQuantity)).toBe(true)
        expect(ready.bar.primary).toMatchObject({
            label: 'Looks right',
            intent: { intent: 'confirm', target: 'facts' },
        })
        expect(ready.bar.secondary).toMatchObject({ intent: { intent: 'retry', target: 'reading' } })
        expect(nodes.filter((node) => node.type === 'PrimaryAction')).toHaveLength(1)
        // No invented number or sentence: every literal is listed interface wording.
        const literals = nodes.flatMap(nodeTextRefsV2).flatMap((ref) => (ref.kind === 'literal' ? [ref.text] : []))
        expect(literals.filter((text) => /\d/u.test(text))).toEqual([])
    })

    it('puts overflow parts behind a collapsed disclosure instead of a long list', () => {
        const session = createDemoManual()
        for (let at = 0; at < 10; at += 1) {
            session.parts.push({
                partId: `extra-${at}`,
                name: { state: 'known', value: `Extra ${at}`, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
            } as never)
        }
        const built = build(quick(REVIEW, session))
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        const ready = variantOf(built.document, 'ready')
        const section = nodesOf(ready).find(
            (node) => node.type === 'Section' && node.collapsible && !node.initiallyOpen,
        )
        expect(section).toBeDefined()
        const tiles = nodesOf(ready).filter((node) => node.type === 'PieceTile')
        expect(tiles).toHaveLength(12)
    })

    it('honestly says there is no picture when no step cites a page the manual has', () => {
        const session = createDemoManual()
        for (const step of session.reviewedSteps) step.sourceRefs = [{ pageId: 'ghost', region: null }]
        const built = build(quick(REVIEW, session))
        expect(built.document.requirements.figure).toBeNull()
        expect(built.document.sources.some((source) => source.pageId === 'ghost')).toBe(false)
        const ready = nodesOf(variantOf(built.document, 'ready'))
        expect(ready.some((node) => node.type === 'Image')).toBe(false)
        expect(ready.flatMap(nodeTextRefsV2)).toContainEqual({
            kind: 'literal',
            text: 'No picture to show for this manual.',
        })
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
    })

    it('does not state that picture wording while a picture exists', () => {
        const listed = build(quick(), (proposal) => ({
            ...proposal,
            body: {
                type: 'Stack',
                gap: 'md',
                align: 'stretch',
                children: [
                    proposal.body,
                    {
                        type: 'Text',
                        content: { kind: 'literal', text: 'No picture to show for this manual.' },
                        role: 'body',
                        emphasis: 'normal',
                        tone: 'neutral',
                        align: 'start',
                    },
                ],
            },
        }))
        expect(listed.verify).toContain('literal_not_listed')
    })
})

describe('what a model document must keep', () => {
    it('is rejected when it leaves a step out, hides it, or states a fact the manual does not hold', () => {
        const base = build(quick())
        const [first] = overviewIds(base.document)
        const dropText =
            (id: string) =>
            (proposal: ScreenProposalV2): ScreenProposalV2 => ({
                ...proposal,
                body: without(
                    proposal.body,
                    (node) => node.type === 'Text' && node.content.kind === 'fact' && node.content.factId === id,
                ),
            })
        expect(build(quick(), dropText(first!)).schema.join()).toMatch(/required fact is missing/iu)
        const collapsed = build(quick(), (proposal) => ({
            ...proposal,
            body: mapNodes(proposal.body, (node) =>
                node.type === 'Section' ? { ...node, collapsible: true, initiallyOpen: false } : node,
            ),
        }))
        expect(collapsed.schema.join()).toMatch(/required fact is missing/iu)
        const invented = build(quick(), (proposal) => ({
            ...proposal,
            body: mapNodes(proposal.body, (node) =>
                node.type === 'Text' && node.content.kind === 'fact'
                    ? { ...node, content: { kind: 'fact', factId: 'overview:step:invented' } }
                    : node,
            ),
        }))
        expect(invented.schema.join()).toMatch(/unknown fact/iu)
    })

    it('is rejected when it drops the source picture', () => {
        const built = build(quick(), (proposal) => ({
            ...proposal,
            body: without(proposal.body, (node) => node.type === 'Image'),
        }))
        expect(built.schema.join()).toMatch(/source picture/iu)
    })

    it('has its facts, picture and wording recomputed by the client verifier from its own inputs', () => {
        const built = build(quick())
        expect(built.verify).toEqual([])
        const tampered: ScreenDocumentV2 = {
            ...built.document,
            facts: built.document.facts.map((fact) =>
                fact.basis === 'overview' ? { ...fact, text: 'A step the manual never had' } : fact,
            ),
        }
        expect(verifyDocumentAgainstInputsV2(tampered, quick(), sha256Hex)).toContain('facts_mismatch')
        const other = createDemoManual()
        other.reviewedSteps[0]!.title = 'Stand the other panel upright'
        expect(verifyDocumentAgainstInputsV2(built.document, quick(REVIEW, other), sha256Hex)).toEqual(
            expect.arrayContaining(['facts_mismatch', 'bound_mismatch']),
        )
        expect(screenContextJsonV2(quick(REVIEW, other))).not.toBe(screenContextJsonV2(quick()))
    })
})

describe('the review that needs a question or a clearer photo is unchanged', () => {
    it('keeps the one-question workflow: no overview beside a pending question', () => {
        const inputs = quick({ currentQuestion: QUESTION, blockers: 0, canConfirm: true })
        const built = build(inputs)
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        expect(built.document.facts).toEqual([])
        const nodes = nodesOf(variantOf(built.document, 'ready'))
        expect(nodes.some((node) => node.type === 'FactEditor')).toBe(true)
        expect(nodes.some((node) => node.type === 'PieceTile')).toBe(false)
        expect(built.document.requirements.figure).not.toBeNull()
    })

    it.each([
        ['it cannot be confirmed yet', { currentQuestion: null, blockers: 1, canConfirm: false }],
        ['the app holds no review state', null],
    ] as const)('claims nothing when %s', (_name, review) => {
        const built = build(quick(review))
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        expect(built.document.facts).toEqual([])
        expect(built.document.requirements.figure).toBeNull()
        expect(nodesOf(variantOf(built.document, 'ready')).some((node) => node.type === 'PieceTile')).toBe(false)
    })

    it('claims nothing before any step was read', () => {
        const session = {
            ...createDemoManual(),
            reviewStatus: 'unreviewed',
            reviewedSteps: [],
            rawExtraction: null,
        } as ManualSession
        const built = build(quick(REVIEW, session))
        expect(built.schema).toEqual([])
        expect(built.document.facts).toEqual([])
        expect(built.document.requirements.figure).toBeNull()
    })

    it('the confirmation stays earned: Looks right is required only when the review can be confirmed', () => {
        expect(documentMaterialV2(quick()).requirements.actions).toContainEqual({ intent: 'confirm', target: 'facts' })
        expect(
            documentMaterialV2(quick({ currentQuestion: null, blockers: 1, canConfirm: false })).requirements.actions,
        ).toEqual([])
    })
})

describe('waiting and failing variants never claim the overview', () => {
    it.each(['busy', 'pending', 'error', 'recovery'] as const)(
        'the %s variant states no step, part or picture',
        (name) => {
            const document = compose(quick())
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            const variant = variantOf(document, name)
            expect(stated(variant).filter((id) => id.startsWith('overview:'))).toEqual([])
            const nodes = nodesOf(variant)
            expect(nodes.some((node) => node.type === 'Image' || node.type === 'PieceTile')).toBe(false)
            expect(nodes.flatMap(nodeTextRefsV2)).not.toContainEqual({ kind: 'bound', key: 'manual-title' })
        },
    )

    it('refuses a document that states a step in a waiting variant', () => {
        const [first] = overviewIds(compose(quick()))
        const leaked = build(quick(), (proposal) => ({
            ...proposal,
            states: {
                ...proposal.states,
                pending: {
                    ...proposal.states.pending!,
                    body: {
                        type: 'Stack',
                        gap: 'md',
                        align: 'stretch',
                        children: [
                            proposal.states.pending!.body,
                            {
                                type: 'Text',
                                content: { kind: 'fact', factId: first! },
                                role: 'body',
                                emphasis: 'normal',
                                tone: 'neutral',
                                align: 'start',
                            },
                        ],
                    },
                },
            },
        }))
        expect(leaked.schema.join()).toMatch(/pending variant states the manual overview/iu)
    })

    it('the reading screen of a manual not yet parsed holds no fact and no step', () => {
        const session = {
            ...createDemoManual(),
            reviewStatus: 'unreviewed',
            reviewedSteps: [],
            rawExtraction: null,
        } as ManualSession
        const document = compose({
            kind: 'reading',
            session,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: null,
        })
        expect(document.facts).toEqual([])
        expect(document.requirements.figure).toBeNull()
        expect(variantsOfV2(document).flatMap(({ variant }) => stated(variant))).toEqual([])
    })
})

// ---------------------------------------------------------------------------------------------------------------------
// Obligations the shared schema (and so the gate and the client verifier) enforces, not just the composer.
// ---------------------------------------------------------------------------------------------------------------------

/** Two pages: step 2 cites a page the first step (and so the picture) does not, so only its own chip cites it. */
const twoPages = (): ManualSession => {
    const session = createDemoManual()
    session.pages.push({ ...session.pages[0]!, pageId: 'demo-page-2', assetId: 'demo-asset-2' })
    session.reviewedSteps[1]!.sourceRefs = [{ pageId: 'demo-page-2', region: null }]
    return session
}
const withParts = (count: number): ManualSession => {
    const session = createDemoManual()
    for (let at = 0; at < count; at += 1) {
        session.parts.push({
            partId: `extra-${at}`,
            name: { state: 'known', value: `Extra ${at}`, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
        } as never)
    }
    return session
}
/** The largest manual the model allows: 200 steps, 256 known parts and 20 pages, every step citing every page. */
const largestManual = (): ManualSession => {
    const session = createDemoManual()
    const page = session.pages[0]!
    session.pages = Array.from({ length: 20 }, (_, at) => ({ ...page, pageId: `page-${at}`, assetId: `asset-${at}` }))
    session.parts = Array.from({ length: 256 }, (_, at) => ({
        partId: `part-${at}`,
        name: { state: 'known', value: `Part ${at}`, sourceRefs: [{ pageId: 'page-0', region: null }] },
    })) as never
    const template = session.reviewedSteps[0]!
    session.reviewedSteps = Array.from({ length: 200 }, (_, at) => ({
        ...structuredClone(template),
        stepId: `step-${at}`,
        order: at + 1,
        title: `Step ${at}`,
        sourceRefs: Array.from({ length: 20 }, (_, pageAt) => ({
            pageId: `page-${pageAt}`,
            // Every reference is a distinct, valid region: the exact-region table cannot hold them all.
            region: { x: (at % 100) / 250, y: 0, width: 0.1 + (pageAt * 200 + at) / 20_000, height: 0.5 },
        })),
    }))
    return session
}

const stack = (children: ScreenNodeV2[]): ScreenNodeV2 => ({ type: 'Stack', gap: 'md', align: 'stretch', children })
const factText = (factId: string): ScreenNodeV2 => ({
    type: 'Text',
    content: { kind: 'fact', factId },
    role: 'body',
    emphasis: 'normal',
    tone: 'neutral',
    align: 'start',
})
const collapsed = (children: ScreenNodeV2[]): ScreenNodeV2 => ({
    type: 'Section',
    title: null,
    collapsible: true,
    initiallyOpen: false,
    children,
})
const tile = (partId: string): ScreenNodeV2 => ({ type: 'PieceTile', partId, showQuantity: false, size: 'sm' })
const sourceImage: ScreenNodeV2 = {
    type: 'Image',
    source: { kind: 'source', index: 0 },
    fit: 'contain',
    ratio: 'hero',
    caption: null,
}
const manualTitle: ScreenNodeV2 = {
    type: 'Text',
    content: { kind: 'bound', key: 'manual-title' },
    role: 'title',
    emphasis: 'strong',
    tone: 'neutral',
    align: 'start',
}
const alsoIn = (
    proposal: ScreenProposalV2,
    name: 'busy' | 'pending' | 'error' | 'recovery',
    extra: ScreenNodeV2,
): ScreenProposalV2 => ({
    ...proposal,
    states: {
        ...proposal.states,
        [name]: { ...proposal.states[name]!, body: stack([proposal.states[name]!.body, extra]) },
    },
})
const tilesOf = (variant: ScreenVariantV2): string[] =>
    nodesOf(variant).flatMap((node) => (node.type === 'PieceTile' ? [node.partId] : []))
const intentsOf = (document: ScreenDocumentV2): AppIntent[] =>
    variantsOfV2(document).flatMap(({ variant, prefix }) => {
        const found: AppIntent[] = [
            ...(variant.header.back ? [variant.header.back.intent] : []),
            ...variant.header.actions.map((action) => action.intent),
        ]
        visitVariantNodesV2(variant, prefix, ({ node }) => found.push(...nodeIntentsV2(node)))
        return found
    })

describe('the overview owes its citations, title and parts in the ready screen', () => {
    it('is rejected when it drops the citations of the steps', () => {
        const base = build(quick(REVIEW, twoPages()))
        expect(base.schema).toEqual([])
        expect(base.document.sources).toHaveLength(2)
        const dropped = build(quick(REVIEW, twoPages()), (proposal) => ({
            ...proposal,
            body: without(proposal.body, (node) => node.type === 'Citation'),
        }))
        expect(dropped.schema.join()).toMatch(/required citation is missing/iu)
    })

    it('does not ask a waiting variant for the citations (it claims no step)', () => {
        const built = build(quick(REVIEW, twoPages()))
        for (const name of ['busy', 'pending', 'error', 'recovery'] as const) {
            expect(nodesOf(variantOf(built.document, name)).some((node) => node.type === 'Citation')).toBe(false)
        }
    })

    it('is rejected when it drops the manual title', () => {
        const built = build(quick(), (proposal) => ({
            ...proposal,
            body: without(
                proposal.body,
                (node) => node.type === 'Text' && node.content.kind === 'bound' && node.content.key === 'manual-title',
            ),
        }))
        expect(built.schema.join()).toMatch(/manual title is missing/iu)
    })

    it('is rejected when it drops every part, or any one of them', () => {
        const none = build(quick(REVIEW, withParts(3)), (proposal) => ({
            ...proposal,
            body: without(proposal.body, (node) => node.type === 'PieceTile'),
        }))
        expect(none.schema.join()).toMatch(/required part is missing/iu)
        const last = build(quick(REVIEW, withParts(3)), (proposal) => ({
            ...proposal,
            body: without(proposal.body, (node) => node.type === 'PieceTile' && node.partId === 'extra-2'),
        }))
        expect(last.schema.join()).toMatch(/required part is missing/iu)
    })

    it('is rejected when the first parts are not visible, and accepts the rest behind a disclosure', () => {
        const hidden = build(quick(REVIEW, withParts(3)), (proposal) => ({
            ...proposal,
            body: mapNodes(proposal.body, (node) =>
                node.type === 'Section' && node.title?.kind === 'literal' && node.title.text === 'Parts'
                    ? { ...node, collapsible: true, initiallyOpen: false }
                    : node,
            ),
        }))
        expect(hidden.schema.join()).toMatch(/first parts/iu)
        const manyParts = build(quick(REVIEW, withParts(20)))
        expect(manyParts.schema).toEqual([])
        expect(manyParts.document.requirements.parts).toHaveLength(22)
    })

    it('has the required parts recomputed by the client verifier from its own inputs', () => {
        const built = build(quick(REVIEW, withParts(2)))
        expect(built.document.requirements.parts).toEqual(['side-panel', 'divider', 'extra-0', 'extra-1'])
        const tampered: ScreenDocumentV2 = {
            ...built.document,
            requirements: { ...built.document.requirements, parts: [] },
        }
        expect(verifyDocumentAgainstInputsV2(tampered, quick(REVIEW, withParts(2)), sha256Hex)).toContain(
            'requirements_mismatch',
        )
    })
})

describe('a waiting or failing variant cannot carry any part of the overview', () => {
    const leaks: [string, ScreenNodeV2][] = [
        ['a step fact', factText('overview:step:step-1')],
        ['a step fact inside a collapsed section', collapsed([factText('overview:step:step-1')])],
        ['a piece tile', tile('side-panel')],
        ['a piece tile inside a collapsed section', collapsed([tile('side-panel')])],
        ['the source picture', sourceImage],
        ['the source picture inside a collapsed section', collapsed([sourceImage])],
        ['the manual title', manualTitle],
    ]
    it.each(
        (['busy', 'pending', 'error', 'recovery'] as const).flatMap((name) =>
            leaks.map(([leak, node]) => [name, leak, node] as const),
        ),
    )('refuses the %s variant that shows %s', (name, _leak, node) => {
        const leaked = build(quick(), (proposal) => alsoIn(proposal, name, node))
        expect(leaked.schema.join()).toMatch(new RegExp(`${name} variant states the manual overview`, 'iu'))
    })
})

describe('every known part is offered, none dropped', () => {
    it.each([49, 100, 256 - 2])('offers all %i extra known parts as tiles, in manual order', (count) => {
        const session = withParts(count)
        const inputs = quick(REVIEW, session)
        const material = documentMaterialV2(inputs)
        const expected = session.parts.map((part) => part.partId)
        expect(material.partIds).toEqual(expected)
        expect(material.requirements.parts).toEqual(expected)
        const built = build(inputs)
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        expect(tilesOf(variantOf(built.document, 'ready'))).toEqual(expected)
    })

    it('ignores parts whose name is not known and never shows an unnamed one', () => {
        const session = withParts(1)
        session.parts.push({ partId: 'mystery', name: { state: 'unknown', reason: 'Not legible' } } as never)
        const built = build(quick(REVIEW, session))
        expect(built.document.requirements.parts).not.toContain('mystery')
        expect(tilesOf(variantOf(built.document, 'ready'))).not.toContain('mystery')
    })

    it('holds a manual with no known parts without asking for any tile', () => {
        const session = createDemoManual()
        session.parts = []
        const built = build(quick(REVIEW, session))
        expect(built.schema).toEqual([])
        expect(built.document.requirements.parts).toEqual([])
        expect(tilesOf(variantOf(built.document, 'ready'))).toEqual([])
    })

    it('fits the largest valid manual: 200 steps, 256 parts and 20 pages, complete and verified', () => {
        const session = largestManual()
        const inputs = quick(REVIEW, session)
        const built = build(inputs)
        expect(built.schema).toEqual([])
        expect(built.verify).toEqual([])
        expect(overviewIds(built.document)).toHaveLength(200)
        expect(stated(variantOf(built.document, 'ready')).filter((id) => id.startsWith('overview:'))).toEqual(
            overviewIds(built.document),
        )
        expect(tilesOf(variantOf(built.document, 'ready'))).toEqual(session.parts.map((part) => part.partId))
    })
})

describe('a quick check offers only an action the app can earn', () => {
    const cases: [string, ScreenUiStateV2['review']][] = [
        ['it cannot be confirmed yet', { currentQuestion: null, blockers: 1, canConfirm: false }],
        ['the app holds no review state', null],
        [
            'a question is asked and the manual cannot be confirmed yet',
            { currentQuestion: QUESTION, blockers: 0, canConfirm: false },
        ],
    ]
    it.each(cases)('composes no confirmation, in any variant, when %s', (_name, review) => {
        const inputs = quick(review)
        const material = documentMaterialV2(inputs)
        const document = compose(inputs)
        const intents = intentsOf(document)
        expect(intents.length).toBeGreaterThan(0)
        expect(intents.filter((offered) => !intentAllowedV2(offered, material))).toEqual([])
        expect(intents).not.toContainEqual({ intent: 'confirm', target: 'facts' })
        // The way forward the native screen takes (the pages), in the screen and in the waiting variants that mirror it.
        for (const name of ['ready', 'busy', 'pending'] as const) {
            expect(variantOf(document, name).bar.primary.intent).toEqual({ intent: 'navigate', target: 'pages' })
        }
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
    })

    it('still offers Looks right when the review can be confirmed', () => {
        const document = compose(quick())
        const material = documentMaterialV2(quick())
        expect(variantOf(document, 'ready').bar.primary.intent).toEqual({ intent: 'confirm', target: 'facts' })
        expect(intentsOf(document).filter((offered) => !intentAllowedV2(offered, material))).toEqual([])
    })
})
