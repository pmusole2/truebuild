import {
    createDemoManual,
    LIMITS,
    manualSessionSchema,
    type ManualPart,
    type ManualSession,
    type ManualStep,
    type ParsedManual,
    type SourceRef,
} from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import {
    AssetValidationError,
    markManualReviewed,
    removeManualPage,
    renameManual,
    replaceReviewedParts,
    validateImportAsset,
} from './manual-session'

type Location = 'step' | 'orientation' | 'connection' | 'quantity' | 'check' | 'correction' | 'partName'

const KEEP_PAGE = 'page-a'
const DROP_PAGE = 'page-b'

function cite(pageId: string): SourceRef[] {
    return [{ pageId, region: null }]
}

/** Every citation in the step points at KEEP_PAGE except the single location under test, which points at DROP_PAGE. */
function stepCiting(stepId: string, order: number, at: Location | null): ManualStep {
    const refsAt = (location: Location): SourceRef[] => cite(at === location ? DROP_PAGE : KEEP_PAGE)

    return {
        stepId,
        order,
        title: `Step ${order}`,
        parts: [{ partId: 'panel', quantity: { state: 'known', value: 1, sourceRefs: refsAt('quantity') } }],
        orientation: {
            state: 'known',
            value: { partId: 'panel', description: 'Orientation' },
            sourceRefs: refsAt('orientation'),
        },
        connection: {
            state: 'known',
            value: { partIds: ['panel'], description: 'Connection' },
            sourceRefs: refsAt('connection'),
        },
        visibleChecks: [
            { checkId: `check-${order}`, description: { state: 'known', value: 'Check', sourceRefs: refsAt('check') } },
        ],
        sourceRefs: refsAt('step'),
        correction: {
            reviewed: false,
            actions: [{ actionId: `fix-${order}`, instruction: 'Fix it', sourceRefs: refsAt('correction') }],
        },
    }
}

function partNamed(citing: SourceRef[]): ManualPart {
    return { partId: 'panel', name: { state: 'known', value: 'Side panel', sourceRefs: citing } }
}

function twoPageSession(location: Location, rawExtraction: ParsedManual | null = null): ManualSession {
    return manualSessionSchema.parse({
        manualId: 'domain-manual',
        title: 'Domain manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 4,
        pages: [
            {
                pageId: KEEP_PAGE,
                assetId: 'asset-a',
                width: 800,
                height: 600,
                mimeType: 'image/jpeg',
                contentHash: 'a'.repeat(64),
            },
            {
                pageId: DROP_PAGE,
                assetId: 'asset-b',
                width: 800,
                height: 600,
                mimeType: 'image/jpeg',
                contentHash: 'b'.repeat(64),
            },
        ],
        parts: [partNamed(location === 'partName' ? cite(DROP_PAGE) : cite(KEEP_PAGE))],
        rawExtraction,
        reviewedSteps: [
            stepCiting('step-keep', 1, null),
            stepCiting('step-drop', 2, location === 'partName' ? null : location),
        ],
        reviewStatus: 'unreviewed',
    })
}

/** Collects every source reference reachable from a session, so tests can assert none still cites a removed page. */
function allRefs(session: ManualSession): SourceRef[] {
    const fromStep = (step: ManualStep): SourceRef[] => [
        ...step.sourceRefs,
        ...(step.orientation.state === 'known' ? step.orientation.sourceRefs : []),
        ...(step.connection.state === 'known' ? step.connection.sourceRefs : []),
        ...step.parts.flatMap((part) => (part.quantity.state === 'known' ? part.quantity.sourceRefs : [])),
        ...step.visibleChecks.flatMap((check) =>
            check.description.state === 'known' ? check.description.sourceRefs : [],
        ),
        ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
    ]

    return [
        ...session.parts.flatMap((part) => (part.name.state === 'known' ? part.name.sourceRefs : [])),
        ...session.reviewedSteps.flatMap(fromStep),
        ...(session.rawExtraction?.steps.flatMap(fromStep) ?? []),
    ]
}

