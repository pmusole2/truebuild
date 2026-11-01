import { expect, it } from 'vitest'
import type { z } from 'zod'

import { PIECE_SPEC_LIMITS, pieceSpecSchema, piecesSpecSchema } from './piece-spec'

const box = {
    type: 'box',
    dimensions: { width: 1, height: 1, depth: 1 },
    position: [0, 0, 0],
    rotation: [0, 0, 0],
}
const lathe = {
    type: 'lathe',
    profile: [
        [0, -5],
        [3, -5],
        [3, 5],
        [0, 5],
    ],
    segments: 24,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
}
const extrude = {
    type: 'extrude',
    outline: [
        [-2, -1],
        [2, -1],
        [2, 1],
        [-2, 1],
    ],
    depth: 1,
    bevel: 0.1,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
}
const valid = {
    id: 'bracket-1',
    name: 'Bracket',
    color: '#a1b2c3',
    parts: [
        box,
        {
            type: 'torus',
            dimensions: { radius: 2, tube: 0.5 },
            position: [1, 0, 0],
            rotation: [0, 0, Math.PI / 2],
        },
        lathe,
        extrude,
    ],
}
const piece = (id: string): typeof valid => ({ ...valid, id })
const many = (count: number): (typeof valid)[] => Array.from({ length: count }, (_, index) => piece(`p-${index}`))
const withPart = (part: object): object => ({ ...valid, parts: [part] })

const cases: [string, z.ZodType, unknown][] = [
    [
        'empty lathe profile returns validation issues without throwing',
        pieceSpecSchema,
        withPart({ ...lathe, profile: [] }),
    ],
    [
        'empty extrude outline returns validation issues without throwing',
        pieceSpecSchema,
        withPart({ ...extrude, outline: [] }),
    ],
    ['id with uppercase and spaces', pieceSpecSchema, { ...valid, id: 'Bad Id' }],
    ['empty id', pieceSpecSchema, { ...valid, id: '' }],
    ['id longer than 64 characters', pieceSpecSchema, { ...valid, id: 'a'.repeat(65) }],
    ['empty name', pieceSpecSchema, { ...valid, name: '' }],
    ['name longer than 80 characters', pieceSpecSchema, { ...valid, name: 'n'.repeat(81) }],
    ['color that is not hex', pieceSpecSchema, { ...valid, color: 'red' }],
    ['eight-digit hex colour', pieceSpecSchema, { ...valid, color: '#a1b2c3ff' }],
    ['no parts', pieceSpecSchema, { ...valid, parts: [] }],
    [
        'more primitives than the closed bound',
        pieceSpecSchema,
        { ...valid, parts: Array.from({ length: PIECE_SPEC_LIMITS.parts + 1 }, () => box) },
    ],
    ['unknown primitive (a hole is not a primitive)', pieceSpecSchema, { ...valid, parts: [{ ...box, type: 'hole' }] }],
    ['boolean operation on a primitive', pieceSpecSchema, { ...valid, parts: [{ ...box, operation: 'subtract' }] }],
    ['extra key on the piece', pieceSpecSchema, { ...valid, holes: [] }],
    [
        'torus tube not thinner than its radius',
        pieceSpecSchema,
        { ...valid, parts: [{ ...box, type: 'torus', dimensions: { radius: 1, tube: 1 } }] },
    ],
    [
        'zero dimension',
        pieceSpecSchema,
        { ...valid, parts: [{ ...box, dimensions: { width: 0, height: 1, depth: 1 } }] },
    ],
    [
        'dimension below the minimum bound (underflows single precision)',
        pieceSpecSchema,
        { ...valid, parts: [{ ...box, dimensions: { width: 1e-300, height: 1, depth: 1 } }] },
    ],
    ['negative radius', pieceSpecSchema, { ...valid, parts: [{ ...box, type: 'sphere', dimensions: { radius: -1 } }] }],
    [
        'dimension beyond the extent bound',
        pieceSpecSchema,
        { ...valid, parts: [{ ...box, dimensions: { width: PIECE_SPEC_LIMITS.extent + 1, height: 1, depth: 1 } }] },
    ],
    [
        'non-finite dimension',
        pieceSpecSchema,
        { ...valid, parts: [{ ...box, dimensions: { width: Infinity, height: 1, depth: 1 } }] },
    ],
    ['NaN position component', pieceSpecSchema, { ...valid, parts: [{ ...box, position: [Number.NaN, 0, 0] }] }],
    [
        'position beyond the extent bound',
        pieceSpecSchema,
        { ...valid, parts: [{ ...box, position: [PIECE_SPEC_LIMITS.extent + 1, 0, 0] }] },
    ],
    ['position that is not a 3-tuple', pieceSpecSchema, { ...valid, parts: [{ ...box, position: [0, 0] }] }],
    [
        'rotation beyond one full turn',
        pieceSpecSchema,
        { ...valid, parts: [{ ...box, rotation: [0, 0, 2 * Math.PI + 0.01] }] },
    ],
    [
        'lathe with two profile points',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [0, -5],
                [3, 5],
            ],
        }),
    ],
    [
        'lathe over the profile point bound',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: Array.from({ length: PIECE_SPEC_LIMITS.lathePoints + 1 }, (_, index) => [1 + (index % 2), index]),
        }),
    ],
    [
        'lathe with a negative radius',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [-1, -5],
                [3, -5],
                [3, 5],
            ],
        }),
    ],
    [
        'lathe radius beyond the extent bound',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [0, -5],
                [PIECE_SPEC_LIMITS.extent + 1, -5],
                [3, 5],
            ],
        }),
    ],
    [
        'lathe height beyond the extent bound',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [0, -5],
                [3, -5],
                [3, PIECE_SPEC_LIMITS.extent + 1],
            ],
        }),
    ],
    ['lathe with fewer segments than the minimum', pieceSpecSchema, withPart({ ...lathe, segments: 7 })],
    ['lathe with more segments than the maximum', pieceSpecSchema, withPart({ ...lathe, segments: 65 })],
    ['lathe with a fractional segment count', pieceSpecSchema, withPart({ ...lathe, segments: 8.5 })],
    [
        'lathe profile that crosses itself',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [0, 0],
                [4, 4],
                [4, 0],
                [0, 4],
            ],
        }),
    ],
    [
        'lathe profile with a repeated point',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [1, 0],
                [3, 0],
                [3, 2],
                [1, 0],
            ],
        }),
    ],
    [
        'lathe profile with only collinear points on the axis (zero area)',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [0, 0],
                [0, 1],
                [0, 2],
                [0, 3],
            ],
        }),
    ],
    [
        'extrude with two outline points',
        pieceSpecSchema,
        withPart({
            ...extrude,
            outline: [
                [0, 0],
                [1, 0],
            ],
        }),
    ],
    [
        'extrude outline over the point bound',
        pieceSpecSchema,
        withPart({
            ...extrude,
            outline: Array.from({ length: PIECE_SPEC_LIMITS.outlinePoints + 1 }, (_, index) => [index, index % 2]),
        }),
    ],
    [
        'extrude outline touching a nonadjacent edge',
        pieceSpecSchema,
        withPart({
            ...extrude,
            outline: [
                [0, 0],
                [4, 0],
                [4, 3],
                [2, 0],
                [0, 3],
            ],
        }),
    ],
    [
        'extrude outline that crosses itself',
        pieceSpecSchema,
        withPart({
            ...extrude,
            outline: [
                [0, 0],
                [4, 4],
                [4, 0],
                [0, 4],
            ],
        }),
    ],
    [
        'extrude outline with a repeated point',
        pieceSpecSchema,
        withPart({
            ...extrude,
            outline: [
                [0, 0],
                [2, 0],
                [2, 2],
                [0, 0],
            ],
        }),
    ],
    [
        'extrude outline that folds back over itself',
        pieceSpecSchema,
        withPart({
            ...extrude,
            outline: [
                [0, 0],
                [4, 0],
                [2, 0],
                [2, 3],
            ],
        }),
    ],
    [
        'lathe profile on the axis (zero radial extent)',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [0, 0],
                [0, 1],
                [0, 2],
            ],
        }),
    ],
    [
        'lathe profile with zero height extent',
        pieceSpecSchema,
        withPart({
            ...lathe,
            profile: [
                [1, 0],
                [2, 0],
                [3, 0],
            ],
        }),
    ],
    [
        'extrude outline with zero area',
        pieceSpecSchema,
        withPart({
            ...extrude,
            outline: [
                [0, 0],
                [1, 1],
                [2, 2],
            ],
        }),
    ],
    ['extrude with zero depth', pieceSpecSchema, withPart({ ...extrude, depth: 0 })],
    [
        'extrude bevel too large for a thin outline',
        pieceSpecSchema,
        withPart({
            ...extrude,
            outline: [
                [0, 0],
                [0.01, 0],
                [0.01, 1],
                [0, 1],
            ],
            depth: 1000,
            bevel: 1,
        }),
    ],
    [
        'extrude depth beyond the extent bound',
        pieceSpecSchema,
        withPart({ ...extrude, depth: PIECE_SPEC_LIMITS.extent + 1 }),
    ],
    ['extrude bevel above a quarter of its depth', pieceSpecSchema, withPart({ ...extrude, bevel: 0.26 })],
    ['extrude with a negative bevel', pieceSpecSchema, withPart({ ...extrude, bevel: -0.1 })],
    ['registry with a repeated id', piecesSpecSchema, [piece('same'), piece('same')]],
    ['registry over the piece bound', piecesSpecSchema, many(PIECE_SPEC_LIMITS.pieces + 1)],
]

