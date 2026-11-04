import { z } from 'zod'

/**
 * Bounds of a piece description. They bound what a viewer builds and what a request carries, not what a piece is like.
 * Dimensions and offsets are in the piece's own units; angles are radians.
 */
export const PIECE_SPEC_LIMITS = {
    /** Closed primitives of one piece. */
    parts: 40,
    /** Pieces of one registry (ids unique). */
    pieces: 30,
    name: 80,
    /**
     * Smallest dimension of a primitive. Below it a value can underflow single-precision floats, which breaks the viewer's
     * auto-framing and its minimum radius.
     */
    minDimension: 0.001,
    /** Largest dimension of a primitive and largest magnitude of any position component. */
    extent: 1000,
    /** Largest magnitude of any rotation component (one full turn is 2π). */
    angle: 2 * Math.PI,
    /** Points of a lathe profile: a polyline in (radius, height), at least three, capped onto the axis by the viewer. */
    lathePoints: 48,
    /** Segments around a lathe axis. */
    latheSegments: { min: 8, max: 64 },
    /** Points of an extrude outline: a simple closed polygon, at least three. */
    outlinePoints: 64,
    /**
     * Largest bevel as a fraction of the smallest extrude extent (depth or either outline span), so it stays small even
     * for a narrow outline with a large depth.
     */
    bevelRatio: 0.25,
} as const

/**
 * A piece is a closed list of parts. Each part is positioned and rotated on its own; there are no holes and no boolean
 * operations (solid cuts are not part of this contract), so a viewer only ever draws these exact shapes.
 * A lathe revolves its (radius, height) profile around its local Y axis; the profile is a polyline that the viewer caps
 * onto the axis at any endpoint off it. An extrude stretches its simple (x, y) outline along its local Z axis from 0 to
 * `depth` (not centred on the origin). Redundant straight points are allowed; folds, overlaps and touching edges are not.
 */
const dimension = z.number().min(PIECE_SPEC_LIMITS.minDimension).max(PIECE_SPEC_LIMITS.extent)
const offset = z.number().min(-PIECE_SPEC_LIMITS.extent).max(PIECE_SPEC_LIMITS.extent)
const angle = z.number().min(-PIECE_SPEC_LIMITS.angle).max(PIECE_SPEC_LIMITS.angle)
const vector = z.tuple([offset, offset, offset])
const radians = z.tuple([angle, angle, angle])
const radius = z.number().min(0).max(PIECE_SPEC_LIMITS.extent)
const profilePoint = z.tuple([radius, offset])
const outlinePoint = z.tuple([offset, offset])

function primitive<T extends string, D extends z.ZodRawShape>(
    type: T,
    dimensions: D,
): z.ZodObject<
    {
        type: z.ZodLiteral<T>
        dimensions: z.ZodObject<D, z.core.$strict>
        position: typeof vector
        rotation: typeof radians
    },
    z.core.$strict
> {
    return z.strictObject({
        type: z.literal(type),
        dimensions: z.strictObject(dimensions),
        position: vector,
        rotation: radians,
    })
}

type Point = readonly [number, number]

/** Twice the signed area of the triangle origin, a, b: positive when b lies left of the ray from origin through a. */
function cross(origin: Point, a: Point, b: Point): number {
    return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
}