describe('removeManualPage nested citation handling', () => {
    it('keeps an explicitly extracted source even when the model returned no citations', () => {
        const session = {
            ...twoPageSession('step', { parts: [], steps: [], unknowns: ['No legible facts on this page.'] }),
            extractionSourcePageIds: [DROP_PAGE],
        }
        const snapshot = structuredClone(session)

        expect(() => removeManualPage(session, DROP_PAGE)).toThrow(/preserved extraction source/)
        expect(session).toEqual(snapshot)
    })

    it.each<Location>(['step', 'orientation', 'connection', 'quantity', 'check', 'correction'])(
        'drops every reviewed step that cites the removed page at its %s location',
        (location: Location) => {
            const session = twoPageSession(location)
            const snapshot = structuredClone(session)

            const result = removeManualPage(session, DROP_PAGE)

            expect(result.pages.map((page) => page.pageId)).toEqual([KEEP_PAGE])
            expect(result.reviewedSteps.map((step) => step.stepId)).toEqual(['step-keep'])
            expect(allRefs(result).some((ref) => ref.pageId === DROP_PAGE)).toBe(false)
            expect(result.reviewStatus).toBe('unreviewed')
            expect(result.revision).toBe(session.revision + 1)
            expect(session).toEqual(snapshot)
        },
    )

    it('turns a reviewed part name that cites the removed page into an unknown fact and keeps the steps', () => {
        const session = twoPageSession('partName')

        const result = removeManualPage(session, DROP_PAGE)

        expect(result.parts[0]?.name.state).toBe('unknown')
        expect(result.reviewedSteps.map((step) => step.stepId)).toEqual(['step-keep', 'step-drop'])
        expect(allRefs(result).some((ref) => ref.pageId === DROP_PAGE)).toBe(false)
    })

    it('rejects removal when the preserved raw extraction cites the page, keeping the input unchanged', () => {
        const extraction: ParsedManual = {
            parts: [partNamed(cite(DROP_PAGE))],
            steps: [stepCiting('raw-step', 1, null)],
            unknowns: [],
        }
        const session = twoPageSession('step', extraction)
        const snapshot = structuredClone(session)

        expect(() => removeManualPage(session, DROP_PAGE)).toThrow(/raw extraction cites it/)
        expect(session).toEqual(snapshot)
    })

    it('rejects removal when a raw step (not a reviewed step) cites the page at a nested location', () => {
        const extraction: ParsedManual = {
            parts: [partNamed(cite(KEEP_PAGE))],
            steps: [stepCiting('raw-step', 1, 'correction')],
            unknowns: [],
        }

        expect(() => removeManualPage(twoPageSession('step', extraction), DROP_PAGE)).toThrow(/raw extraction/)
    })

    it('rejects removing the demo page because its preserved raw extraction cites it', () => {
        expect(() => removeManualPage(createDemoManual(), 'demo-page-1')).toThrow(/raw extraction cites it/)
    })

    it('throws for an unknown page without changing anything', () => {
        expect(() => removeManualPage(twoPageSession('step'), 'missing-page')).toThrow(/not found/)
    })
})

describe('explicit review and revision-advancing edits', () => {
    const resolvedDraft = (): ManualSession => ({
        ...createDemoManual(),
        revision: 3,
        reviewStatus: 'unreviewed',
    })

    it('advances the revision on review so a saved draft becomes dirty and must be saved again', () => {
        const saved = manualSessionSchema.parse(resolvedDraft())

        const reviewed = markManualReviewed(saved)

        expect(reviewed.reviewStatus).toBe('reviewed')
        expect(reviewed.revision).toBe(saved.revision + 1)
        expect(reviewed.revision).not.toBe(saved.revision)
    })

    it('refuses review while a critical fact is unresolved', () => {
        const draft = resolvedDraft()
        const [step] = draft.reviewedSteps

        if (step === undefined) {
            throw new Error('demo fixture has no step')
        }

        const unresolved: ManualSession = {
            ...draft,
            reviewedSteps: [{ ...step, orientation: { state: 'unknown', reason: 'Not visible' } }],
        }

        expect(() => markManualReviewed(unresolved)).toThrow()
    })

    it('keeps raw extraction byte-for-byte when reviewed parts are replaced', () => {
        const session = createDemoManual()
        const snapshot = structuredClone(session.rawExtraction)

        const replaced = replaceReviewedParts(
            session,
            session.parts.map((part: ManualPart): ManualPart =>
                part.partId === 'side-panel' ? { ...part, name: { state: 'unknown', reason: 'Renamed' } } : part,
            ),
        )

        expect(replaced.rawExtraction).toEqual(snapshot)
        expect(replaced.revision).toBe(session.revision + 1)
        expect(replaced.reviewStatus).toBe('unreviewed')
    })

    it('advances the revision when a manual is renamed', () => {
        const session = createDemoManual()

        expect(renameManual(session, 'Renamed').revision).toBe(session.revision + 1)
    })
})

describe('validateImportAsset limits', () => {
    const accepted = { mimeType: 'image/jpeg', byteLength: 1024, width: 800, height: 600 }

    it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s within every limit', (mimeType: string) => {
        expect(() => validateImportAsset({ ...accepted, mimeType }, 0)).not.toThrow()
    })

    it.each([
        {
            name: 'exactly 4 MiB',
            asset: { ...accepted, byteLength: LIMITS.imageBytes },
            existing: 0,
            code: undefined,
        },
        {
            name: 'one byte over 4 MiB',
            asset: { ...accepted, byteLength: LIMITS.imageBytes + 1 },
            existing: 0,
            code: 'oversized_file',
        },
        {
            name: 'exactly 24 megapixels',
            asset: { ...accepted, width: 6000, height: 4000 },
            existing: 0,
            code: undefined,
        },
        {
            name: 'one pixel past 24 megapixels',
            asset: { ...accepted, width: 6000, height: 4001 },
            existing: 0,
            code: 'oversized_pixels',
        },
        { name: 'the 20th page', asset: accepted, existing: 19, code: undefined },
        { name: 'a 21st page', asset: accepted, existing: 20, code: 'too_many_pages' },
        { name: 'an empty file', asset: { ...accepted, byteLength: 0 }, existing: 0, code: 'invalid_input' },
        { name: 'a GIF', asset: { ...accepted, mimeType: 'image/gif' }, existing: 0, code: 'unsupported_mime_type' },
        { name: 'a fractional width', asset: { ...accepted, width: 800.5 }, existing: 0, code: 'invalid_input' },
    ])('$name', ({ asset, existing, code }) => {
        if (code === undefined) {
            expect(() => validateImportAsset(asset, existing)).not.toThrow()
            return
        }

        let thrown: unknown = null

        try {
            validateImportAsset(asset, existing)
        } catch (error: unknown) {
            thrown = error
        }

        expect(thrown).toBeInstanceOf(AssetValidationError)
        expect(thrown).toMatchObject({ code })
    })
})
