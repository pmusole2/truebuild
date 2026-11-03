import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    SCREEN_KINDS_V2,
    assembleDocumentV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    canonicalJson,
    citationPlanOfV2,
    citationPlanV2,
    createDemoManual,
    documentMaterialV2,
    questionResultSchema,
    screenDocumentV2Schema,
    sourceKeyV2,
    variantPolicyV2,
    variantsOfV2,
    visitVariantNodesV2,
    type DocumentSourceV2,
    type ScreenContextInputsV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenUiStateV2,
    type ScreenVariantV2,
} from './index'
import { createHeroResponse } from './hero'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

const cite = (...sources: number[]): ScreenNodeV2 => ({ type: 'Citation', sources, label: null, display: 'chip' })
const page = (...sources: number[]): ScreenNodeV2 => ({
    type: 'ManualPage',
    sources,
    fit: 'contain',
    label: null,
    initiallyOpen: false,
})
const figure = (index: number): ScreenNodeV2 => ({
    type: 'Image',
    source: { kind: 'source', index },
    fit: 'cover',
    ratio: 'wide',
    caption: null,
})
const section = (collapsed: boolean, ...children: ScreenNodeV2[]): ScreenNodeV2 => ({
    type: 'Section',
    title: null,
    collapsible: collapsed,
    initiallyOpen: !collapsed,
    children,
})
const variantOf = (...body: ScreenNodeV2[]): ScreenVariantV2 => ({
    header: { title: { kind: 'literal', text: 'Title' }, subtitle: null, back: null, actions: [] },
    body: { type: 'Scroll', axis: 'vertical', children: body },
    bar: {
        primary: { type: 'PrimaryAction', label: 'Home', icon: null, intent: { intent: 'navigate', target: 'home' } },
        secondary: null,
    },
    overlays: [],
})
const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
const SOURCES: DocumentSourceV2[] = [
    { pageId: 'p1', region: null },
    { pageId: 'p1', region: box },
    { pageId: 'p2', region: null },
]
const plan = (...body: ScreenNodeV2[]): ReturnType<typeof citationPlanV2> =>
    citationPlanV2(variantOf(...body), '', SOURCES)

