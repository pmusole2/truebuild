import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dropDegenerateStepMotionShapes, stepMotionResultSchema, type StepMotionScene } from '@truebuild/contracts'
import { stepMotionOverlapIssues, shapeWorldBounds, stepMotionRepairDegraded } from './step-motion-geometry'

const box = (
    position: [number, number, number] = [0, 0, 0],
): Extract<StepMotionScene['still'][number], { type: 'box' }> => ({
    type: 'box',
    dimensions: { width: 2, height: 2, depth: 2 },
    position,
    rotation: [0, 0, 0],
})
const scene = (
    still: StepMotionScene['still'] = [box()],
    shapes: StepMotionScene['movers'][number]['shapes'] = [box()],
): StepMotionScene => ({
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

const cylinder = (
    dimensions: { radius: number; height: number },
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
): StepMotionScene['still'][number] => ({ type: 'cylinder', dimensions, position, rotation })
const block = (): Extract<StepMotionScene['still'][number], { type: 'box' }> => ({
    type: 'box',
    dimensions: { width: 20, height: 10, depth: 20 },
    position: [0, 0, 0],
    rotation: [0, 0, 0],
})
const withMotion = (value: StepMotionScene, motion: StepMotionScene['movers'][number]['motion']): StepMotionScene => ({
    ...value,
    movers: value.movers.map((mover) => ({ ...mover, motion })),
})
const loadScene = (name: string): StepMotionScene => {
    const raw: unknown = JSON.parse(
        readFileSync(new URL(`../test-support/motion-scenes/${name}.json`, import.meta.url), 'utf8'),
    )
    const parsed = stepMotionResultSchema.parse(dropDegenerateStepMotionShapes(raw))
    expect(parsed.scene).not.toBeNull()
    return parsed.scene!
}

it('seats a narrow round screw along its own axis into solid material, but not a large, boxy or misaligned screw', () => {
    const screw = (
        shape: StepMotionScene['still'][number],
        axis: [number, number, number] = [0, 1, 0],
    ): StepMotionScene => withMotion(scene([block()], [shape]), { kind: 'screw', axis, travel: 6, turns: 2 })
    const issue = ['movers.0.shapes.0:deep_static_overlap:still.0']
    // A 6-long M4-like pin penetrating 4 units of the block along its own axis.
    expect(stepMotionOverlapIssues(screw(cylinder({ radius: 1, height: 6 }, [0, 4, 0])))).toEqual([])
    const diagonal = screw(cylinder({ radius: 1, height: 6 }, [-Math.sqrt(8), Math.sqrt(8), 0], [0, 0, Math.PI / 4]), [
        -Math.SQRT1_2,
        Math.SQRT1_2,
        0,
    ])
    diagonal.still[0]!.rotation = [0, 0, Math.PI / 4]
    expect(stepMotionOverlapIssues(diagonal)).toEqual([])
    diagonal.movers[0]!.motion = { kind: 'screw', axis: [-0.71, 0.7, 0], travel: 6, turns: 2 }
    expect(stepMotionOverlapIssues(diagonal)).toEqual([])
    expect(stepMotionOverlapIssues(screw(cylinder({ radius: 4, height: 6 }, [0, 4, 0])))).toEqual(issue)
    expect(stepMotionOverlapIssues(screw(cylinder({ radius: 1, height: 6 }, [0, 4, 0]), [1, 0, 0]))).toEqual(issue)
    expect(
        stepMotionOverlapIssues(
            screw({
                type: 'box',
                dimensions: { width: 2, height: 6, depth: 2 },
                position: [0, 4, 0],
                rotation: [0, 0, 0],
            }),
        ),
    ).toEqual(issue)
})

it('sleeves a solid hub along its own axis onto a narrow coaxial shaft, but not onto a wide or off-axis shaft', () => {
    const propeller = (shaft: StepMotionScene['still'][number]): StepMotionScene =>
        withMotion(scene([shaft], [cylinder({ radius: 3, height: 3 }, [0, 3, 0])]), {
            kind: 'translate',
            from: [0, 16, 0],
            to: [0, 0, 0],
        })
    const issue = ['movers.0.shapes.0:deep_static_overlap:still.0']
    expect(stepMotionOverlapIssues(propeller(cylinder({ radius: 1.1, height: 5 }, [0, 1, 0])))).toEqual([])
    expect(stepMotionOverlapIssues(propeller(cylinder({ radius: 2.5, height: 5 }, [0, 1, 0])))).toEqual(issue)
    expect(stepMotionOverlapIssues(propeller(cylinder({ radius: 1.1, height: 5 }, [2, 1, 0])))).toEqual(issue)
})

it('keeps a real washer around a shaft clear, and does not exempt a washer whose hole is smaller than the shaft', () => {
    const shaft = cylinder({ radius: 1, height: 10 }, [0, 0, 0], [Math.PI / 2, 0, 0])
    const washer = (radius: number): StepMotionScene['still'][number] => ({
        type: 'torus',
        dimensions: { radius, tube: 0.5 },
        position: [0, 0, 0],
        rotation: [0, 0, 0],
    })
    const slidOn = (ring: StepMotionScene['still'][number]): StepMotionScene =>
        withMotion(scene([shaft], [ring]), { kind: 'translate', from: [0, 0, 5], to: [0, 0, 0] })
    expect(stepMotionOverlapIssues(slidOn(washer(2)))).toEqual([])
    expect(stepMotionOverlapIssues(slidOn(washer(1.2)))).toEqual(['movers.0.shapes.0:deep_static_overlap:still.0'])
})

it('pins the phase4 treadmill and drone scenes: seated knobs pass, handrail sockets and ring repairs are judged', () => {
    expect(stepMotionOverlapIssues(loadScene('drone-install-first'))).toEqual([])
    expect(stepMotionOverlapIssues(loadScene('drone-install-repair'))).toEqual([])
    expect(stepMotionOverlapIssues(loadScene('treadmill-step-2-try2-repair'))).toEqual([])
    expect(stepMotionOverlapIssues(loadScene('treadmill-step-2-try2-first'))).toEqual([
        'movers.0.shapes.0:deep_static_overlap:still.4',
        'movers.0.shapes.1:deep_static_overlap:still.5',
    ])
})

it('detects a repair that replaces solid parts with tiny rings, but not one that only repositions or resizes', () => {
    const before = loadScene('treadmill-step-3-first')
    const ringed = loadScene('treadmill-step-3-repair')
    expect(stepMotionRepairDegraded(before, ringed)).toBe(true)
    expect(stepMotionRepairDegraded(before, before)).toBe(false)
    expect(
        stepMotionRepairDegraded(loadScene('treadmill-step-2-try2-first'), loadScene('treadmill-step-2-try2-repair')),
    ).toBe(false)
    expect(stepMotionRepairDegraded(loadScene('drone-install-first'), loadScene('drone-install-repair'))).toBe(false)
    const moved: StepMotionScene = {
        ...before,
        still: before.still.map((shape) => ({
            ...shape,
            position: [shape.position[0] + 3, shape.position[1], shape.position[2]] as [number, number, number],
        })),
    }
    expect(stepMotionRepairDegraded(before, moved)).toBe(false)
    const hoop: StepMotionScene['still'][number] = {
        type: 'torus',
        dimensions: { radius: 0.9, tube: 0.1 },
        position: [-8, 18, -16],
        rotation: [0, 0, 0],
    }
    const tinyRing: StepMotionScene = {
        ...before,
        still: before.still.map((shape, index) => (index === 2 ? hoop : shape)),
    }
    expect(stepMotionRepairDegraded(before, tinyRing)).toBe(true)
})

it('judges moving-piece collapse independently of static scale and ignores corrected rotation', () => {
    const large = { ...block(), dimensions: { width: 100, height: 100, depth: 100 } }
    const part = { ...box([0, 55, 0]), dimensions: { width: 10, height: 10, depth: 10 } }
    const original = scene([large], [part])
    const collapsed = scene([large], [{ ...part, dimensions: { width: 0.01, height: 0.01, depth: 0.01 } }])
    expect(stepMotionRepairDegraded(original, collapsed)).toBe(true)
    const rod = cylinder({ radius: 1, height: 20 }, [50, 50, 50], [0, 0, Math.PI / 4])
    expect(stepMotionRepairDegraded(scene([box()], [rod]), scene([box()], [{ ...rod, rotation: [0, 0, 0] }]))).toBe(
        false,
    )
})
