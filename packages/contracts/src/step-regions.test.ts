import { describe, expect, it } from 'vitest'

import { checkResultSchema, partRegionSchema, questionResultSchema } from './index'

// Synthetic contract values only: not recorded or live provider output.
const region = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
const nextPartRegion = { partId: 'side-panel', region }
const targetRegion = { partId: 'side-panel', region: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 } }
const check = {
    decision: 'cannot_verify',
    orientationAssessment: 'uncertain',
    reason: 'Synthetic result',
    sourceRefs: [],
    observedRegion: null,
    missingEvidence: ['Synthetic gap'],
}
const question = { answer: 'Synthetic answer', sourceRefs: [], missingEvidence: [] }

describe('partRegionSchema', (): void => {
    it('accepts a part identity with a normalized box strictly inside the image', (): void => {
        expect(partRegionSchema.parse(nextPartRegion)).toEqual(nextPartRegion)
        expect(partRegionSchema.safeParse({ partId: 'a', region: { x: 0, y: 0, width: 1, height: 1 } }).success).toBe(
            true,
        )
    })

    it.each([
        ['extends past the right edge', { partId: 'a', region: { x: 0.8, y: 0, width: 0.3, height: 0.1 } }],
        ['extends past the bottom edge', { partId: 'a', region: { x: 0, y: 0.9, width: 0.1, height: 0.2 } }],
        ['has zero area', { partId: 'a', region: { x: 0.1, y: 0.1, width: 0, height: 0.1 } }],
        ['has a negative origin', { partId: 'a', region: { x: -0.1, y: 0, width: 0.1, height: 0.1 } }],
        ['has an empty part id', { partId: '', region }],
        ['has no part id', { region }],
        ['has an extra key', { partId: 'a', region, label: 'x' }],
        ['has an extra region key', { partId: 'a', region: { ...region, z: 1 } }],
        [
            'uses the 0-1000 grid instead of normalized units',
            { partId: 'a', region: { x: 100, y: 200, width: 300, height: 400 } },
        ],
    ])('rejects a region that %s', (_label, value): void => {
        expect(partRegionSchema.safeParse(value).success).toBe(false)
    })
})

describe.each([
    ['check', checkResultSchema, check],
    ['question', questionResultSchema, question],
])('%s result next-part and target regions', (_name, schema, base): void => {
    it('stays valid and absent without either region (backward compatible)', (): void => {
        const parsed = schema.parse(base)
        expect(parsed).not.toHaveProperty('nextPartRegion')
        expect(parsed).not.toHaveProperty('targetRegion')
    })

    it('carries both optional regions unchanged', (): void => {
        expect(schema.parse({ ...base, nextPartRegion, targetRegion })).toMatchObject({ nextPartRegion, targetRegion })
        expect(schema.parse({ ...base, nextPartRegion })).not.toHaveProperty('targetRegion')
    })

    it.each([
        ['null next-part region', { nextPartRegion: null }],
        ['null target region', { targetRegion: null }],
        [
            'out-of-bounds next-part region',
            { nextPartRegion: { partId: 'a', region: { x: 0.9, y: 0, width: 0.5, height: 0.1 } } },
        ],
        ['extra key on a target region', { targetRegion: { ...targetRegion, label: 'x' } }],
        ['bare box without part identity', { nextPartRegion: region }],
    ])('rejects %s', (_label, extra): void => {
        expect(schema.safeParse({ ...base, ...extra }).success).toBe(false)
    })
})