describe('one citation affordance per exact source reference per screen', () => {
    it('shows the first mention of a reference and marks later mentions as repeats', () => {
        expect(plan(cite(0), cite(0), cite(1, 0))).toEqual({
            'body.0': { show: [0], repeated: [] },
            'body.1': { show: [], repeated: [0] },
            'body.2': { show: [1], repeated: [0] },
        })
    })

    it('treats a page and an exact region of that page as different references', () => {
        expect(SOURCES.map(sourceKeyV2)).toHaveLength(new Set(SOURCES.map(sourceKeyV2)).size)
        expect(plan(cite(0), cite(1), cite(0, 1))).toEqual({
            'body.0': { show: [0], repeated: [] },
            'body.1': { show: [1], repeated: [] },
            'body.2': { show: [], repeated: [0, 1] },
        })
    })

    it('includes manual-page entries in a full render plan and hides repeated page openers', () => {
        expect(
            citationPlanV2(variantOf(cite(0), page(0), page(0), cite(1)), '', SOURCES, { includeManualPages: true }),
        ).toEqual({
            'body.0': { show: [], repeated: [0] },
            'body.1': { show: [0], repeated: [] },
            'body.2': { show: [], repeated: [0] },
            'body.3': { show: [1], repeated: [] },
        })
    })

    it('prefers a document citation over a native part-page link without losing unique part sources', () => {
        expect(
            citationPlanV2(variantOf(cite(0, 2), cite(0, 1)), '', SOURCES, { lowPriorityPaths: new Set(['body.0']) }),
        ).toEqual({
            'body.0': { show: [2], repeated: [0] },
            'body.1': { show: [0, 1], repeated: [] },
        })
    })

    it('counts the same reference listed twice in one node once', () => {
        expect(plan(cite(2, 2, 1))).toEqual({ 'body.0': { show: [2, 1], repeated: [] } })
    })

    it('lets a visible manual page claim its references, but a hidden one claims nothing', () => {
        expect(plan(page(0), cite(0, 1))).toEqual({ 'body.1': { show: [1], repeated: [0] } })
        expect(plan(section(true, page(0)), cite(0))).toEqual({ 'body.1': { show: [0], repeated: [] } })
    })

    it('lets a manual page claim its references wherever it stands: a chip never repeats an opener drawn after it', () => {
        // The page is always drawn, so a chip before it would offer the same source twice.
        expect(plan(cite(0, 1), page(0))).toEqual({ 'body.0': { show: [1], repeated: [0] } })
        // Repeated page anchors claim nothing more, and a reference no page shows still gets its chip.
        expect(plan(cite(0), page(0), page(0), cite(2))).toEqual({
            'body.0': { show: [], repeated: [0] },
            'body.3': { show: [2], repeated: [] },
        })
        expect(plan(page(0), cite(0), page(0))).toEqual({ 'body.1': { show: [], repeated: [0] } })
    })

    it('applies the same rule to the mentions inside one unopened section', () => {
        expect(plan(section(true, cite(2), page(2)))).toEqual({ 'body.0.0': { show: [], repeated: [2] } })
        expect(plan(section(true, page(2), cite(2)))).toEqual({ 'body.0.1': { show: [], repeated: [2] } })
        // A page in an unopened section is not in plain view, so it never takes the chip that is.
        expect(plan(cite(0), section(true, page(0)))).toEqual({ 'body.0': { show: [0], repeated: [] } })
    })

    it.each([false, true])(
        'keeps a chip in its own closed section when a sibling page is closed (page first: %s)',
        (pageFirst) => {
            const children = pageFirst
                ? [section(true, page(0)), section(true, cite(0))]
                : [section(true, cite(0)), section(true, page(0))]
            expect(plan(...children)).toEqual({
                [`body.${pageFirst ? 1 : 0}.0`]: { show: [0], repeated: [] },
            })
        },
    )

    it('keeps independent closed citation sections useful, while each section deduplicates its own mentions', () => {
        expect(plan(section(true, cite(0), cite(0)), section(true, cite(0)))).toEqual({
            'body.0.0': { show: [0], repeated: [] },
            'body.0.1': { show: [], repeated: [0] },
            'body.1.0': { show: [0], repeated: [] },
        })
    })

    it('inherits only affordances reachable when its own ancestors open', () => {
        expect(plan(section(true, page(0), section(true, cite(0, 1))))).toEqual({
            'body.0.1.0': { show: [1], repeated: [0] },
        })
        // Opening the parent chip's section does not open the deeper page's section.
        expect(plan(section(true, cite(0), section(true, page(0))))).toEqual({
            'body.0.0': { show: [0], repeated: [] },
        })
    })

    it('never lets a figure hide a chip: a picture of a source is not an affordance to cite it', () => {
        expect(plan(figure(2), cite(2))).toEqual({ 'body.1': { show: [2], repeated: [] } })
    })

    it('shows the first hidden mention only when nothing visible mentions the reference', () => {
        // Only mentioned inside an unopened section: opening it must not be empty.
        expect(plan(section(true, cite(2)))).toEqual({ 'body.0.0': { show: [2], repeated: [] } })
        // Also mentioned in plain view, later in the document: the visible one is the affordance.
        expect(plan(section(true, cite(2)), cite(2))).toEqual({
            'body.0.0': { show: [], repeated: [2] },
            'body.1': { show: [2], repeated: [] },
        })
        // Two hidden mentions: the first hidden one shows.
        expect(plan(section(true, cite(2), cite(2)))).toEqual({
            'body.0.0': { show: [2], repeated: [] },
            'body.0.1': { show: [], repeated: [2] },
        })
    })

    it('anchors paths under the variant prefix and never edits the variant', () => {
        const variant = variantOf(cite(0), cite(0))
        const before = canonicalJson(variant)
        expect(Object.keys(citationPlanV2(variant, 'states.busy.', SOURCES))).toEqual([
            'states.busy.body.0',
            'states.busy.body.1',
        ])
        expect(canonicalJson(variant)).toBe(before)
        expect(Object.keys(plan(section(true, cite(0)), cite(1)))).toEqual(['body.0.0', 'body.1'])
    })
})