// Accepted shapes, including redundant straight points and profiles that start or end on the axis.
// The provider wire sends an omitted bevel as null; that is the same as no bevel.
const validCases: [string, unknown][] = [
    ['valid control piece', valid],
    [
        'cylindrical lathe profile with a redundant straight point',
        withPart({
            ...lathe,
            profile: [
                [1, -1],
                [1, 0],
                [1, 1],
            ],
        }),
    ],
    [
        'lathe profile starting and ending on the axis',
        withPart({
            ...lathe,
            profile: [
                [0, -1],
                [1, -1],
                [1, 1],
                [0, 1],
            ],
        }),
    ],
    [
        'diagonal lathe profile capped onto the axis (a cone)',
        withPart({
            ...lathe,
            profile: [
                [1, 0],
                [2, 1],
                [3, 2],
            ],
        }),
    ],
    [
        'extrude outline with a redundant collinear vertex',
        withPart({
            ...extrude,
            outline: [
                [0, 0],
                [2, 0],
                [4, 0],
                [4, 3],
                [0, 3],
            ],
        }),
    ],
    ['extrude with a null bevel', withPart({ ...extrude, bevel: null })],
]

it('accepts bounded pieces with lathe and extrude parts and rejects every malformed or out-of-bound case (labelled, one test)', () => {
    // The positive controls keep the loop honest: a schema that rejects everything would pass every row below.
    for (const [label, input] of validCases) {
        expect(pieceSpecSchema.safeParse(input).success, label).toBe(true)
    }
    for (const [label, schema, input] of cases) {
        expect(schema.safeParse(input).success, label).toBe(false)
    }
})
