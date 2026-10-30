import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    COMPLETION_FIGURE_COPY_V2,
    allowedLiteralsV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    completionFigureV2,
    createDemoManual,
    documentMaterialV2,
    manualSessionSchema,
    screenContextJsonV2,
    screenDocumentV2Schema,
    semanticIssuesV2,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
    type SourceRef,
} from './index'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = {
    sha256Hex,
    reason: 'disabled' as const,
    evidence: 'local-deterministic' as const,
    now: (): Date => new Date('2026-10-30T00:00:00.000Z'),
}

const REGION = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }

/**
 * A reviewed manual of `steps` steps over `pages` pages. Step n cites page n (whole), except the last step, which cites
 * `lastRefs` when given. Built from the demo manual's own valid step so every other rule of a reviewed manual holds.
 */
function manual(steps: number, pages: number, lastRefs?: SourceRef[]): ManualSession {
    const base = createDemoManual()
    const template = base.reviewedSteps[0]!
    const pageList = Array.from({ length: pages }, (_unused, at) => ({
        ...base.pages[0]!,
        pageId: `page-${at + 1}`,
        assetId: `asset-${at + 1}`,
    }))
    const reviewedSteps = Array.from({ length: steps }, (_unused, at) => {
        const refs: SourceRef[] =
            at === steps - 1 && lastRefs !== undefined
                ? lastRefs
                : [{ pageId: `page-${(at % pages) + 1}`, region: null }]
        return {
            ...structuredClone(template),
            stepId: `step-${at + 1}`,
            order: at + 1,
            title: `Step ${at + 1}`,
            sourceRefs: refs,
            orientation: { ...template.orientation, sourceRefs: refs },
            connection: { ...template.connection, sourceRefs: refs },
            visibleChecks: template.visibleChecks.map((check) => ({
                ...check,
                description: { ...check.description, sourceRefs: refs },
            })),
            correction: null,
            parts: [{ partId: 'side-panel', quantity: { state: 'known' as const, value: 1, sourceRefs: refs } }],
        }
    })
    const parts = [
        {
            partId: 'side-panel',
            name: { state: 'known' as const, value: 'Side panel', sourceRefs: [{ pageId: 'page-1', region: null }] },
        },
    ]
    return manualSessionSchema.parse({
        ...base,
        pages: pageList,
        parts,
        rawExtraction: { parts, steps: structuredClone(reviewedSteps), unknowns: [] },
        reviewedSteps,
    })
}

const completion = (session: ManualSession, complete = true): ScreenContextInputsV2 => ({
    kind: 'completion',
    session,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    completedStepIds: complete ? session.reviewedSteps.map((step) => step.stepId) : [],
})

const nodesOf = (variant: Parameters<typeof visitVariantNodesV2>[0]): ScreenNodeV2[] => {
    const found: ScreenNodeV2[] = []
    visitVariantNodesV2(variant, '', ({ node }) => found.push(node))
    return found
}

describe('the completion figure is the manual’s own, chosen by one shared rule', () => {
    it('is the first usable reference of the last step, region kept exactly', () => {
        expect(completionFigureV2(manual(3, 3, [{ pageId: 'page-2', region: REGION }]))).toEqual({
            ref: { pageId: 'page-2', region: REGION },
            whole: false,
        })
        // A whole-page citation stays a whole page (never a region that was not read from the manual).
        expect(completionFigureV2(manual(3, 3))).toEqual({ ref: { pageId: 'page-3', region: null }, whole: true })
    })

    it('falls back to the manual’s first real page, whole, when no step of the end cites a usable page', () => {
        const unreviewed = manual(2, 2)
        unreviewed.reviewStatus = 'unreviewed'
        unreviewed.rawExtraction!.steps[1]!.sourceRefs = []
        expect(completionFigureV2(unreviewed)).toEqual({ ref: { pageId: 'page-1', region: null }, whole: true })
        const pageless = { ...unreviewed, pages: [] }
        expect(completionFigureV2(pageless)).toBeNull()
        expect(completionFigureV2(null)).toBeNull()
    })
})

