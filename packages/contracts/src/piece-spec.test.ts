import { expect, it } from 'vitest'
import type { z } from 'zod'

import { PIECE_SPEC_LIMITS, pieceSpecSchema, piecesSpecSchema } from './piece-spec'

const box = {
    type: 'box',
    dimensions: { width: 1, height: 1, depth: 1 },
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
    ],
}
const piece = (id: string): typeof valid => ({ ...valid, id })
const many = (count: number): (typeof valid)[] => Array.from({ length: count }, (_, index) => piece(`p-${index}`))

const cases: [string, z.ZodType, unknown][] = [
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
    ['registry with a repeated id', piecesSpecSchema, [piece('same'), piece('same')]],
    ['registry over the piece bound', piecesSpecSchema, many(PIECE_SPEC_LIMITS.pieces + 1)],
]

it('accepts a bounded piece and rejects every malformed or out-of-bound case (labelled, one test)', () => {
    // The positive control keeps the loop honest: a schema that rejects everything would pass every row below.
    expect(pieceSpecSchema.safeParse(valid).success, 'valid control piece').toBe(true)
    for (const [label, schema, input] of cases) {
        expect(schema.safeParse(input).success, label).toBe(false)
    }
})
