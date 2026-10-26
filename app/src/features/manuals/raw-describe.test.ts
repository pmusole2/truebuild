import { manualSessionSchema, type ParsedManual } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { citedPageIdsOf, describeRawStep, uncitedPages } from './raw-describe'

const HASH = 'e'.repeat(64)
const cite = [{ pageId: 'page-1', region: null }]

const parsed: ParsedManual = {
    parts: [{ partId: 'p1', name: { state: 'known', value: 'Side panel', sourceRefs: cite } }],
    steps: [
        {
            stepId: 's1',
            order: 1,
            title: 'Stand the panel',
            parts: [{ partId: 'p1', quantity: { state: 'unknown', reason: 'Quantity not legible.' } }],
            orientation: { state: 'known', value: { partId: 'p1', description: 'Groove inward.' }, sourceRefs: cite },
            connection: { state: 'unknown', reason: 'Connection not shown.' },
            visibleChecks: [],
            sourceRefs: cite,
            correction: {
                reviewed: false,
                actions: [{ actionId: 'a1', instruction: 'Turn the panel.', sourceRefs: cite }],
            },
        },
    ],
    unknowns: [],
}

describe('describeRawStep', () => {
    it('shows unknown facts with their reasons, the proposal as unconfirmed, and the cited page number', () => {
        const lines = describeRawStep(parsed.steps[0]!, parsed.parts, (pageId) => (pageId === 'page-1' ? 1 : undefined))

        expect(lines).toContain('Part Side panel: quantity unknown (Quantity not legible.)')
        expect(lines).toContain('Connection unknown: Connection not shown.')
        expect(lines).toContain('Proposed correction (not confirmed): Turn the panel.')
        expect(lines).toContain('Cited: page 1')
    })
})

describe('evidence custody', () => {
    it('lists every page cited anywhere in the result, and only those', () => {
        const session = manualSessionSchema.parse({
            manualId: 'm',
            title: 't',
            updatedAt: '2026-10-26T10:00:00.000Z',
            revision: 1,
            pages: [1, 2].map((index) => ({
                pageId: `page-${index}`,
                assetId: `asset-${index}`,
                width: 10,
                height: 10,
                mimeType: 'image/jpeg',
                contentHash: HASH,
            })),
            parts: [],
            rawExtraction: null,
            reviewedSteps: [],
            reviewStatus: 'unreviewed',
        })

        expect([...citedPageIdsOf(parsed)]).toEqual(['page-1'])
        expect(uncitedPages(session.pages, parsed).map((page) => page.pageId)).toEqual(['page-2'])
    })
})