describe('the finished-build document shows that figure with an honest caption and a way to the real page', () => {
    it.each([
        ['a cited figure', manual(3, 3, [{ pageId: 'page-2', region: REGION }]), COMPLETION_FIGURE_COPY_V2.figure],
        ['a cited whole page', manual(3, 3), COMPLETION_FIGURE_COPY_V2.page],
    ])('%s', (_name, session, caption) => {
        const inputs = completion(session)
        const material = documentMaterialV2(inputs)
        const document = buildFallbackDocumentV2(inputs, deps)
        const figure = completionFigureV2(session)!.ref
        expect(material.sources).toEqual([figure])
        expect(material.requirements).toMatchObject({ figure: 0, sources: [], facts: [] })
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])

        const ready = nodesOf(document)
        expect(ready).toContainEqual(
            expect.objectContaining({
                type: 'Image',
                source: { kind: 'source', index: 0 },
                caption: { kind: 'literal', text: caption },
            }),
        )
        expect(ready).toContainEqual(expect.objectContaining({ type: 'Citation', sources: [0] }))
        expect(ready.filter((node) => node.type === 'Progress')).toHaveLength(1)
        expect(ready.filter((node) => ['Meter', 'Spacer', 'Divider'].includes(node.type))).toEqual([])
        expect(ready).toContainEqual(
            expect.objectContaining({ type: 'Text', content: { kind: 'literal', text: 'Find your manual on Home.' } }),
        )
        expect(document.bar.primary.intent).toEqual({ intent: 'navigate', target: 'home' })
        expect(document.bar.secondary).toBeNull()
        // Waiting and failing variants are unchanged: the picture is owed by the ready screen alone.
        for (const { name, variant } of variantsOfV2(document).filter((entry) => entry.name !== 'ready')) {
            expect(
                nodesOf(variant).filter((node) => node.type === 'Image' || node.type === 'Citation'),
                name,
            ).toEqual([])
        }
    })

    it('refuses a picture the witness does not support, a missing picture and a mislabelled one', () => {
        const session = manual(3, 3, [{ pageId: 'page-2', region: REGION }])
        const inputs = completion(session)
        const material = documentMaterialV2(inputs)
        const proposal = buildFallbackProposalV2(material)
        expect(semanticIssuesV2(proposal, material)).toEqual([])

        // A region captioned as a page (or the reverse) is not interface copy of this context.
        expect(allowedLiteralsV2(material, 'ready')).toContain(COMPLETION_FIGURE_COPY_V2.figure)
        expect(allowedLiteralsV2(material, 'ready')).not.toContain(COMPLETION_FIGURE_COPY_V2.page)
        const wholePage = documentMaterialV2(completion(manual(3, 3)))
        expect(allowedLiteralsV2(wholePage, 'ready')).not.toContain(COMPLETION_FIGURE_COPY_V2.figure)
        // The caption is ready-screen copy only.
        expect(allowedLiteralsV2(material, 'busy')).not.toContain(COMPLETION_FIGURE_COPY_V2.figure)

        // The existing figure requirement rejects a ready screen that drops the picture.
        const dropped = buildFallbackDocumentV2(inputs, deps)
        const stripped = structuredClone(dropped)
        const strip = (node: ScreenNodeV2): ScreenNodeV2 =>
            'children' in node
                ? { ...node, children: node.children.filter((child) => child.type !== 'Image').map(strip) }
                : node
        stripped.body = strip(stripped.body)
        const parsed = screenDocumentV2Schema.safeParse(stripped)
        expect(parsed.success).toBe(false)
        expect(JSON.stringify(parsed.error?.issues)).toContain('The source picture is missing from the ready variant')
    })

    it('requires the completion picture’s citation in ready without adding it to waiting states', () => {
        const inputs = completion(manual(1, 1))
        const document = buildFallbackDocumentV2(inputs, deps)
        const strip = (node: ScreenNodeV2): ScreenNodeV2 =>
            'children' in node
                ? { ...node, children: node.children.filter((child) => child.type !== 'Citation').map(strip) }
                : node
        document.body = strip(document.body)
        const parsed = screenDocumentV2Schema.safeParse(document)
        expect(parsed.success).toBe(false)
        expect(JSON.stringify(parsed.error?.issues)).toContain('A required citation is missing')
    })

    it.each([
        ['one step on one page', 1, 1],
        ['the largest valid manual (200 steps, 20 pages)', 200, 20],
    ])('works for %s', (_name, steps, pages) => {
        const session = manual(steps, pages)
        const inputs = completion(session)
        const document = buildFallbackDocumentV2(inputs, deps)
        expect(document.sources).toEqual([{ pageId: `page-${((steps - 1) % pages) + 1}`, region: null }])
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(document.requirements.facts).toEqual([])
    })

    it('stays grounded: the context key follows the figure, and no other screen’s key moves', () => {
        const before = manual(3, 3, [{ pageId: 'page-2', region: REGION }])
        const after = manual(3, 3, [{ pageId: 'page-2', region: { ...REGION, x: 0.2 } }])
        expect(screenContextJsonV2(completion(before))).not.toBe(screenContextJsonV2(completion(after)))
        const guide = (session: ManualSession): ScreenContextInputsV2 => ({
            kind: 'guide',
            session,
            stepId: 'step-1',
            captureId: null,
            result: null,
            failure: null,
        })
        expect(screenContextJsonV2(guide(before))).toBe(screenContextJsonV2(guide(after)))
    })

    it('omits the picture, and nothing else changes, when there is no manual or no page to show', () => {
        const sessionless: ScreenContextInputsV2 = {
            kind: 'completion',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { library: { entries: [], soleManualId: null } },
        }
        const pageless = completion({ ...manual(1, 1), reviewStatus: 'unreviewed', pages: [] })
        for (const inputs of [sessionless, pageless]) {
            const material = documentMaterialV2(inputs)
            expect(material.sources).toEqual([])
            expect(material.requirements.figure).toBeNull()
            const document = buildFallbackDocumentV2(inputs, deps)
            expect(nodesOf(document).filter((node) => node.type === 'Image' || node.type === 'Citation')).toEqual([])
        }
        // A local sessionless completion must stay complete without claiming a build progress value.
        const empty = buildFallbackDocumentV2(sessionless, deps)
        expect(nodesOf(empty).filter((node) => node.type === 'Progress')).toEqual([])
        expect(verifyDocumentAgainstInputsV2(empty, sessionless, sha256Hex)).toEqual([])
        const document = buildFallbackDocumentV2(pageless, deps)
        expect(verifyDocumentAgainstInputsV2(document, pageless, sha256Hex)).toEqual([])
    })
})
