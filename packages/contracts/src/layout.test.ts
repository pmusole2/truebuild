import { describe, expect, it } from 'vitest'

import { checkResultSchema, questionResultSchema } from './index'
import { layoutComponentSchema, layoutSchema, proposedLayoutSchema } from './layout'

// Synthetic unit data only: no model output, recording or live capture is represented here.
const grid = { type: 'part_grid', partIds: ['side-panel', 'divider'] }
const orientation = { type: 'orientation', partId: 'side-panel' }
const base = {
    decision: 'cannot_verify',
    reason: 'Synthetic result',
    sourceRefs: [],
    observedRegion: null,
    missingEvidence: ['Synthetic evidence gap'],
}

describe('closed layout contract (synthetic unit data)', (): void => {
    it('accepts every closed component with ordered id and index references', (): void => {
        const components = [
            grid,
            orientation,
            { type: 'connection', partIds: ['side-panel'] },
            { type: 'visible_checks', checkIds: ['groove-inward'] },
            { type: 'source_diagram', sourceRefIndexes: [0] },
            { type: 'recovery', actionIds: ['turn-panel'] },
        ]
        expect(proposedLayoutSchema.parse({ components })).toEqual({ components })
        expect(layoutSchema.parse({ source: 'fallback', components })).toEqual({ source: 'fallback', components })
    })

    it.each([
        ['unknown component', { type: 'banner', partIds: ['a'] }],
        ['free text on a component', { ...grid, label: 'Warning: do not do this' }],
        ['style key', { ...orientation, style: { color: 'red' } }],
        ['url key', { type: 'source_diagram', sourceRefIndexes: [0], url: 'https://example.invalid' }],
        ['empty reference list', { type: 'part_grid', partIds: [] }],
        ['nine references', { type: 'part_grid', partIds: Array.from({ length: 9 }, (_, i) => `p${i}`) }],
        ['negative index', { type: 'source_diagram', sourceRefIndexes: [-1] }],
        ['fractional index', { type: 'source_diagram', sourceRefIndexes: [0.5] }],
        ['over-long id', { type: 'orientation', partId: 'x'.repeat(129) }],
        ['unavailable warning component', { type: 'manufacturer_warning', warningIndex: 0 }],
    ])('rejects %s', (_name, component): void => {
        expect(layoutComponentSchema.safeParse(component).success).toBe(false)
        expect(proposedLayoutSchema.safeParse({ components: [component] }).success).toBe(false)
    })

    it('rejects unknown layout keys, an empty or oversized list, and repeated components or references', (): void => {
        expect(proposedLayoutSchema.safeParse({ components: [grid], css: 'x' }).success).toBe(false)
        expect(proposedLayoutSchema.safeParse({ components: [] }).success).toBe(false)
        expect(proposedLayoutSchema.safeParse({ source: 'model', components: [grid] }).success).toBe(false)
        const nine = Array.from({ length: 9 }, () => grid)
        expect(proposedLayoutSchema.safeParse({ components: nine }).success).toBe(false)
        expect(layoutSchema.safeParse({ components: nine }).success).toBe(false)
        expect(proposedLayoutSchema.safeParse({ components: [grid, grid] }).success).toBe(false)
        expect(
            proposedLayoutSchema.safeParse({ components: [{ type: 'part_grid', partIds: ['a', 'a'] }] }).success,
        ).toBe(false)
        expect(layoutSchema.safeParse({ source: 'invented', components: [grid] }).success).toBe(false)
    })

    it('is an additive optional field on check and question results', (): void => {
        const layout = { source: 'model', components: [grid] }
        expect(checkResultSchema.parse({ ...base, layout }).layout).toEqual(layout)
        expect(checkResultSchema.parse(base).layout).toBeUndefined()
        expect(checkResultSchema.safeParse({ ...base, layout: { components: [{ type: 'banner' }] } }).success).toBe(
            false,
        )
        const question = { answer: 'Synthetic answer', sourceRefs: [], missingEvidence: [] }
        expect(questionResultSchema.parse({ ...question, layout }).layout).toEqual(layout)
        expect(questionResultSchema.parse(question).layout).toBeUndefined()
    })
})