function gap(a: Point, b: Point): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/** Distance from `point` to the segment `a`–`b`; the segment must not be degenerate. */
function distanceToSegment(point: Point, [ax, ay]: Point, [bx, by]: Point): number {
    const along = ((point[0] - ax) * (bx - ax) + (point[1] - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)
    const t = Math.min(1, Math.max(0, along))
    return Math.hypot(ax + t * (bx - ax) - point[0], ay + t * (by - ay) - point[1])
}

/** Two edges touch when they cross, or when an endpoint of either lies within the tolerance of the other. */
function edgesTouch(a: Point, b: Point, c: Point, d: Point, tolerance: number): boolean {
    const crosses = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0
    return (
        crosses ||
        [
            distanceToSegment(a, c, d),
            distanceToSegment(b, c, d),
            distanceToSegment(c, a, b),
            distanceToSegment(d, a, b),
        ].some((distance) => distance <= tolerance)
    )
}

/**
 * A closed polygon is simple when its points are distinct, it never folds back along an edge, no two nonadjacent edges
 * touch, and it encloses area. Straight vertices are allowed: a redundant collinear point does not change the shape.
 * Distances use the smallest dimension as tolerance: anything finer could not be drawn meaningfully.
 */
function isSimplePolygon(points: readonly Point[]): boolean {
    const count = points.length
    if (count < 3) return false
    const tolerance = PIECE_SPEC_LIMITS.minDimension
    const at = (index: number): Point => points[((index % count) + count) % count]!
    for (let i = 0; i < count; i += 1)
        for (let j = i + 1; j < count; j += 1) if (gap(at(i), at(j)) <= tolerance) return false
    for (let i = 0; i < count; i += 1) {
        const previous = at(i - 1)
        const current = at(i)
        const next = at(i + 1)
        const reverses =
            (current[0] - previous[0]) * (next[0] - current[0]) + (current[1] - previous[1]) * (next[1] - current[1]) <
            0
        if (reverses && Math.abs(cross(previous, current, next)) <= tolerance * gap(previous, current)) return false
    }
    for (let i = 0; i < count; i += 1)
        for (let j = i + 2; j < count; j += 1) {
            const adjacent = i === 0 && j === count - 1
            if (!adjacent && edgesTouch(at(i), at(i + 1), at(j), at(j + 1), tolerance)) return false
        }
    let twiceArea = 0
    for (let i = 0; i < count; i += 1) twiceArea += at(i)[0] * at(i + 1)[1] - at(i + 1)[0] * at(i)[1]
    return Math.abs(twiceArea) / 2 > tolerance * tolerance
}

/**
 * The closed outline of a lathe profile: the renderer caps an endpoint off the axis onto it, so that cap joins the
 * outline. An endpoint already on the axis needs no cap.
 */
function latheOutline(profile: readonly Point[]): Point[] {
    const first = profile[0]!
    const last = profile[profile.length - 1]!
    const onAxis = (point: Point): Point => [0, point[1]]
    return [...(first[0] > 0 ? [onAxis(first)] : []), ...profile, ...(last[0] > 0 ? [onAxis(last)] : [])]
}

const lathePartSchema = z
    .strictObject({
        type: z.literal('lathe'),
        profile: z.array(profilePoint).min(3).max(PIECE_SPEC_LIMITS.lathePoints),
        segments: z.number().int().min(PIECE_SPEC_LIMITS.latheSegments.min).max(PIECE_SPEC_LIMITS.latheSegments.max),
        position: vector,
        rotation: radians,
    })
    .refine(
        (part) =>
            part.profile.length >= 3 &&
            part.profile.length <= PIECE_SPEC_LIMITS.lathePoints &&
            isSimplePolygon(latheOutline(part.profile)),
        {
            message: 'A lathe profile is a simple path with area once capped on the axis',
        },
    )

/** Largest bevel of an extrude: a fraction of its smallest extent, which is its depth or either outline span. */
export function extrudeBevelLimit(depth: number, outline: readonly Point[]): number {
    const xs = outline.map(([x]) => x)
    const ys = outline.map(([, y]) => y)
    const smallest = Math.min(depth, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    return smallest * PIECE_SPEC_LIMITS.bevelRatio
}

const extrudePartSchema = z
    .strictObject({
        type: z.literal('extrude'),
        outline: z.array(outlinePoint).min(3).max(PIECE_SPEC_LIMITS.outlinePoints),
        depth: dimension,
        // Providers send an omitted optional value as null; both mean no bevel.
        bevel: z
            .number()
            .min(0)
            .max(PIECE_SPEC_LIMITS.extent * PIECE_SPEC_LIMITS.bevelRatio)
            .nullish()
            .transform((value) => value ?? undefined),
        position: vector,
        rotation: radians,
    })
    .refine(
        (part) =>
            part.outline.length >= 3 &&
            part.outline.length <= PIECE_SPEC_LIMITS.outlinePoints &&
            isSimplePolygon(part.outline),
        { message: 'An extrude outline is a simple polygon with area' },
    )
    .refine(
        (part) => {
            if (part.bevel === undefined) return true
            if (part.outline.length < 3 || part.outline.length > PIECE_SPEC_LIMITS.outlinePoints) return false
            return part.bevel <= extrudeBevelLimit(part.depth, part.outline)
        },
        {
            message: 'A bevel is at most a fraction of the smallest extrude extent',
        },
    )

const piecePartSchema = z.discriminatedUnion('type', [
    primitive('box', { width: dimension, height: dimension, depth: dimension }),
    primitive('cylinder', { radius: dimension, height: dimension }),
    primitive('cone', { radius: dimension, height: dimension }),
    primitive('sphere', { radius: dimension }),
    primitive('torus', { radius: dimension, tube: dimension }).refine(
        (part) => part.dimensions.tube < part.dimensions.radius,
        { message: 'A torus tube is thinner than its radius' },
    ),
    primitive('capsule', { radius: dimension, length: dimension }),
    lathePartSchema,
    extrudePartSchema,
])

export const pieceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
export const pieceSpecSchema = z.strictObject({
    id: pieceIdSchema,
    name: z.string().trim().min(1).max(PIECE_SPEC_LIMITS.name),
    color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u),
    parts: z.array(piecePartSchema).min(1).max(PIECE_SPEC_LIMITS.parts),
})
export type PieceSpec = z.infer<typeof pieceSpecSchema>

/** A registry of pieces: at most `PIECE_SPEC_LIMITS.pieces`, each id once. */
export const piecesSpecSchema = z
    .array(pieceSpecSchema)
    .max(PIECE_SPEC_LIMITS.pieces)
    .refine((pieces) => new Set(pieces.map((piece) => piece.id)).size === pieces.length, {
        message: 'Piece ids are unique',
    })
