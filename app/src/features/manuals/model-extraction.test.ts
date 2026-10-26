import { manualSessionSchema, type ManualSession, type ParsedManual } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import {
    applyPreview,
    appendBatch,
    batchNamespace,
    EXTRACTION_MAX_PAGES,
    ExtractionError,
    extractedPageIds,
    extractionSourcesOf,
    namespaceBatch,
    previewBatch,
    selectBatch,
} from './model-extraction'

const HASH = 'a'.repeat(64)

function page(index: number): ManualSession['pages'][number] {
    return {
        pageId: `page-${index}`,
        assetId: `asset-${index}`,
        width: 800,
        height: 600,
        mimeType: 'image/jpeg',
        contentHash: HASH,
    }
}

// An unreviewed manual with three pages and no raw extraction yet.
function makeSession(overrides: Partial<ManualSession> = {}): ManualSession {
    return manualSessionSchema.parse({
        manualId: 'manual-1',
        title: 'Shelf',
        updatedAt: '2026-10-26T10:00:00.000Z',
        revision: 4,
        pages: [page(1), page(2), page(3)],
        parts: [],
        rawExtraction: null,
        reviewedSteps: [],
        reviewStatus: 'unreviewed',
        ...overrides,
    })
}

// One part, one step, all citing `pageId`. Identities are batch-local, as the model returns them.
function batch(pageId: string, partId = 'p1', stepId = 's1', order = 1): ParsedManual {
    const cite = [{ pageId, region: null }]
    return {
        parts: [{ partId, name: { state: 'known', value: 'Side panel', sourceRefs: cite } }],
        steps: [
            {
                stepId,
                order,
                title: 'Stand the panel upright',
                parts: [{ partId, quantity: { state: 'known', value: 1, sourceRefs: cite } }],
                orientation: {
                    state: 'known',
                    value: { partId, description: 'Groove faces inward.' },
                    sourceRefs: cite,
                },
                connection: {
                    state: 'known',
                    value: { partIds: [partId], description: 'Seat the edge.' },
                    sourceRefs: cite,
                },
                visibleChecks: [],
                sourceRefs: cite,
                correction: null,
            },
        ],
        unknowns: ['Lower edge is not legible.'],
    }
}

describe('selectBatch', () => {
    it('rejects an empty, duplicated, oversized or unknown page selection', () => {
        const session = makeSession()
        expect(selectBatch(session, [], 'append')).toEqual({ reason: expect.stringContaining('one to three') })
        expect(selectBatch(session, ['page-1', 'page-1'], 'append')).toEqual({
            reason: expect.stringContaining('different'),
        })
        expect(
            selectBatch(session, ['page-1', 'page-2', 'page-3', 'page-x'].slice(0, EXTRACTION_MAX_PAGES + 1), 'append'),
        ).toEqual({ reason: expect.stringContaining('up to') })
        expect(selectBatch(session, ['page-9'], 'append')).toEqual({ reason: expect.stringContaining('no longer') })
    })

    it.each(['append', 'replace'] as const)('refuses an already extracted page in %s mode', (mode) => {
        const session = makeSession({ rawExtraction: batch('page-1') })

        expect(selectBatch(session, ['page-1'], mode)).toEqual({
            reason: expect.stringContaining('already has raw'),
        })
        expect(selectBatch(session, ['page-2'], mode)).toEqual({ pages: [session.pages[1]] })
    })
})

describe('batch identity', () => {
    it('derives the same namespace regardless of page order, and a different one for other pages', () => {
        expect(batchNamespace(['page-2', 'page-1'])).toBe(batchNamespace(['page-1', 'page-2']))
        expect(batchNamespace(['page-1'])).not.toBe(batchNamespace(['page-2']))
    })

    it('maps every part and step reference while leaving names, descriptions and citations untouched', () => {
        const namespaced = namespaceBatch(batch('page-2'), 'b1')
        const step = namespaced.steps[0]

        expect(namespaced.parts[0]?.partId).toBe('b1-p1')
        expect(step?.stepId).toBe('b1-s1')
        expect(step?.parts[0]?.partId).toBe('b1-p1')
        expect(step?.orientation).toMatchObject({
            state: 'known',
            value: { partId: 'b1-p1', description: 'Groove faces inward.' },
        })
        expect(step?.connection).toMatchObject({ state: 'known', value: { partIds: ['b1-p1'] } })
        expect(namespaced.parts[0]?.name).toEqual(batch('page-2').parts[0]?.name)
        expect(namespaced.unknowns).toEqual(['Lower edge is not legible.'])
    })
})

