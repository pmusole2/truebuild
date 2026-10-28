import { describe, expect, it } from 'vitest'

import { metaLayoutOutputSchemas, metaOutputSchemas, providerCheckSchema, providerQuestionSchema } from './meta-schemas'

// Synthetic provider-shaped values for schema unit tests; they are not recorded or live model output.
const check = {
    decision: 'cannot_verify',
    orientationAssessment: 'uncertain',
    reason: 'Synthetic result',
    sourceRefs: [],
    observedRegion: null,
    missingEvidence: ['Synthetic evidence gap'],
    partsAssessment: 'unobservable',
    connectionAssessment: 'unobservable',
    checks: [],
}
const question = { answer: 'Synthetic answer', sourceRefs: [], missingEvidence: [], observedRegion: null }
const layout = { components: [{ type: 'part_grid', partIds: ['side-panel'] }] }

describe.each([
    ['check', providerCheckSchema, check],
    ['question', providerQuestionSchema, question],
])('provider %s schema layout field', (name, schema, value): void => {
    it('keeps a valid layout and treats absent or null as no proposal', (): void => {
        expect(schema.parse({ ...value, layout })).toMatchObject({ layout })
        expect(schema.parse(value)).not.toHaveProperty('layout', expect.anything())
        expect(schema.parse({ ...value, layout: null })).not.toHaveProperty('layout', expect.anything())
    })

    it.each([
        ['unknown component', { components: [{ type: 'banner', partIds: ['a'] }] }],
        ['extra key', { components: layout.components, css: 'x' }],
        ['oversized list', { components: Array.from({ length: 9 }, () => layout.components[0]) }],
        ['free text', 'show a red warning'],
    ])('drops only the layout field for %s', (_label, bad): void => {
        const parsed = schema.safeParse({ ...value, layout: bad })
        expect(parsed.success).toBe(true)
        expect(parsed.data).not.toHaveProperty('layout', expect.anything())
        expect(parsed.data).toMatchObject(
            name === 'check' ? { reason: 'Synthetic result' } : { answer: 'Synthetic answer' },
        )
    })

    it('still rejects unknown or invalid fields elsewhere', (): void => {
        expect(schema.safeParse({ ...value, layout, extra: true }).success).toBe(false)
        expect(schema.safeParse({ ...value, layout, observedRegion: 'x' }).success).toBe(false)
        expect(schema.safeParse({ ...value, layout, source: 'model' }).success).toBe(false)
        expect(name === 'check' ? schema.safeParse({ ...value, layout, decision: 'maybe' }).success : false).toBe(false)
    })
})

describe('provider JSON schema for the layout field', (): void => {
    it('keeps the existing provider wire schemas free of layout during the provider freeze', (): void => {
        for (const output of [metaOutputSchemas.check, metaOutputSchemas.question]) {
            expect(output.properties).not.toHaveProperty('layout')
            expect(output.required).not.toContain('layout')
        }
    })

    it('is a nullable closed object with only enum, id and index leaves in the strict subset', (): void => {
        for (const output of [metaLayoutOutputSchemas.check, metaLayoutOutputSchemas.question]) {
            const properties = output.properties as Record<string, unknown>
            const text = JSON.stringify(properties.layout)
            expect(output.required).toContain('layout')
            expect(text).toContain('"type":"null"')
            expect(text).not.toMatch(/oneOf|allOf|\$ref|discriminator/u)
            expect(text).not.toMatch(/url|style|html|markup|text"/iu)
            expect(text).toContain('"additionalProperties":false')
            for (const type of [
                'part_grid',
                'orientation',
                'connection',
                'visible_checks',
                'source_diagram',
                'recovery',
            ]) {
                expect(text).toContain(`"const":"${type}"`)
            }
            expect(text).not.toContain('manufacturer_warning')
        }
    })
})