describe('the plan over complete documents keeps every mandatory citation witness', () => {
    const SAFETY = 'Keep fingers clear of the groove while the panel is lifted.'
    const ui: ScreenUiStateV2 = {
        library: { entries: [], soleManualId: null },
        pages: { items: [], maxPages: 20, canRead: false, languageOptions: ['en'] },
        capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
        sections: ['settings', 'about-this-check', 'tips'],
        camera: { mode: 'build-photo', permission: 'granted' },
        judge: { builtView: false },
    }
    function inputsFor(kind: ScreenKindV2): ScreenContextInputsV2 {
        const manual = createDemoManual()
        manual.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'n1',
                note: { state: 'known', value: SAFETY, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
            },
        ]
        const sessionless = ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare'].includes(kind)
        const base: ScreenContextInputsV2 = {
            kind,
            session: sessionless ? null : manual,
            stepId: ['guide', 'result', 'questions', 'answer', 'recovery', 'camera'].includes(kind) ? 'step-1' : null,
            captureId: ['result', 'answer', 'questions'].includes(kind) ? 'cap-1' : null,
            result: null,
            failure: kind === 'error' ? 'timeout' : null,
            uiState: ui,
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

    it.each(SCREEN_KINDS_V2)('%s: one affordance per reference, every required source still witnessed', (kind) => {
        const document = buildFallbackDocumentV2(inputsFor(kind), {
            ...deps,
            reason: 'disabled',
            evidence: 'local-deterministic',
        })
        const snapshot = canonicalJson(document)
        for (const { name, prefix, variant } of variantsOfV2(document)) {
            const planned = citationPlanOfV2(document, name)
            expect(planned).toEqual(citationPlanV2(variant, prefix, document.sources))
            const shown = new Map<string, string>()
            const anchored = new Set<string>()
            visitVariantNodesV2(variant, prefix, ({ node, path, hidden }) => {
                if (node.type === 'Citation') {
                    const entry = planned[path]
                    expect(entry, `${path} is a Citation`).toBeDefined()
                    // The node keeps all of its own references: nothing is removed, only split into show and repeat.
                    expect([...entry!.show, ...entry!.repeated].sort()).toEqual([...new Set(node.sources)].sort())
                    expect(entry!.show.filter((index) => entry!.repeated.includes(index))).toEqual([])
                    for (const index of entry!.show) {
                        const key = sourceKeyV2(document.sources[index]!)
                        if (!hidden) expect(shown.get(key), `${path}: ${key} offered twice`).toBeUndefined()
                        shown.set(key, path)
                    }
                } else {
                    expect(planned[path], `${path} is not a Citation`).toBeUndefined()
                    if (!hidden && node.type === 'ManualPage') {
                        node.sources.forEach((index) => anchored.add(sourceKeyV2(document.sources[index]!)))
                    }
                }
            })
            // A source a visible chip mentions keeps exactly one visible affordance: its first chip, or a page that shows it.
            const chipped = new Set<string>()
            visitVariantNodesV2(variant, prefix, ({ node, hidden }) => {
                if (node.type !== 'Citation' || hidden) return
                node.sources.forEach((index) => chipped.add(sourceKeyV2(document.sources[index]!)))
            })
            for (const key of chipped) {
                expect(shown.has(key) || anchored.has(key), `${kind}/${name}: ${key} lost its affordance`).toBe(true)
            }
            // And the document still cites every required source visibly, exactly as the validator demands.
            const policy = variantPolicyV2(document.kind, name, document.requirements, document)
            expect(policy.sources.every((index) => document.sources[index] !== undefined)).toBe(true)
        }
        expect(canonicalJson(document)).toBe(snapshot)
    })

    it('offers a source once on a complete guide whose manual page comes after its chip', () => {
        // The guide cites source 0 in its body; a visible manual page for the same source is appended after everything.
        const material = documentMaterialV2(inputsFor('guide'))
        const proposal = buildFallbackProposalV2(material)
        expect(proposal.body.type).toBe('Scroll')
        const body = proposal.body as Extract<ScreenNodeV2, { type: 'Scroll' }>
        const document = assembleDocumentV2(
            material,
            { ...proposal, body: { ...body, children: [...body.children, page(0)] } },
            { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
            deps,
        )
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        const planned = citationPlanOfV2(document, 'ready')
        const cited = Object.entries(planned).filter(
            ([, entry]) => entry.show.includes(0) || entry.repeated.includes(0),
        )
        expect(cited.length, 'the guide still cites source 0 in its own body').toBeGreaterThan(0)
        // The page opener is the one visible affordance for source 0: no chip beside it draws the same reference.
        for (const [path, entry] of cited) expect(entry.show, `${path} draws source 0 beside its page`).not.toContain(0)
    })

    it('keeps independent disclosures useful on a complete guide without hiding its mandatory safety', () => {
        const inputs = inputsFor('guide')
        // The disclosures cite a reviewed-fix region, independent of the visible procedure and warning sources.
        const optionalRef = { pageId: 'demo-page-1', region: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } }
        const correction = inputs.session!.reviewedSteps[0]!.correction
        if (correction === null) throw new Error('fixture correction must be reviewed')
        correction.actions[0]!.sourceRefs.push(optionalRef)
        inputs.session!.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'n1',
                note: { state: 'known', value: SAFETY, sourceRefs: [{ pageId: 'demo-page-1', region: box }] },
            },
        ]
        const material = documentMaterialV2(inputs, false)
        const optionalPage = material.sources.findIndex((source) => sourceKeyV2(source) === sourceKeyV2(optionalRef))
        expect(optionalPage).toBeGreaterThanOrEqual(0)
        const proposal = buildFallbackProposalV2(material)
        const body = proposal.body as Extract<ScreenNodeV2, { type: 'Scroll' }>
        const start = body.children.length
        body.children.push(section(true, cite(optionalPage)), section(true, page(optionalPage)))
        const document = assembleDocumentV2(
            material,
            proposal,
            { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
            deps,
        )
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        const before = canonicalJson(document)
        const planned = citationPlanOfV2(document, 'ready')
        expect(planned[`body.${start}.0`]).toEqual({ show: [optionalPage], repeated: [] })
        const visibleSafety: string[] = []
        visitVariantNodesV2(document, '', ({ node, hidden }) => {
            if (node.type === 'Text' && node.content.kind === 'fact' && !hidden) {
                const id = node.content.factId
                const fact = document.facts.find((candidate) => candidate.factId === id)
                if (fact?.kind === 'safety') visibleSafety.push(fact.factId)
            }
        })
        expect(visibleSafety).toEqual(
            document.facts.filter((fact) => fact.kind === 'safety').map((fact) => fact.factId),
        )
        expect(canonicalJson(document)).toBe(before)
    })

    it('really removes repetition on a complete guide: more mentions than affordances', () => {
        const document = buildFallbackDocumentV2(inputsFor('guide'), {
            ...deps,
            reason: 'disabled',
            evidence: 'local-deterministic',
        })
        const planned = citationPlanOfV2(document, 'ready')
        const mentions = Object.values(planned).reduce(
            (sum, entry) => sum + entry.show.length + entry.repeated.length,
            0,
        )
        const affordances = Object.values(planned).reduce((sum, entry) => sum + entry.show.length, 0)
        expect(mentions).toBeGreaterThan(affordances)
        expect(affordances).toBeGreaterThan(0)
    })
})
