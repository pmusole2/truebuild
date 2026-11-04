import type { PieceSpec, StepMotionScene } from '@truebuild/contracts'

type Shape = PieceSpec['parts'][number]
type Vector = [number, number, number]

const box = (width: number, height: number, depth: number, position: Vector): Shape => ({
    type: 'box',
    dimensions: { width, height, depth },
    position,
    rotation: [0, 0, 0],
})

const cylinder = (radius: number, height: number, position: Vector, rotation: Vector = [0, 0, 0]): Shape => ({
    type: 'cylinder',
    dimensions: { radius, height },
    position,
    rotation,
})

// Hand-authored recorded fixtures. No geometry here came from a model call.
// Reference: a treadmill handrail rises around its base hinge, then each knob seats and turns separately.
const hinge: StepMotionScene = {
    version: 1,
    stepId: 'hinge-up',
    still: [
        box(2.5, 0.24, 4.8, [0, 0.12, -1.15]),
        box(1.9, 0.025, 3.8, [0, 0.252, -1.25]),
        box(0.24, 0.55, 0.55, [-1.06, 0.3, 0.65]),
        box(0.24, 0.55, 0.55, [1.06, 0.3, 0.65]),
    ],
    movers: [
        {
            label: 'Upright frame',
            shapes: [
                box(0.14, 2.4, 0.14, [-0.99, 1.5, 0.65]),
                box(0.14, 2.4, 0.14, [0.99, 1.5, 0.65]),
                box(2.12, 0.18, 0.18, [0, 2.68, 0.65]),
                box(0.55, 0.16, 0.6, [-0.99, 2.22, 0.4]),
                box(0.55, 0.16, 0.6, [0.99, 2.22, 0.4]),
                box(1.2, 0.24, 0.38, [0, 2.65, 0.59]),
            ],
            motion: { kind: 'rotate', pivot: [0, 0.3, 0.65], axis: [1, 0, 0], fromDeg: 0, toDeg: 90 },
            actionIndex: 0,
        },
        ...([-0.99, 0.99] as const).map((x, index) => ({
            label: `Fastener ${index + 1}`,
            shapes: [
                cylinder(0.15, 0.14, [x, 0.43, 0.99], [Math.PI / 2, 0, 0]),
                cylinder(0.055, 0.32, [x, 0.43, 0.8], [Math.PI / 2, 0, 0]),
                box(0.34, 0.075, 0.1, [x, 0.43, 1.03]),
            ],
            motion: { kind: 'screw' as const, axis: [0, 0, -1] as Vector, travel: 0.4, turns: 1.5 },
            actionIndex: 1,
        })),
    ],
    caption: 'Raise the frame, then seat and turn both fasteners.',
}

// Reference: a drone blade aligns above its shaft and presses straight down to its seated height.
const press: StepMotionScene = {
    version: 1,
    stepId: 'press-down',
    still: [
        cylinder(0.65, 0.16, [0, 0.08, 0]),
        cylinder(0.39, 0.55, [0, 0.425, 0]),
        cylinder(0.07, 0.22, [0, 0.81, 0]),
        box(1.4, 0.16, 0.32, [0.92, 0.16, 0]),
    ],
    movers: [
        {
            label: 'Upper part',
            shapes: [
                {
                    type: 'extrude',
                    outline: [
                        [-1.65, -0.04],
                        [-1.48, -0.25],
                        [-0.35, -0.2],
                        [-0.15, -0.12],
                        [0.32, -0.1],
                        [1.65, -0.04],
                        [1.48, 0.25],
                        [0.35, 0.2],
                        [0.15, 0.12],
                        [-0.32, 0.1],
                    ],
                    depth: 0.07,
                    bevel: undefined,
                    position: [0, 0.77, 0],
                    rotation: [Math.PI / 2, 0, 0],
                },
                cylinder(0.2, 0.21, [0, 0.805, 0]),
                cylinder(0.12, 0.06, [0, 0.94, 0]),
            ],
            motion: { kind: 'translate', from: [0, 1.2, 0], to: [0, 0, 0] },
            actionIndex: 0,
        },
    ],
    caption: 'Align the opening with the shaft and press straight down.',
}

// Reference: a flat-pack shelf panel slides horizontally between the two sides of a frame.
const slide: StepMotionScene = {
    version: 1,
    stepId: 'slide-in',
    still: [
        box(0.16, 2.5, 1.5, [-1.25, 1.25, 0]),
        box(0.16, 2.5, 1.5, [1.25, 1.25, 0]),
        box(2.66, 0.16, 1.5, [0, 0.08, 0]),
        box(2.66, 0.16, 1.5, [0, 2.42, 0]),
        box(0.13, 0.1, 1.5, [-1.12, 1.18, 0]),
        box(0.13, 0.1, 1.5, [1.12, 1.18, 0]),
    ],
    movers: [
        {
            label: 'Flat panel',
            shapes: [box(2.32, 0.13, 1.45, [0, 1.29, 0])],
            motion: { kind: 'translate', from: [0, 0, 2], to: [0, 0, 0] },
            actionIndex: 0,
        },
    ],
    caption: 'Slide the panel along the supports until it sits inside the frame.',
}

/** Inventory inspection has no physical movement and deliberately has no scene. */
export const RECORDED_STEP_MOTION_SCENES = { hinge, press, slide, inspect: null } as const
export type RecordedStepMotionKind = keyof typeof RECORDED_STEP_MOTION_SCENES
