import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dropDegenerateStepMotionShapes, stepMotionResultSchema, type StepMotionScene } from '@truebuild/contracts'
import { stepMotionOverlapIssues, shapeWorldBounds } from './step-motion-geometry'

const box = (position: [number, number, number] = [0, 0, 0]): StepMotionScene['still'][number] => ({
    type: 'box',
    dimensions: { width: 2, height: 2, depth: 2 },
    position,
    rotation: [0, 0, 0],
})
const scene = (still = [box()], shapes = [box()]): StepMotionScene => ({
    version: 1,
    stepId: 'step-1',
    still,
    movers: [
        { label: 'Part', shapes, motion: { kind: 'translate', from: [0, 10, 0], to: [0, 8, 0] }, actionIndex: null },
    ],
    caption: 'Place the part.',
})

it('checks deep primitive overlap at the finished identity pose, allowing contact, small penetration and gaps', () => {
    expect(stepMotionOverlapIssues(scene())).toEqual(['movers.0.shapes.0:deep_static_overlap:still.0'])
    for (const x of [2, 1.99, 3]) expect(stepMotionOverlapIssues(scene([box()], [box([x, 0, 0])]))).toEqual([])
    expect(stepMotionOverlapIssues(scene([box([-3, 0, 0]), box([3, 0, 0])], [box()]))).toEqual([])
    const torus: StepMotionScene['still'][number] = {
        type: 'torus',
        dimensions: { radius: 5, tube: 1 },
        position: [0, 0, 0],
        rotation: [0, 0, 0],
    }
    expect(stepMotionOverlapIssues(scene([torus], [box()]))).toEqual([])
    const outline: [number, number][] = [
        [0, 0],
        [4, 0],
        [4, 1],
        [1, 1],
        [1, 4],
        [0, 4],
    ]
    expect(
        stepMotionOverlapIssues(
            scene(
                [{ type: 'extrude', bevel: undefined, outline, depth: 4, position: [0, 0, 0], rotation: [0, 0, 0] }],
                [box([2.5, 2.5, 2])],
            ),
        ),
    ).toEqual([])
})

it('uses local extrude Z 0..depth, mesh XYZ radians then translation, without applying motion.to again', () => {
    const part: StepMotionScene['still'][number] = {
        type: 'extrude',
        bevel: undefined,
        outline: [
            [0, 0],
            [2, 0],
            [2, 4],
            [0, 4],
        ],
        depth: 6,
        position: [10, 20, 30],
        rotation: [Math.PI / 2, Math.PI / 2, 0],
    }
    const bounds = shapeWorldBounds(part)
    // R = Rx * Ry * Rz: local (x,y,z) becomes (z,x,y).
    expect(bounds.min).toEqual([10, 20, 30])
    bounds.max.forEach((coordinate, index) => expect(coordinate).toBeCloseTo([16, 22, 34][index]!, 10))
})

it('checks saved phase3 scene-only regressions using the same generic rules', () => {
    const observed: Record<string, { shapes: number; overlap: boolean }> = {}
    for (const name of ['noble-step-1', 'noble-step-2', 'ikea-step-1', 'rogue-step-1']) {
        const raw: unknown = JSON.parse(
            readFileSync(new URL(`../test-support/motion-scenes/${name}.json`, import.meta.url), 'utf8'),
        )
        const parsed = stepMotionResultSchema.parse(dropDegenerateStepMotionShapes(raw))
        expect(parsed.scene).not.toBeNull()
        const value = parsed.scene!
        observed[name] = {
            shapes: value.still.length + value.movers.reduce((sum, mover) => sum + mover.shapes.length, 0),
            overlap: stepMotionOverlapIssues(value).length > 0,
        }
    }
    expect(observed).toEqual({
        'noble-step-1': { shapes: 4, overlap: true },
        'noble-step-2': { shapes: 3, overlap: false },
        'ikea-step-1': { shapes: 4, overlap: true },
        'rogue-step-1': { shapes: 3, overlap: true },
    })
})
