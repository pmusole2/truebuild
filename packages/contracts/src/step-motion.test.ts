import { describe, expect, it } from 'vitest'
import { paddedStepFigureBox, stepMotionSceneSchema } from './step-motion'
import { createDemoManual, manualStepSchema } from './index'

const shape = {
    type: 'box',
    dimensions: { width: 2, height: 1, depth: 1 },
    position: [0, 0, 0],
    rotation: [0, 0, 0],
}
const motions = [
    { kind: 'rotate', pivot: [0, 0, 0], axis: [0, 0, 1], fromDeg: -90, toDeg: 0 },
    { kind: 'translate', from: [0, 2, 0], to: [0, 0, 0] },
    { kind: 'screw', axis: [0, 1, 0], travel: 0.5, turns: 2 },
]
const scene = (motion: unknown): object => ({
    version: 1,
    stepId: 'step-1',
    still: [shape],
    movers: [{ label: 'Part', shapes: [shape], motion, actionIndex: null }],
    caption: 'Place the part as shown.',
})

describe('step motion contract', () => {
    it('keeps optional verbatim source text compatible with saved and wordless steps', () => {
        const legacy = createDemoManual().rawExtraction!.steps[0]!
        const sourceText = '  Tournez la pièce.\nSerrez-la.  '
        expect(manualStepSchema.parse(legacy)).toEqual(legacy)
        expect(manualStepSchema.parse({ ...legacy, sourceText }).sourceText).toBe(sourceText)
        expect(manualStepSchema.parse({ ...legacy, sourceText: null }).sourceText).toBeNull()
        expect(manualStepSchema.safeParse({ ...legacy, sourceText: 'x'.repeat(601) }).success).toBe(false)
    })

    it('accepts rounded unit axes without rewriting them and pads figure regions within the page', () => {
        const rounded = scene({ ...motions[0], axis: [0.707, 0, 0.707] })
        expect(stepMotionSceneSchema.parse(rounded)).toEqual(rounded)
        const padded = paddedStepFigureBox([0.25, 0.25, 0.5, 0.5])
        for (const [index, value] of [0.2, 0.2, 0.6, 0.6].entries()) expect(padded[index]).toBeCloseTo(value, 9)
        const clipped = paddedStepFigureBox([0, 0.9, 0.2, 0.1])
        expect(clipped[0]).toBe(0)
        expect(clipped[1] + clipped[3]).toBe(1)
    })
    it.each(motions)('accepts a bounded $kind scene and its finished geometry', (motion) => {
        expect(stepMotionSceneSchema.parse(scene(motion))).toEqual(scene(motion))
    })

    it('accepts a three-mover sequence and a null scene', () => {
        const sequence = {
            ...scene(motions[0]),
            movers: motions.map((motion, actionIndex) => ({ label: 'Part', shapes: [shape], motion, actionIndex })),
        }
        expect(stepMotionSceneSchema.parse(sequence)).toEqual(sequence)
        expect(stepMotionSceneSchema.parse(null)).toBeNull()
    })

    it('rejects out-of-range, non-finite, non-unit, extra and excessive data without repairing it', () => {
        for (const motion of [
            { ...motions[0], fromDeg: 181 },
            { ...motions[0], pivot: [Number.NaN, 0, 0] },
            { ...motions[0], axis: [0, 0, 2] },
            { ...motions[1], from: [Infinity, 0, 0] },
            { ...motions[2], turns: 5 },
            { ...motions[2], travel: 101 },
        ])
            expect(stepMotionSceneSchema.safeParse(scene(motion)).success).toBe(false)
        expect(stepMotionSceneSchema.safeParse({ ...scene(motions[0]), extra: true }).success).toBe(false)
        expect(stepMotionSceneSchema.safeParse({ ...scene(motions[0]), still: Array(25).fill(shape) }).success).toBe(
            false,
        )
        const invalidShape = { ...shape, position: [0, 1001, 0] }
        expect(stepMotionSceneSchema.safeParse({ ...scene(motions[0]), still: [invalidShape] }).success).toBe(false)
    })
})
