import { PIECE_SPEC_LIMITS, type StepMotionScene } from '@truebuild/contracts'

type Shape = StepMotionScene['still'][number]
type Point = [number, number, number]
type Bounds = { min: Point; max: Point }
type Matrix = [Point, Point, Point]

/** Three's default Euler XYZ uses R = Rx * Ry * Rz, then Mesh.position adds the world translation. */
function rotation([x, y, z]: Point): Matrix {
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

function localBounds(shape: Shape): Bounds {
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
export function shapeWorldBounds(shape: Shape): Bounds {
    const local = localBounds(shape),
        matrix = rotation(shape.rotation)
    const bounds: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
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

/** Strict interior of a simple polygon, excluding a margin around every boundary edge. */
function insidePolygon(x: number, y: number, outline: readonly (readonly [number, number])[], margin: number): boolean {
    let inside = false
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const [ax, ay] = outline[j]!,
            [bx, by] = outline[i]!
        const along = Math.max(
            0,
            Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
        )
        if (Math.hypot(x - ax - along * (bx - ax), y - ay - along * (by - ay)) <= margin) return false
        if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
    }
    return inside
}

function contains(shape: Shape, matrix: Matrix, point: Point, margin: number): boolean {
    const delta = point.map((value, axis) => value - shape.position[axis]!)
    // Inverse of the pure rotation is its transpose.
    const [x, y, z] = [0, 1, 2].map((axis) => matrix.reduce((sum, row, i) => sum + row[axis]! * delta[i]!, 0)) as Point
    switch (shape.type) {
        case 'box':
            return (
                Math.abs(x) < shape.dimensions.width / 2 - margin &&
                Math.abs(y) < shape.dimensions.height / 2 - margin &&
                Math.abs(z) < shape.dimensions.depth / 2 - margin
            )
        case 'sphere':
            return Math.hypot(x, y, z) < shape.dimensions.radius - margin
        case 'cylinder':
            return (
                Math.abs(y) < shape.dimensions.height / 2 - margin &&
                Math.hypot(x, z) < shape.dimensions.radius - margin
            )
        case 'cone':
            return (
                Math.abs(y) < shape.dimensions.height / 2 - margin &&
                Math.hypot(x, z) < shape.dimensions.radius * (0.5 - y / shape.dimensions.height) - margin
            )
        case 'capsule':
            return (
                Math.hypot(x, Math.max(0, Math.abs(y) - shape.dimensions.length / 2), z) <
                shape.dimensions.radius - margin
            )
        case 'torus':
            return Math.hypot(Math.hypot(x, y) - shape.dimensions.radius, z) < shape.dimensions.tube - margin
        case 'extrude':
            return z > margin && z < shape.depth - margin && insidePolygon(x, y, shape.outline, margin)
        case 'lathe': {
            const first = shape.profile[0]!,
                last = shape.profile.at(-1)!
            return insidePolygon(
                Math.hypot(x, z),
                y,
                [[0, first[1]], ...shape.profile, [0, last[1]]].filter(
                    (point, index, all) =>
                        index === 0 || point[0] !== all[index - 1]![0] || point[1] !== all[index - 1]![1],
                ) as [number, number][],
                margin,
            )
        }
    }
}

/**
 * Conservative cheap rejection, not mesh collision proof: deep AABB penetration must also contain a common strict
 * solid-interior sample. The bounded 27 samples avoid rejecting empty torus holes and concave-outline gaps. Contact,
 * bevel-only intersection, moving/moving and static/static pairs are intentionally outside this rejection.
 */
export function stepMotionOverlapIssues(scene: StepMotionScene): string[] {
    const still = scene.still.map((shape) => ({
        shape,
        bounds: shapeWorldBounds(shape),
        matrix: rotation(shape.rotation),
    }))
    const issues: string[] = []
    scene.movers.forEach((mover, moverIndex) =>
        mover.shapes.forEach((shape, shapeIndex) => {
            const bounds = shapeWorldBounds(shape),
                matrix = rotation(shape.rotation)
            for (const [stillIndex, fixed] of still.entries()) {
                const min = bounds.min.map((value, axis) => Math.max(value, fixed.bounds.min[axis]!)) as Point
                const max = bounds.max.map((value, axis) => Math.min(value, fixed.bounds.max[axis]!)) as Point
                const smallSpans = bounds.min.map((value, axis) =>
                    Math.min(bounds.max[axis]! - value, fixed.bounds.max[axis]! - fixed.bounds.min[axis]!),
                )
                if (
                    min.some(
                        (value, axis) =>
                            max[axis]! - value <= Math.max(PIECE_SPEC_LIMITS.minDimension, smallSpans[axis]! * 0.1),
                    )
                )
                    continue
                const margin = Math.max(PIECE_SPEC_LIMITS.minDimension, Math.min(...smallSpans) * 0.025)
                let overlap = false
                for (const tx of [0.25, 0.5, 0.75])
                    for (const ty of [0.25, 0.5, 0.75])
                        for (const tz of [0.25, 0.5, 0.75]) {
                            const point = [tx, ty, tz].map(
                                (t, axis) => min[axis]! + t * (max[axis]! - min[axis]!),
                            ) as Point
                            if (
                                contains(shape, matrix, point, margin) &&
                                contains(fixed.shape, fixed.matrix, point, margin)
                            )
                                overlap = true
                        }
                if (overlap) {
                    issues.push(`movers.${moverIndex}.shapes.${shapeIndex}:deep_static_overlap:still.${stillIndex}`)
                    break
                }
            }
        }),
    )
    return issues
}
