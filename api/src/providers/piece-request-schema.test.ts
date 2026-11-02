import { expect, it } from 'vitest'
import { pieceSpecSchema } from '@truebuild/contracts'
import { metaOutputSchemas } from './meta-schemas'

it('requests only the six primitives without descriptions while the shared contract still accepts outline geometry', () => {
    const types = ['box', 'cylinder', 'cone', 'sphere', 'torus', 'capsule']
    expect(metaOutputSchemas.pieces).toHaveProperty('required', ['pieces'])
    expect(metaOutputSchemas.pieces).not.toHaveProperty('properties.descriptions')
    expect(metaOutputSchemas.pieces).toHaveProperty('properties.pieces.items.properties.parts.items.anyOf.length', 6)
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
