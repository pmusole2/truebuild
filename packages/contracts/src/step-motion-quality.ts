import { PIECE_SPEC_LIMITS } from './piece-spec'
import type { StepMotionScene } from './step-motion'

type Shape = StepMotionScene['still'][number]
type Point = [number, number, number]
export type StepMotionBounds = { min: Point; max: Point }
type Matrix = [Point, Point, Point]

/** Three's default Euler XYZ uses R = Rx * Ry * Rz, then Mesh.position adds the world translation. */
export function stepMotionShapeRotation([x, y, z]: readonly [number, number, number]): Matrix {
    const a = Math.cos(x),
        b = Math.sin(x),
        c = Math.cos(y),
        d = Math.sin(y),
        e = Math.cos(z),
        f = Math.sin(z)
    return [
        [c * e, -c * f, d],
        [a * f + b * d * e, a * e - b * d * f, -b * c],
        [b * f - a * d * e, b * e + a * d * f, a * c],
    ]
}

/** A primitive's bounds in its own local frame, before rotation and position. */
export function stepMotionShapeLocalBounds(shape: Shape): StepMotionBounds {
    if (shape.type === 'extrude') {
        const bevel = shape.bevel ?? 0
        return {
            min: [
                Math.min(...shape.outline.map(([x]) => x)) - bevel,
                Math.min(...shape.outline.map(([, y]) => y)) - bevel,
                -bevel,
            ],
            max: [
                Math.max(...shape.outline.map(([x]) => x)) + bevel,
                Math.max(...shape.outline.map(([, y]) => y)) + bevel,
                shape.depth + bevel,
            ],
        }
    }
    if (shape.type === 'lathe') {
        const radius = Math.max(...shape.profile.map(([r]) => r))
        return {
            min: [-radius, Math.min(...shape.profile.map(([, y]) => y)), -radius],
            max: [radius, Math.max(...shape.profile.map(([, y]) => y)), radius],
        }
    }
    let half: Point
    switch (shape.type) {
        case 'box':
            half = [shape.dimensions.width / 2, shape.dimensions.height / 2, shape.dimensions.depth / 2]
            break
        case 'cylinder':
        case 'cone':
            half = [shape.dimensions.radius, shape.dimensions.height / 2, shape.dimensions.radius]
            break
        case 'sphere':
            half = [shape.dimensions.radius, shape.dimensions.radius, shape.dimensions.radius]
            break
        case 'torus':
            half = [
                shape.dimensions.radius + shape.dimensions.tube,
                shape.dimensions.radius + shape.dimensions.tube,
                shape.dimensions.tube,
            ]
            break
        case 'capsule':
            half = [
                shape.dimensions.radius,
                shape.dimensions.length / 2 + shape.dimensions.radius,
                shape.dimensions.radius,
            ]
            break
    }
    return { min: [-half[0], -half[1], -half[2]], max: half }
}

/** Primitive bounds only: never a union across a chair frame, ring or separated supports. End motion is identity. */
export function stepMotionShapeWorldBounds(shape: Shape): StepMotionBounds {
    const local = stepMotionShapeLocalBounds(shape),
        matrix = stepMotionShapeRotation(shape.rotation)
    const bounds: StepMotionBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    for (const x of [local.min[0], local.max[0]])
        for (const y of [local.min[1], local.max[1]])
            for (const z of [local.min[2], local.max[2]]) {
                matrix.forEach((row, axis) => {
                    const value = row[0] * x + row[1] * y + row[2] * z + shape.position[axis]!
                    bounds.min[axis] = Math.min(bounds.min[axis]!, value)
                    bounds.max[axis] = Math.max(bounds.max[axis]!, value)
                })
            }
    return bounds
}

/** Rotation-independent bounding volume of one primitive. */
export function stepMotionShapeVolume(shape: Shape): number {
    const { min, max } = stepMotionShapeLocalBounds(shape)
    return (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2])
}

const extents = (bounds: StepMotionBounds): Point => bounds.max.map((value, axis) => value - bounds.min[axis]!) as Point

function gap(a: StepMotionBounds, b: StepMotionBounds): number {
    return Math.hypot(...a.min.map((value, axis) => Math.max(0, value - b.max[axis]!, b.min[axis]! - a.max[axis]!)))
}

