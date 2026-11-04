import { describe, expect, it } from 'vitest'
import { Vector3, type Mesh } from 'three'
import type { StepMotionScene } from '@truebuild/contracts'
import {
    createStepMotionObject,
    poseStepMotionObject,
    stepMotionClock,
    stepMotionProgress,
    type StepMotionClock,
    type StepMotionObject,
} from './step-motion-scene'
import { disposePieceObject } from '../pieces/piece-scene'

const box = (x: number, y: number, z: number): StepMotionScene['still'][number] => ({
    type: 'box' as const,
    dimensions: { width: 0.2, height: 0.2, depth: 0.2 },
    position: [x, y, z] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
})

// Mover 0 is a rotation of one part about the y axis (-90° to finished). Mover 1 is a screw about the same axis whose
// two parts sit either side of its centre at (0, 2, 0), so rotation and travel are both visible.
const scene: StepMotionScene = {
    version: 1,
    stepId: 'rotate-then-screw',
    still: [box(0, 0, 0)],
    movers: [
        {
            label: 'Arm',
            shapes: [box(1, 0, 0)],
            motion: { kind: 'rotate', pivot: [0, 0, 0], axis: [0, 1, 0], fromDeg: -90, toDeg: 0 },
            actionIndex: 0,
        },
        {
            label: 'Knob',
            shapes: [box(-1, 2, 0), box(1, 2, 0)],
            motion: { kind: 'screw', axis: [0, 1, 0], travel: 2, turns: 1 },
            actionIndex: 1,
        },
    ],
    caption: 'Turn the arm, then the knob.',
}

const clock = (mover: number, eased: number): StepMotionClock => ({ finished: false, mover, eased })
const finished: StepMotionClock = { finished: true, mover: null, eased: 1 }

/** Mesh n of mover m, in world coordinates after the pose has been applied. */
function worldPoint(object: StepMotionObject, mover: number, part: number): Vector3 {
    return (object.movers[mover]!.group.children[part] as Mesh).getWorldPosition(new Vector3())
}

const expectPoint = (point: Vector3, expected: [number, number, number]): void => {
    expect(point.x).toBeCloseTo(expected[0], 9)
    expect(point.y).toBeCloseTo(expected[1], 9)
    expect(point.z).toBeCloseTo(expected[2], 9)
}

describe('step motion pure model', () => {
    it('runs rotate then screw to the finished pose, with start, middle and end matching the model', () => {
        const object = createStepMotionObject(scene)
        try {
            // Rotate: starts at (fromDeg - toDeg) = -90° about the pivot, passes -45° at the midpoint, and ends at identity.
            poseStepMotionObject(object, clock(0, 0))
            expectPoint(worldPoint(object, 0, 0), [0, 0, 1])
            poseStepMotionObject(object, clock(0, 0.5))
            expectPoint(worldPoint(object, 0, 0), [Math.SQRT1_2, 0, Math.SQRT1_2])

            // Screw: while the arm is at rest, the knob starts offset by -travel·axis and rotated -2π about its centre.
            poseStepMotionObject(object, clock(1, 0))
            expectPoint(worldPoint(object, 0, 0), [1, 0, 0])
            expectPoint(worldPoint(object, 1, 0), [-1, 0, 0])
            expectPoint(worldPoint(object, 1, 1), [1, 0, 0])
            poseStepMotionObject(object, clock(1, 0.5))
            expectPoint(worldPoint(object, 1, 0), [1, 1, 0])
            expectPoint(worldPoint(object, 1, 1), [-1, 1, 0])

            // The terminal pose is the identity for every mover, so the assembled model is exactly its finished shapes.
            poseStepMotionObject(object, finished)
            expectPoint(worldPoint(object, 0, 0), [1, 0, 0])
            expectPoint(worldPoint(object, 1, 0), [-1, 2, 0])
            expectPoint(worldPoint(object, 1, 1), [1, 2, 0])
        } finally {
            disposePieceObject(object.root)
        }
    })

    it('runs movers back to back, holds once after the whole sequence, then stops after three loops', () => {
        // Two movers: 2 × 2.4 s of motion, then one 0.6 s hold after the sequence. A loop is 5.4 s; three loops are 16.2 s.
        expect(stepMotionClock(2, 0)).toEqual({ finished: false, mover: 0, eased: 0 })
        expect(stepMotionClock(2, 2400)).toEqual({ finished: false, mover: 1, eased: 0 })
        expect(stepMotionClock(2, 4800)).toEqual({ finished: false, mover: null, eased: 1 })
        expect(stepMotionClock(2, 5399).mover).toBeNull()
        expect(stepMotionClock(2, 5400)).toEqual({ finished: false, mover: 0, eased: 0 })
        expect(stepMotionClock(2, 16199).mover).toBeNull()
        expect(stepMotionClock(2, 16200)).toEqual(finished)
        expect(stepMotionClock(2, Number.POSITIVE_INFINITY)).toEqual(finished)
        // Mover progress: earlier movers rest finished, later ones wait at start, and the hold is all finished.
        expect(stepMotionProgress({ finished: false, mover: 1, eased: 0.25 }, 0)).toBe(1)
        expect(stepMotionProgress({ finished: false, mover: 1, eased: 0.25 }, 1)).toBe(0.25)
        expect(stepMotionProgress({ finished: false, mover: 1, eased: 0.25 }, 2)).toBe(0)
        expect(stepMotionProgress({ finished: false, mover: null, eased: 1 }, 0)).toBe(1)
    })
})
