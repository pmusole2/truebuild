import { createDemoManual, layoutSchema, type ManualStep } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { fallbackLayout, resolveLayout, withResolvedLayout, type LayoutContext } from './layout'

// Synthetic demo manual and hand-written proposals: unit data only, not recorded or live model output.
const session = createDemoManual()
const step1 = session.reviewedSteps[0]!
const step2 = session.reviewedSteps[1]!
const context = (step: ManualStep = step1, decision: LayoutContext['decision'] = 'refuse'): LayoutContext => ({
    step,
    decision,
    pageIds: ['demo-page-1'],
})
const proposal = (...components: unknown[]): unknown => ({ components })

describe('layout reference resolution against the current step', (): void => {
    it('keeps a fully valid proposal in its proposed order and marks it as model-proposed', (): void => {
        const components = [
            { type: 'orientation', partId: 'side-panel' },
            { type: 'part_grid', partIds: ['side-panel'] },
            { type: 'visible_checks', checkIds: ['groove-inward'] },
            { type: 'source_diagram', sourceRefIndexes: [0] },
            { type: 'connection', partIds: ['side-panel'] },
            { type: 'recovery', actionIds: ['turn-panel'] },
        ]
        expect(resolveLayout({ components }, context())).toEqual({ source: 'model', components })
    })

    it.each([
        ['a part from another step', proposal({ type: 'part_grid', partIds: ['divider'] })],
        ['an orientation of another part', proposal({ type: 'orientation', partId: 'divider' })],
        ['a connection part outside the step', proposal({ type: 'connection', partIds: ['side-panel', 'divider'] })],
        ['an unknown check', proposal({ type: 'visible_checks', checkIds: ['divider-seated'] })],
        ['an out-of-range diagram index', proposal({ type: 'source_diagram', sourceRefIndexes: [1] })],
        ['an unknown recovery action', proposal({ type: 'recovery', actionIds: ['reseat-divider'] })],
        [
            'a valid and an invalid component together',
            proposal({ type: 'part_grid', partIds: ['side-panel'] }, { type: 'recovery', actionIds: ['x'] }),
        ],
        ['an unknown component', proposal({ type: 'banner' })],
        ['extra keys', { components: [{ type: 'part_grid', partIds: ['side-panel'] }], css: 'x' }],
        [
            'an oversized list',
            proposal(...Array.from({ length: 9 }, () => ({ type: 'part_grid', partIds: ['side-panel'] }))),
        ],
    ])('replaces %s with the deterministic step fallback', (_name, bad): void => {
        expect(resolveLayout(bad, context())).toEqual(fallbackLayout(context()))
    })

    it('falls back when the proposal is missing, null, or not an object', (): void => {
        for (const missing of [undefined, null, 'text', 3, []]) {
            expect(resolveLayout(missing, context())).toEqual(fallbackLayout(context()))
        }
    })

    it("uses another step's ids only when that step is the current one", (): void => {
        const divider = proposal({ type: 'part_grid', partIds: ['divider'] })
        expect(resolveLayout(divider, context(step1)).source).toBe('fallback')
        expect(resolveLayout(divider, context(step2)).source).toBe('model')
    })

    it('allows recovery only for a refusal with a human-reviewed correction', (): void => {
        const recovery = proposal({ type: 'recovery', actionIds: ['turn-panel'] })
        expect(resolveLayout(recovery, context(step1, 'refuse')).source).toBe('model')
        for (const decision of ['pass', 'cannot_verify', undefined] as const) {
            expect(resolveLayout(recovery, { ...context(step1), decision }).source).toBe('fallback')
        }
        const unreviewed = { ...step1, correction: { ...step1.correction!, reviewed: false } }
        expect(resolveLayout(recovery, context(unreviewed, 'refuse')).source).toBe('fallback')
        expect(resolveLayout(recovery, context({ ...step1, correction: null }, 'refuse')).source).toBe('fallback')
    })

    it('rejects diagram indexes whose page was not supplied and unknown orientation or connection facts', (): void => {
        const diagram = proposal({ type: 'source_diagram', sourceRefIndexes: [0] })
        expect(resolveLayout(diagram, { ...context(), pageIds: ['other-page'] }).source).toBe('fallback')
        const unknown = { state: 'unknown', reason: 'Synthetic unknown' } as const
        const unresolved = { ...step1, orientation: unknown, connection: unknown }
        expect(resolveLayout(proposal({ type: 'orientation', partId: 'side-panel' }), context(unresolved)).source).toBe(
            'fallback',
        )
        expect(
            resolveLayout(proposal({ type: 'connection', partIds: ['side-panel'] }), context(unresolved)).source,
        ).toBe('fallback')
    })
})