/**
 * The still context is negligible next to the moving parts: specks or stubs instead of the body the parts attach to.
 * Both the summed volume and the largest single extent must be tiny, so a small receiving bracket still passes.
 */
const ANCHOR_VOLUME_RATIO = 0.05
const ANCHOR_EXTENT_RATIO = 0.1
/** A moving part that finishes farther than this share of the scene diagonal from every other part is floating. */
const DETACHED_RATIO = 0.05
/** Thickness below this share of both other spans makes a plate. */
const PLATE_RATIO = 0.15
/** A plate standing on edge that reaches this share of the scene height is suspected of being laid wrongly. */
const TALL_RATIO = 0.6
/** Plates this share of the largest still volume are checked for standing on edge. */
const PLATE_VOLUME_SHARE = 0.25
/** A placed (not screwed) moving part whose every shape is below this share of the scene diagonal is a speck. */
const SPECK_RATIO = 0.03

/**
 * Hard issues: the scene cannot show the step (no body to attach to, or a part that ends floating in mid-air). Their
 * codes start with `quality_`. Soft issues (`suspect_`) flag a likely wrong orientation that a repair should confirm or
 * correct from the drawing; a repaired scene that keeps a soft issue is accepted.
 */
export function stepMotionQualityIssues(scene: StepMotionScene): string[] {
    const issues: string[] = []
    const still = scene.still.map((shape) => ({ shape, bounds: stepMotionShapeWorldBounds(shape) }))
    const movers = scene.movers.map((mover) =>
        mover.shapes.map((shape) => ({ shape, bounds: stepMotionShapeWorldBounds(shape) })),
    )
    const all = [...still, ...movers.flat()]
    const sceneBounds = {
        min: [0, 1, 2].map((axis) => Math.min(...all.map((item) => item.bounds.min[axis]!))) as Point,
        max: [0, 1, 2].map((axis) => Math.max(...all.map((item) => item.bounds.max[axis]!))) as Point,
    }
    const diagonal = Math.hypot(...extents(sceneBounds))
    const stillVolume = still.reduce((sum, item) => sum + stepMotionShapeVolume(item.shape), 0)
    const moverVolume = movers.flat().reduce((sum, item) => sum + stepMotionShapeVolume(item.shape), 0)
    const largest = (items: typeof still): number =>
        Math.max(0, ...items.map((item) => Math.max(...extents(item.bounds))))
    if (
        stillVolume < moverVolume * ANCHOR_VOLUME_RATIO &&
        largest(still) < largest(movers.flat()) * ANCHOR_EXTENT_RATIO
    )
        issues.push('quality_no_anchor')
    const reach = Math.max(PIECE_SPEC_LIMITS.minDimension, diagonal * DETACHED_RATIO)
    movers.forEach((group, index) => {
        const others = [...still, ...movers.filter((_, other) => other !== index).flat()]
        const touching = group.some((item) => others.some((other) => gap(item.bounds, other.bounds) <= reach))
        if (!touching) issues.push(`quality_detached:movers.${index}`)
    })
    movers.forEach((group, index) => {
        if (scene.movers[index]!.motion.kind === 'screw') return
        if (largest(group) < diagonal * SPECK_RATIO) issues.push(`quality_speck:movers.${index}`)
    })
    const sceneHeight = sceneBounds.max[1] - sceneBounds.min[1]
    const biggest = Math.max(0, ...still.map((item) => stepMotionShapeVolume(item.shape)))
    const onEdge = still.findIndex((item) => {
        if (stepMotionShapeVolume(item.shape) < biggest * PLATE_VOLUME_SHARE) return false
        const [x, y, z] = extents(item.bounds)
        const thin = Math.min(x, z),
            wide = Math.max(x, z)
        return thin <= PLATE_RATIO * y && thin <= PLATE_RATIO * wide && y >= TALL_RATIO * sceneHeight
    })
    if (onEdge >= 0) issues.push(`suspect_on_edge:still.${onEdge}`)
    return issues
}

/** Issues that make a scene unusable; soft suspicions are excluded. */
export function stepMotionHardQualityIssues(scene: StepMotionScene): string[] {
    return stepMotionQualityIssues(scene).filter((issue) => issue.startsWith('quality_'))
}