describe('appendBatch', () => {
    it('keeps existing facts exact and orders new steps after the existing ones', () => {
        const existing = batch('page-1')
        const incoming = namespaceBatch(batch('page-2', 'p1', 's1', 1), 'b2')

        const merged = appendBatch(existing, incoming)

        expect(merged.parts.map((part) => part.partId)).toEqual(['p1', 'b2-p1'])
        expect(merged.steps.map((step) => [step.stepId, step.order])).toEqual([
            ['s1', 1],
            ['b2-s1', 2],
        ])
        expect(merged.steps[0]).toEqual(existing.steps[0])
        expect(merged.unknowns).toEqual(['Lower edge is not legible.', 'Lower edge is not legible.'])
    })

    it('rejects an un-namespaced batch that clashes with existing identities instead of merging it', () => {
        expect(() => appendBatch(batch('page-1'), batch('page-2'))).toThrow(ExtractionError)
    })

    it('returns the incoming batch unchanged when there is no existing raw extraction', () => {
        const incoming = batch('page-1')
        expect(appendBatch(null, incoming)).toBe(incoming)
    })
})

describe('preview and apply', () => {
    it('previews append with the batch namespace and replace without one', () => {
        const session = makeSession({ rawExtraction: batch('page-1') })
        const appended = previewBatch(session, ['page-2'], 'append', batch('page-2'))
        const replaced = previewBatch(session, ['page-2'], 'replace', batch('page-2'))

        expect(appended.counts).toEqual({ parts: 2, steps: 2, unknowns: 2 })
        expect(appended.extraction.parts.some((part) => part.partId.startsWith('b'))).toBe(true)
        expect(replaced.counts).toEqual({ parts: 1, steps: 1, unknowns: 1 })
        expect(replaced.extraction.parts[0]?.partId).toBe('p1')
    })

    it('writes raw evidence only: revision advances, the manual is unreviewed, reviewed steps are unchanged', () => {
        const session = makeSession({ rawExtraction: batch('page-1') })
        const preview = previewBatch(session, ['page-2'], 'append', batch('page-2'))

        const next = applyPreview(session, preview, '2026-10-26T11:00:00.000Z')

        expect(next.revision).toBe(session.revision + 1)
        expect(next.reviewStatus).toBe('unreviewed')
        expect(next.reviewedSteps).toEqual(session.reviewedSteps)
        expect(next.parts).toEqual(session.parts)
        expect(extractedPageIds(next)).toEqual(new Set(['page-1', 'page-2']))
    })

    it('refuses a preview made for an earlier revision, writing nothing', () => {
        const session = makeSession()
        const preview = previewBatch(session, ['page-1'], 'append', batch('page-1'))
        const edited = { ...session, revision: session.revision + 1 }

        expect(() => applyPreview(edited, preview, '2026-10-26T11:00:00.000Z')).toThrow(ExtractionError)
    })
})

const NOW = '2026-10-26T12:00:00.000Z'

describe('extraction source custody', () => {
    it('append unions the selected pages into the recorded list; replace resets it to the selection', () => {
        const first = applyPreview(
            makeSession(),
            previewBatch(makeSession(), ['page-1'], 'append', batch('page-1')),
            NOW,
        )
        const appended = previewBatch(first, ['page-2'], 'append', batch('page-2'))
        const replaced = previewBatch(first, ['page-3'], 'replace', batch('page-3'))

        expect(appended.sourcePageIds).toEqual(['page-1', 'page-2'])
        expect(replaced.sourcePageIds).toEqual(['page-3'])
    })

    it('records a selected page that yields no citations, and then refuses a second extraction of it', () => {
        const noEvidence: ParsedManual = { parts: [], steps: [], unknowns: ['Page is blank.'] }
        const applied = applyPreview(makeSession(), previewBatch(makeSession(), ['page-2'], 'append', noEvidence), NOW)

        expect(applied.extractionSourcePageIds).toEqual(['page-2'])
        expect(extractedPageIds(applied).has('page-2')).toBe(false)
        for (const mode of ['append', 'replace'] as const) {
            expect(selectBatch(applied, ['page-2'], mode)).toEqual({
                reason: expect.stringContaining('already has raw'),
            })
        }
    })

    it('older sessions without the list fall back to the pages their raw evidence cites', () => {
        const older = makeSession({ rawExtraction: batch('page-1') })

        expect([...extractionSourcesOf(older)]).toEqual(['page-1'])
        expect(selectBatch(older, ['page-1'], 'append')).toEqual({ reason: expect.stringContaining('already has raw') })
    })

    it('applying never rewrites the existing raw facts or unknowns', () => {
        const before = applyPreview(
            makeSession(),
            previewBatch(makeSession(), ['page-1'], 'append', batch('page-1')),
            NOW,
        )
        const after = applyPreview(before, previewBatch(before, ['page-2'], 'append', batch('page-2')), NOW)

        expect(after.rawExtraction?.parts[0]).toEqual(before.rawExtraction?.parts[0])
        expect(after.rawExtraction?.steps[0]).toEqual(before.rawExtraction?.steps[0])
        expect(after.rawExtraction?.unknowns).toEqual(expect.arrayContaining(before.rawExtraction?.unknowns ?? []))
    })
})
