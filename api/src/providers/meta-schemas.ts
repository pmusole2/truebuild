import {
    checkResultSchema,
    normalizedBoxSchema,
    parsedManualSchema,
    proposedLayoutSchema,
    questionResultSchema,
    sourceRefSchema,
} from '@truebuild/contracts'
import { z } from 'zod'

// Provider grounding refers to the exact auto-oriented image sent, on Meta's 0–1000 grid.
// Only small edge overruns are tolerated; inversion, zero area and gross coordinates are refused.
const gridCoordinate = z.number().finite().min(-10).max(1010)
const gridBox = z
    .strictObject({ x1: gridCoordinate, y1: gridCoordinate, x2: gridCoordinate, y2: gridCoordinate })
    .transform((box) => {
        const clamp = (n: number): number => Math.max(0, Math.min(1000, n))
        const x = clamp(box.x1)
        const y = clamp(box.y1)
        return { x: x / 1000, y: y / 1000, width: (clamp(box.x2) - x) / 1000, height: (clamp(box.y2) - y) / 1000 }
    })
    .pipe(normalizedBoxSchema)

// The model may propose a display layout of ids/indexes only. A malformed proposal is dropped at this field alone
// (the verdict and every other strict field still validate); the service resolves or replaces it from step data.
const layoutProposal = proposedLayoutSchema
    .nullable()
    .transform((layout) => layout ?? undefined)
    .catch(undefined)
    .describe(
        'Optional ordered display layout: ids and indexes of the current step only, never text. Null when unsure.',
    )

const assessment = z.enum(['matches', 'mismatch', 'unobservable'])
export const providerParseSchema = z
    .strictObject(parsedManualSchema.shape)
    .omit({ model: true, modelNotes: true })
    .superRefine((value, ctx) => {
        if (!parsedManualSchema.safeParse(value).success)
            ctx.addIssue({ code: 'custom', message: 'Invalid extraction' })
    })

export const providerCheckSchema = z
    .strictObject({
        ...checkResultSchema.shape,
        layout: layoutProposal,
        partsAssessment: assessment,
        connectionAssessment: assessment,
        checks: z
            .array(
                z.strictObject({
                    checkId: z.string().min(1).max(128),
                    assessment,
                    sourceRefs: z.array(sourceRefSchema).max(100),
                }),
            )
            .max(100),
        orientationAssessment: z.enum(['correct', 'reversed', 'uncertain']),
        observedRegion: gridBox.nullable(),
    })
    .omit({ model: true, modelNotes: true, secondOpinion: true })
    .superRefine((value, ctx) => {
        const {
            partsAssessment: _parts,
            connectionAssessment: _connection,
            checks: _checks,
            layout: _layout,
            ...publicValue
        } = value
        if (!checkResultSchema.safeParse(publicValue).success)
            ctx.addIssue({ code: 'custom', message: 'Invalid check evidence' })
    })
export const providerQuestionSchema = z
    .strictObject({
        ...questionResultSchema.shape,
        layout: layoutProposal,
        observedRegion: gridBox.nullable(),
    })
    .omit({ model: true, modelNotes: true })
    .superRefine(({ layout: _layout, ...value }, ctx) => {
        if (!questionResultSchema.safeParse(value).success)
            ctx.addIssue({ code: 'custom', message: 'Invalid question evidence' })
    })