describe('deterministic fallback from validated step data', (): void => {
    it('derives ordered references that the public schema accepts', (): void => {
        const layout = fallbackLayout(context(step1, 'refuse'))
        expect(layout).toEqual({
            source: 'fallback',
            components: [
                { type: 'part_grid', partIds: ['side-panel'] },
                { type: 'orientation', partId: 'side-panel' },
                { type: 'connection', partIds: ['side-panel'] },
                { type: 'visible_checks', checkIds: ['groove-inward'] },
                { type: 'source_diagram', sourceRefIndexes: [0] },
                { type: 'recovery', actionIds: ['turn-panel'] },
            ],
        })
        expect(layoutSchema.safeParse(layout).success).toBe(true)
        expect(fallbackLayout(context(step1, 'refuse'))).toEqual(layout)
    })

    it('omits recovery without a refusal, omits unknown facts, and bounds oversized steps', (): void => {
        expect(fallbackLayout(context(step1, 'pass')).components.map((c) => c.type)).not.toContain('recovery')
        const unknown = { state: 'unknown', reason: 'Synthetic unknown' } as const
        const sparse = { ...step1, orientation: unknown, connection: unknown, visibleChecks: [], sourceRefs: [] }
        expect(fallbackLayout(context(sparse, 'pass'))).toEqual({
            source: 'fallback',
            components: [{ type: 'part_grid', partIds: ['side-panel'] }],
        })
        const many = Array.from({ length: 12 }, (_, i) => ({ ...step1.parts[0]!, partId: `part-${i}` }))
        const grid = fallbackLayout(context({ ...step1, parts: many, orientation: unknown }, 'pass')).components[0]
        expect(grid).toEqual({ type: 'part_grid', partIds: many.slice(0, 8).map((part) => part.partId) })
        expect(fallbackLayout(context({ ...sparse, parts: [] }, 'pass'))).toEqual({
            source: 'fallback',
            components: [],
        })
    })
})

describe('applying the flag at the result boundary', (): void => {
    const input = { session, binding: { stepId: 'step-1' }, sourceImages: [{ page: session.pages[0]! }] }
    const verdict = { decision: 'cannot_verify' as const, reason: 'Synthetic', sourceRefs: [], missingEvidence: [] }

    it('removes any proposal when disabled without touching the verdict', (): void => {
        const result = { ...verdict, layout: { components: [{ type: 'part_grid' as const, partIds: ['side-panel'] }] } }
        const applied = withResolvedLayout(result, input, false)
        expect(applied).toEqual(verdict)
        expect(applied).not.toHaveProperty('layout')
    })

    it('resolves or falls back when enabled and keeps every other field', (): void => {
        const proposed = { components: [{ type: 'part_grid' as const, partIds: ['side-panel'] }] }
        expect(withResolvedLayout({ ...verdict, layout: proposed }, input, true)).toEqual({
            ...verdict,
            layout: { source: 'model', ...proposed },
        })
        const missing = withResolvedLayout(verdict, input, true)
        expect(missing).toMatchObject({ ...verdict, layout: { source: 'fallback' } })
    })

    it('leaves the result without a layout when the bound step is not in the session', (): void => {
        expect(withResolvedLayout(verdict, { ...input, binding: { stepId: 'step-9' } }, true)).toEqual(verdict)
    })
})
