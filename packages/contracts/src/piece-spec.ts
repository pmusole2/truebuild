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
} as const

/**
 * A piece is a closed list of primitives. Each primitive is positioned and rotated on its own; there are no holes and no
 * boolean operations (solid cuts are not part of this contract), so a viewer only ever draws these exact shapes.
 */
const dimension = z.number().min(PIECE_SPEC_LIMITS.minDimension).max(PIECE_SPEC_LIMITS.extent)
const offset = z.number().min(-PIECE_SPEC_LIMITS.extent).max(PIECE_SPEC_LIMITS.extent)
const angle = z.number().min(-PIECE_SPEC_LIMITS.angle).max(PIECE_SPEC_LIMITS.angle)
const vector = z.tuple([offset, offset, offset])
const radians = z.tuple([angle, angle, angle])

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
])

export const pieceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
export const pieceSpecSchema = z.strictObject({
    id: pieceIdSchema,
    name: z.string().trim().min(1).max(PIECE_SPEC_LIMITS.name),
    color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u),
    parts: z.array(piecePartSchema).min(1).max(PIECE_SPEC_LIMITS.parts),
})
export type PieceSpec = z.infer<typeof pieceSpecSchema>
export type PiecePart = PieceSpec['parts'][number]

/** A registry of pieces: at most `PIECE_SPEC_LIMITS.pieces`, each id once. */
export const piecesSpecSchema = z
    .array(pieceSpecSchema)
    .max(PIECE_SPEC_LIMITS.pieces)
    .refine((pieces) => new Set(pieces.map((piece) => piece.id)).size === pieces.length, {
        message: 'Piece ids are unique',
    })
export type PiecesSpec = z.infer<typeof piecesSpecSchema>