type Schema = Record<string, unknown>
function object(value: unknown): value is Schema {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Expand finite local refs, convert discriminated unions, and require nullable absence.
 * No recursive public contract is introduced: current public extraction is already finite.
 * Domain refinements still run after decoding; JSON shape is never factual acceptance.
 */
export function strictSchema(raw: Schema): Schema {
    function normalize(value: unknown, refs: readonly string[] = []): unknown {
        if (Array.isArray(value)) return value.map((entry) => normalize(entry, refs))
        if (!object(value)) return value
        if (typeof value.$ref === 'string') {
            const ref = value.$ref
            if (!ref.startsWith('#/') || refs.includes(ref)) throw new Error('invalid_provider_schema')
            let resolved: unknown = raw
            for (const key of ref.slice(2).split('/')) {
                resolved = object(resolved) ? resolved[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined
            }
            if (!object(resolved)) throw new Error('invalid_provider_schema')
            return normalize(resolved, [...refs, ref])
        }
        const result: Schema = {}
        for (const [key, entry] of Object.entries(value)) {
            if (['$schema', '$defs', 'definitions', 'discriminator'].includes(key)) continue
            if (key === 'allOf') throw new Error('invalid_provider_schema')
            result[key === 'oneOf' ? 'anyOf' : key] = normalize(entry, refs)
        }
        if (result.type === 'object' && object(result.properties)) {
            const required = Array.isArray(result.required) ? result.required : []
            for (const [name, property] of Object.entries(result.properties)) {
                if (!required.includes(name)) result.properties[name] = { anyOf: [property, { type: 'null' }] }
            }
            result.required = Object.keys(result.properties)
            result.additionalProperties = false
        }
        return result
    }
    const normalized = normalize(raw)
    if (!object(normalized)) throw new Error('invalid_provider_schema')
    assertStrictSchema(normalized)
    return normalized
}

/** Fail startup rather than send an oversized/nonconforming schema to the provider. */
export function assertStrictSchema(schema: Schema): void {
    let nodes = 0
    let properties = 0
    let strings = 0
    let enums = 0
    function visit(value: unknown, depth: number): void {
        if (++nodes > 200_000) throw new Error('invalid_provider_schema')
        if (typeof value === 'string') strings += value.length
        if (Array.isArray(value)) {
            value.forEach((entry) => visit(entry, depth))
            return
        }
        if (!object(value)) return
        if ('$ref' in value || 'oneOf' in value || 'allOf' in value) throw new Error('invalid_provider_schema')
        const next = depth + (value.type === 'object' || value.type === 'array' ? 1 : 0)
        if (next > 10) throw new Error('invalid_provider_schema')
        if (value.type === 'object') {
            if (
                !object(value.properties) ||
                value.additionalProperties !== false ||
                !Array.isArray(value.required) ||
                Object.keys(value.properties).some((key) => !(value.required as unknown[]).includes(key)) ||
                value.required.length !== Object.keys(value.properties).length
            )
                throw new Error('invalid_provider_schema')
            properties += Object.keys(value.properties).length
        }
        if (Array.isArray(value.enum)) {
            enums += value.enum.length
            if (value.enum.length > 250 && JSON.stringify(value.enum).length > 15_000)
                throw new Error('invalid_provider_schema')
        }
        for (const [key, entry] of Object.entries(value)) {
            strings += key.length
            visit(entry, next)
        }
    }
    if (schema.type !== 'object' || 'anyOf' in schema) throw new Error('invalid_provider_schema')
    visit(schema, 0)
    if (properties > 5_000 || strings > 120_000 || enums > 1_000) throw new Error('invalid_provider_schema')
}

export const metaOutputSchemas = {
    parse: strictSchema(z.toJSONSchema(providerParseSchema, { target: 'draft-7' })),
    // Preserve the existing request schema until the frozen provider can select layouts per runtime flag.
    check: strictSchema(
        z.toJSONSchema(z.strictObject(providerCheckSchema.shape).omit({ layout: true }), {
            target: 'draft-7',
            io: 'input',
        }),
    ),
    question: strictSchema(
        z.toJSONSchema(z.strictObject(providerQuestionSchema.shape).omit({ layout: true }), {
            target: 'draft-7',
            io: 'input',
        }),
    ),
}

/** Prepared schema variants; wiring their selection awaits the separate provider change. No extra call is made. */
export const metaLayoutOutputSchemas = {
    check: strictSchema(z.toJSONSchema(providerCheckSchema, { target: 'draft-7', io: 'input' })),
    question: strictSchema(z.toJSONSchema(providerQuestionSchema, { target: 'draft-7', io: 'input' })),
}

const message = z.object({
    type: z.literal('message'),
    role: z.literal('assistant'),
    status: z.literal('completed'),
    content: z
        .array(
            z.object({
                type: z.literal('output_text'),
                text: z.string().min(1).max(1_048_576),
                annotations: z.array(z.unknown()).max(0).optional(),
            }),
        )
        .length(1),
})
export const completedResponseSchema = z
    .object({
        status: z.literal('completed'),
        error: z.null().optional(),
        incomplete_details: z.null().optional(),
        output: z
            .array(z.union([message, z.object({ type: z.literal('reasoning') })]))
            .min(1)
            .max(32),
    })
    .refine((value) => value.output.filter((item) => item.type === 'message').length === 1)
