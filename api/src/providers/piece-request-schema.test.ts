import { expect, it } from 'vitest'
import { manualPieceInputSchema, PIECE_SPEC_LIMITS, pieceSpecSchema } from '@truebuild/contracts'
import { metaOutputSchemas } from './meta-schemas'
import { PIECE_GEOMETRY_INSTRUCTIONS } from './piece-prompt'

it('folds only surface detail into primitives so flat silhouettes stay extrudes and integral members stay distinct', () => {
    expect(PIECE_GEOMETRY_INSTRUCTIONS).toContain(
        'Fold small surface lobes, bumps and grip details into the parent primitive rather than adding projecting parts; this applies only to surface detail, so a real flat blade or fin silhouette still uses extrude.',
    )
    expect(PIECE_GEOMETRY_INSTRUCTIONS).toContain(
        'Preserve integral shafts, stems, pegs and other connected functional structural members',
    )
})

it('accepts optional bounded inventory exclusions as data while rejecting malformed or oversized lists', () => {
    const part = { id: 'panel', name: 'Panel', quantity: 1, label: null, dimensions: null, pageId: null }
    expect(manualPieceInputSchema.safeParse(part).success).toBe(true)
    expect(manualPieceInputSchema.parse({ ...part, notPartOfThisPiece: [' Fastener '] })).toHaveProperty(
        'notPartOfThisPiece',
        ['Fastener'],
    )
    for (const notPartOfThisPiece of [
        [''],
        ['a'.repeat(81)],
        Array.from({ length: PIECE_SPEC_LIMITS.pieces + 1 }, () => 'Other piece'),
        'Other piece',
    ])
        expect(manualPieceInputSchema.safeParse({ ...part, notPartOfThisPiece }).success).toBe(false)
})

it('requests bounded extrudes and the six primitives without descriptions while retaining legacy lathe support', () => {
    const types = ['box', 'cylinder', 'cone', 'sphere', 'torus', 'capsule', 'extrude']
    expect(metaOutputSchemas.pieces).toHaveProperty('required', ['pieces'])
    expect(metaOutputSchemas.pieces).not.toHaveProperty('properties.descriptions')
    expect(metaOutputSchemas.pieces).toHaveProperty('properties.pieces.items.properties.parts.items.anyOf.length', 7)
    expect(metaOutputSchemas.pieces).toMatchObject({
        properties: {
            pieces: {
                items: {
                    properties: {
                        parts: {
                            items: {
                                anyOf: types.map((type) => ({ properties: { type: { const: type } } })),
                            },
                        },
                    },
                },
            },
        },
    })
    expect(metaOutputSchemas.pieces).toHaveProperty(
        'properties.pieces.items.properties.parts.items.anyOf.6.properties',
        expect.objectContaining({
            outline: expect.objectContaining({ type: 'array', minItems: 3, maxItems: PIECE_SPEC_LIMITS.outlinePoints }),
            depth: { type: 'number', minimum: PIECE_SPEC_LIMITS.minDimension, maximum: PIECE_SPEC_LIMITS.extent },
        }),
    )
    const placement = { position: [0, 0, 0], rotation: [0, 0, 0] }
    for (const part of [
        {
            type: 'lathe',
            profile: [
                [0, -1],
                [1, -1],
                [1, 1],
                [0, 1],
            ],
            segments: 16,
            ...placement,
        },
        {
            type: 'extrude',
            outline: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
            ],
            depth: 0.2,
            ...placement,
        },
    ])
        expect(
            pieceSpecSchema.safeParse({
                id: 'outline-control',
                name: 'Outline control',
                color: '#778899',
                parts: [part],
            }).success,
        ).toBe(true)
})
