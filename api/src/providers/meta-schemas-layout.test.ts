import { describe, expect, it } from 'vitest'

import {
    metaLayoutOutputSchemas,
    metaOutputSchemas,
    PROPOSAL_BUDGET,
    PROPOSAL_MAX_BYTES,
    providerCheckSchema,
    providerQuestionSchema,
} from './meta-schemas'

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

// Synthetic grid values (0-1000, top-left origin) for the next-part and target regions; not recorded output.
const grid = { x1: 100, y1: 200, x2: 400, y2: 600 }
const normalized = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }

describe.each([
    ['check', providerCheckSchema, check],
    ['question', providerQuestionSchema, question],
])('provider %s schema next-part and target regions', (_name, schema, value): void => {
    it('converts valid grid boxes once to public normalized regions with the part identity', (): void => {
        const parsed = schema.parse({
            ...value,
            nextPartRegion: { partId: 'side-panel', region: grid },
            targetRegion: { partId: 'side-panel', region: { x1: 500, y1: 500, x2: 1000, y2: 1000 } },
        })
        expect(parsed).toMatchObject({
            nextPartRegion: { partId: 'side-panel', region: normalized },
            targetRegion: { partId: 'side-panel', region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
        })
    })

    it('treats absent and null as no region and never synthesizes one', (): void => {
        for (const extra of [{}, { nextPartRegion: null, targetRegion: null }]) {
            const parsed = schema.parse({ ...value, ...extra })
            expect(parsed).not.toHaveProperty('nextPartRegion', expect.anything())
            expect(parsed).not.toHaveProperty('targetRegion', expect.anything())
        }
    })

    it.each([
        ['inverted box', { partId: 'a', region: { x1: 600, y1: 10, x2: 100, y2: 400 } }],
        ['zero-area box', { partId: 'a', region: { x1: 100, y1: 100, x2: 100, y2: 400 } }],
        ['grossly out-of-range box', { partId: 'a', region: { x1: 0, y1: 0, x2: 5000, y2: 400 } }],
        ['missing part identity', { region: grid }],
        ['extra key', { partId: 'a', region: grid, label: 'x' }],
        ['free text', 'next to the panel'],
    ])('drops only the region field for %s and keeps the verdict', (_label, bad): void => {
        const parsed = schema.safeParse({ ...value, nextPartRegion: bad, targetRegion: bad })
        expect(parsed.success).toBe(true)
        expect(parsed.data).not.toHaveProperty('nextPartRegion', expect.anything())
        expect(parsed.data).not.toHaveProperty('targetRegion', expect.anything())
        expect(parsed.data).toMatchObject(
            _name === 'check' ? { reason: 'Synthetic result' } : { answer: 'Synthetic answer' },
        )
    })
})

describe.each([
    ['check', providerCheckSchema, check],
    ['question', providerQuestionSchema, question],
])('provider %s strict grid conversion for new regions', (_name, schema, value): void => {
    const corners = ['x1', 'y1', 'x2', 'y2'] as const
    const inside = { x1: 100, y1: 100, x2: 900, y2: 900 }

    it.each(corners.flatMap((corner) => [-1, 1001, -0.001, 1000.001].map((raw) => [corner, raw] as const)))(
        'drops a region whose %s is %s instead of clamping it',
        (corner, raw): void => {
            const bad = { partId: 'a', region: { ...inside, [corner]: raw } }
            const parsed = schema.safeParse({ ...value, nextPartRegion: bad, targetRegion: bad })
            expect(parsed.success).toBe(true)
            expect(parsed.data).not.toHaveProperty('nextPartRegion', expect.anything())
            expect(parsed.data).not.toHaveProperty('targetRegion', expect.anything())
        },
    )

    it('accepts the exact 0 and 1000 bounds and returns exactly raw/1000', (): void => {
        const parsed = schema.parse({
            ...value,
            nextPartRegion: { partId: 'a', region: { x1: 0, y1: 0, x2: 1000, y2: 1000 } },
        })
        expect(parsed).toMatchObject({ nextPartRegion: { region: { x: 0, y: 0, width: 1, height: 1 } } })
    })

    it('preserves legitimate fractional coordinates exactly, with no rounding or snapping', (): void => {
        const raw = { x1: 12.5, y1: 100.25, x2: 400.75, y2: 600.125 }
        const parsed = schema.parse({ ...value, targetRegion: { partId: 'a', region: raw } })
        expect(parsed.targetRegion?.region).toEqual({
            x: raw.x1 / 1000,
            y: raw.y1 / 1000,
            width: (raw.x2 - raw.x1) / 1000,
            height: (raw.y2 - raw.y1) / 1000,
        })
        expect(parsed.targetRegion?.region.x).toBeCloseTo(0.0125, 12)
        expect(parsed.targetRegion?.region.width).toBeCloseTo(0.38825, 12)
    })

    it('always yields a normalized region inside 0..1', (): void => {
        for (const raw of [inside, { x1: 0, y1: 999, x2: 1, y2: 1000 }, { x1: 999.5, y1: 0, x2: 1000, y2: 0.5 }]) {
            const region = schema.parse({ ...value, nextPartRegion: { partId: 'a', region: raw } }).nextPartRegion
                ?.region
            expect(region).toBeDefined()
            expect(region!.x).toBeGreaterThanOrEqual(0)
            expect(region!.y).toBeGreaterThanOrEqual(0)
            expect(region!.x + region!.width).toBeLessThanOrEqual(1)
            expect(region!.y + region!.height).toBeLessThanOrEqual(1)
        }
    })
})

describe('provider observedRegion keeps its tolerant conversion (flag-off semantics)', (): void => {
    it('still clamps a small edge overrun exactly as before', (): void => {
        const parsed = providerQuestionSchema.parse({
            ...question,
            observedRegion: { x1: -5, y1: 100, x2: 1005, y2: 500 },
        })
        expect(parsed.observedRegion).toEqual({ x: 0, y: 0.1, width: 1, height: 0.4 })
        expect(
            providerQuestionSchema.safeParse({ ...question, observedRegion: { x1: -11, y1: 0, x2: 5, y2: 5 } }).success,
        ).toBe(false)
    })
})

describe('provider JSON schema for the regions', (): void => {
    it('keeps the legacy wire schemas free of layout and regions (flag off)', (): void => {
        for (const output of [metaOutputSchemas.check, metaOutputSchemas.question]) {
            expect(output.properties).not.toHaveProperty('nextPartRegion')
            expect(output.properties).not.toHaveProperty('targetRegion')
            expect(output.required).not.toContain('nextPartRegion')
            expect(output.required).not.toContain('targetRegion')
        }
    })

    it('adds nullable closed id-plus-grid-box regions only to the layout variants', (): void => {
        for (const output of [metaLayoutOutputSchemas.check, metaLayoutOutputSchemas.question]) {
            const properties = output.properties as Record<string, unknown>
            expect(output.required).toEqual(expect.arrayContaining(['layout', 'nextPartRegion', 'targetRegion']))
            for (const key of ['nextPartRegion', 'targetRegion']) {
                const text = JSON.stringify(properties[key])
                expect(text).toContain('"type":"null"')
                expect(text).toContain('"additionalProperties":false')
                expect(text).toContain('"partId"')
                expect(text).toContain('"x1"')
                expect(text).not.toMatch(/oneOf|allOf|\$ref|"text"|url|style|html/iu)
            }
        }
    })
})

describe('provider JSON schema carries the compact proposal bounds', (): void => {
    const find = (schema: unknown, key: string): unknown =>
        (schema as Record<string, Record<string, unknown>>).properties?.[key]

    it('bounds components, references and id length in the request schema and states the byte cap', (): void => {
        for (const output of [metaLayoutOutputSchemas.check, metaLayoutOutputSchemas.question]) {
            const text = JSON.stringify(find(output, 'layout'))
            expect(text).toContain(`"maxItems":${PROPOSAL_BUDGET.components}`)
            expect(text).toContain(`"maxItems":${PROPOSAL_BUDGET.references}`)
            expect(text).toContain(`"maxLength":${PROPOSAL_BUDGET.idCharacters}`)
            expect(text).not.toContain('"maxItems":8')
            expect(text).not.toContain('"maxLength":128')
            expect(text).toContain(`${PROPOSAL_BUDGET.layoutBytes} UTF-8 bytes`)
        }
    })

    it('bounds region ids, restricts corners to 0..1000 and states the byte cap', (): void => {
        for (const output of [metaLayoutOutputSchemas.check, metaLayoutOutputSchemas.question]) {
            for (const key of ['nextPartRegion', 'targetRegion']) {
                const text = JSON.stringify(find(output, key))
                expect(text).toContain(`"maxLength":${PROPOSAL_BUDGET.idCharacters}`)
                expect(text).toContain('"minimum":0')
                expect(text).toContain('"maximum":1000')
                expect(text).not.toMatch(/"minimum":-|1010/u)
                expect(text).toContain(`${PROPOSAL_BUDGET.regionBytes} UTF-8 bytes`)
            }
        }
    })
})

describe('compact proposal byte budget (UTF-8 bytes of the serialized field; model tokens are not measured)', (): void => {
    const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
    // An id of exactly `size` UTF-8 bytes and at most 48 characters: a unique digit tag, 2-byte letters, one ASCII filler.
    const idOf = (tag: number, size: number): string =>
        `${tag}${'é'.repeat(Math.floor((size - 1) / 2))}${(size - 1) % 2 === 1 ? 'a' : ''}`
    const layoutOfSizes = (sizes: readonly number[]): { components: unknown[] } => {
        const ids = (offset: number): string[] => [0, 1, 2].map((index) => idOf(offset + index, sizes[offset + index]!))
        return {
            components: [
                { type: 'part_grid', partIds: ids(0) },
                { type: 'visible_checks', checkIds: ids(3) },
                { type: 'connection', partIds: ids(6) },
            ],
        }
    }
    // Spreads the bytes evenly over the 9 ids so every id stays within 48 characters: only the byte cap can reject it.
    const layoutOfBytes = (target: number): { components: unknown[] } => {
        const fixed = bytes(layoutOfSizes(Array.from({ length: 9 }, () => 1))) - 9
        const spread = target - fixed
        const sizes = Array.from({ length: 9 }, (_, index) => Math.floor(spread / 9) + (index < spread % 9 ? 1 : 0))
        const layout = layoutOfSizes(sizes)
        expect(Math.max(...sizes)).toBeLessThanOrEqual(95)
        expect(bytes(layout)).toBe(target)
        return layout
    }
    const regionOfBytes = (target: number): { partId: string; region: Record<string, number> } => {
        // Full-precision doubles are the longest legitimate numbers; they make the byte budget, not the id, the binding bound.
        const region = { x1: 12.345678901234567, y1: 23.456789012345677, x2: 987.6543210987654, y2: 876.5432109876543 }
        const rest = target - bytes({ partId: '', region })
        return { partId: idOf(0, rest), region }
    }
    const parsedWith = (extra: Record<string, unknown>): ReturnType<typeof providerCheckSchema.parse> =>
        providerCheckSchema.parse({ ...check, ...extra })

    it('accepts a layout of exactly the byte budget and drops one byte more (fail-before boundary)', (): void => {
        expect(parsedWith({ layout: layoutOfBytes(PROPOSAL_BUDGET.layoutBytes) })).toHaveProperty('layout')
        expect(parsedWith({ layout: layoutOfBytes(PROPOSAL_BUDGET.layoutBytes + 1) })).not.toHaveProperty(
            'layout',
            expect.anything(),
        )
    })

    it('accepts a region of exactly the byte budget and drops one byte more', (): void => {
        const at = regionOfBytes(PROPOSAL_BUDGET.regionBytes)
        expect(bytes(at)).toBe(PROPOSAL_BUDGET.regionBytes)
        expect(at.partId.length).toBeLessThanOrEqual(PROPOSAL_BUDGET.idCharacters)
        expect(parsedWith({ nextPartRegion: at })).toHaveProperty('nextPartRegion')
        const over = regionOfBytes(PROPOSAL_BUDGET.regionBytes + 1)
        expect(parsedWith({ nextPartRegion: over })).not.toHaveProperty('nextPartRegion', expect.anything())
    })

    it('counts bytes, not characters: multibyte ids over the budget are dropped though within 48 characters', (): void => {
        const wide = 'é'.repeat(PROPOSAL_BUDGET.idCharacters)
        const layout = {
            components: [
                { type: 'part_grid', partIds: [wide.slice(1) + 'a', wide.slice(1) + 'b', wide.slice(1) + 'c'] },
                { type: 'visible_checks', checkIds: [wide.slice(1) + 'a', wide.slice(1) + 'b', wide.slice(1) + 'c'] },
            ],
        }
        expect(JSON.stringify(layout).length).toBeLessThan(PROPOSAL_BUDGET.layoutBytes)
        expect(bytes(layout)).toBeGreaterThan(PROPOSAL_BUDGET.layoutBytes)
        expect(parsedWith({ layout })).not.toHaveProperty('layout', expect.anything())
    })

    it('drops a layout with 4 components, though small in bytes', (): void => {
        const components = [
            { type: 'part_grid', partIds: ['a'] },
            { type: 'orientation', partId: 'a' },
            { type: 'connection', partIds: ['a'] },
            { type: 'visible_checks', checkIds: ['a'] },
        ]
        expect(parsedWith({ layout: { components } })).not.toHaveProperty('layout', expect.anything())
    })

    it('drops a layout carrying a 49-character id', (): void => {
        const components = [{ type: 'part_grid', partIds: ['a'.repeat(PROPOSAL_BUDGET.idCharacters + 1)] }]
        expect(parsedWith({ layout: { components } })).not.toHaveProperty('layout', expect.anything())
    })

    it('drops a layout with 4 references in one component', (): void => {
        const layout = { components: [{ type: 'part_grid', partIds: ['a', 'b', 'c', 'd'] }] }
        expect(parsedWith({ layout })).not.toHaveProperty('layout', expect.anything())
    })

    it('measures the largest accepted addition: layout, both regions, long Unicode ids, at most the stated total', (): void => {
        const layout = layoutOfBytes(PROPOSAL_BUDGET.layoutBytes)
        const region = regionOfBytes(PROPOSAL_BUDGET.regionBytes)
        const parsed = parsedWith({ layout, nextPartRegion: region, targetRegion: region })
        expect(parsed).toHaveProperty('layout')
        expect(parsed).toHaveProperty('nextPartRegion')
        expect(parsed).toHaveProperty('targetRegion')
        const measured = bytes(layout) + bytes(region) + bytes(region)
        expect(measured).toBe(PROPOSAL_MAX_BYTES)
        // Measured locally: 984 UTF-8 bytes of added JSON values at the boundary (key names add under 60 more).
        expect(PROPOSAL_MAX_BYTES).toBe(984)
        expect(bytes({ layout, nextPartRegion: region, targetRegion: region }) - measured).toBeLessThan(60)
    })

    it('measures the longest all-ASCII 48-character layout and keeps it well inside the budget', (): void => {
        const id = (tag: string): string => `${tag}${'a'.repeat(PROPOSAL_BUDGET.idCharacters - 1)}`
        const ids = ['1', '2', '3'].map(id)
        const layout = {
            components: [
                { type: 'visible_checks', checkIds: ids },
                { type: 'connection', partIds: ids },
                { type: 'recovery', actionIds: ids },
            ],
        }
        expect(parsedWith({ layout })).toHaveProperty('layout')
        expect(bytes(layout)).toBeLessThan(PROPOSAL_BUDGET.layoutBytes)
    })
})
