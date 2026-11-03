import { describe, expect, it } from 'vitest'
import { stepMotionSceneSchema } from './step-motion'

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
