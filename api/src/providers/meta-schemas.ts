import {
    checkResultSchema,
    normalizedBoxSchema,
    parsedManualSchema,
    partRegionSchema,
    proposedLayoutSchema,
    providerScreenProposalSchema,
    questionResultSchema,
    sourceRefSchema,
    PIECE_SPEC_LIMITS,
    pieceSpecSchema,
} from '@truebuild/contracts'
import { z } from 'zod'

import { wireProposalSchema } from './document-wire'

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

/**
 * Provider-only proposal budget under MODEL_LAYOUT=1 (the public layout contract is unchanged and larger).
 * The proposal shares the unchanged 1500-token check/ask cap with reasoning, so every field is bounded in count, id
 * length and serialized UTF-8 bytes (JSON.stringify of the field as the model sent it). Bytes are the measurement;
 * no model-token figure is claimed. Anything over a bound is dropped at its own field, never truncated or repaired.
 */
export const PROPOSAL_BUDGET = {
    components: 3,
    references: 3,
    idCharacters: 48,
    layoutBytes: 600,
    regionBytes: 192,
} as const
/** Largest accepted addition to the check/ask output: one layout plus both regions (field names excluded). */
export const PROPOSAL_MAX_BYTES = PROPOSAL_BUDGET.layoutBytes + 2 * PROPOSAL_BUDGET.regionBytes

const utf8Bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

const compactId = z.string().trim().min(1).max(PROPOSAL_BUDGET.idCharacters)
const compactIds = z.array(compactId).min(1).max(PROPOSAL_BUDGET.references)

// Same closed component set as the public layout, with the small provider bounds. The public schema is not widened.
const compactLayout = z
    .strictObject({
        components: z
            .array(
                z.discriminatedUnion('type', [
                    z.strictObject({ type: z.literal('part_grid'), partIds: compactIds }),
                    z.strictObject({ type: z.literal('orientation'), partId: compactId }),
                    z.strictObject({ type: z.literal('connection'), partIds: compactIds }),
                    z.strictObject({ type: z.literal('visible_checks'), checkIds: compactIds }),
                    z.strictObject({
                        type: z.literal('source_diagram'),
                        sourceRefIndexes: z
                            .array(z.number().int().min(0).max(99))
                            .min(1)
                            .max(PROPOSAL_BUDGET.references),
                    }),
                    z.strictObject({ type: z.literal('recovery'), actionIds: compactIds }),
                ]),
            )
            .min(1)
            .max(PROPOSAL_BUDGET.components),
    })
    .superRefine((layout, ctx) => {
        if (utf8Bytes(layout) > PROPOSAL_BUDGET.layoutBytes)
            ctx.addIssue({ code: 'custom', message: 'Layout proposal exceeds its byte budget' })
    })
    // The public contract still decides shape (no repeats) so a proposal can never be wider than the public layout.
    .pipe(proposedLayoutSchema)

// The model may propose a display layout of ids/indexes only. A malformed or over-budget proposal is dropped at this
// field alone (the verdict and every other strict field still validate); the service resolves or replaces it.
const layoutProposal = compactLayout
    .nullable()
    .transform((layout) => layout ?? undefined)
    .catch(undefined)
    .describe(
        `Optional ordered display layout: at most ${PROPOSAL_BUDGET.components} components of at most ${PROPOSAL_BUDGET.references} ids/indexes each, ids of the current step only, never text. The serialized JSON must be at most ${PROPOSAL_BUDGET.layoutBytes} UTF-8 bytes or it is dropped. Null when unsure.`,
    )

// New regions use a STRICT grid conversion: every raw coordinate must lie inside 0..1000 as returned, and the
// normalized box is exactly raw/1000 (no clamping, no tolerance, no invented geometry). The tolerant gridBox above is
// kept only for the existing observedRegion semantics.
const strictGridCoordinate = z.number().finite().min(0).max(1000)
const strictCorners = z.strictObject({
    x1: strictGridCoordinate,
    y1: strictGridCoordinate,
    x2: strictGridCoordinate,
    y2: strictGridCoordinate,
})
const strictGridBox = strictCorners
    .transform((box) => ({
        x: box.x1 / 1000,
        y: box.y1 / 1000,
        width: (box.x2 - box.x1) / 1000,
        height: (box.y2 - box.y1) / 1000,
    }))
    .pipe(normalizedBoxSchema)

// Optional grounded regions of a real current-step part. Only the field is dropped when it is malformed (inverted,
// zero-area, any coordinate outside 0..1000, extra keys, over its byte budget); the service then checks the identity.
const gridPartRegion = z
    .strictObject({ partId: compactId, region: strictCorners })
    .superRefine((value, ctx) => {
        if (utf8Bytes(value) > PROPOSAL_BUDGET.regionBytes)
            ctx.addIssue({ code: 'custom', message: 'Region proposal exceeds its byte budget' })
    })
    .transform((value, ctx) => {
        const region = strictGridBox.safeParse(value.region)
        if (!region.success) {
            ctx.addIssue({ code: 'custom', message: 'Invalid region' })
            return z.NEVER
        }
        return { partId: partRegionSchema.shape.partId.parse(value.partId), region: region.data }
    })
    .nullable()
    .transform((region) => region ?? undefined)
    .catch(undefined)
    .describe(
        `Optional {partId, region} of one current-step part; partId at most ${PROPOSAL_BUDGET.idCharacters} characters, region corners inside 0-1000, serialized JSON at most ${PROPOSAL_BUDGET.regionBytes} UTF-8 bytes or it is dropped. Null when unsure.`,
    )

const assessment = z.enum(['matches', 'mismatch', 'unobservable'])
export const providerParseSchema = z
    .strictObject(parsedManualSchema.shape)
    .omit({ model: true, modelNotes: true, telemetry: true })
    .superRefine((value, ctx) => {
        if (!parsedManualSchema.safeParse(value).success)
            ctx.addIssue({ code: 'custom', message: 'Invalid extraction' })
    })

/** What the person is told when the photo cannot establish the orientation. */
export const RETAKE_FROM_FRONT = 'Retake the photo from the front.'

/**
 * An uncertain orientation can never establish a verdict (the public contract says so): whatever pass or refusal the
 * model claimed beside it becomes cannot_verify with a retake instruction. This runs after the strict shape check and
 * before the cross-field refinement, so unknown keys, citations and every other evidence rule are enforced unchanged;
 * every uncertain result, including cannot_verify, carries the same clear retake action.
 */
function unverifiableWhenOrientationUncertain<
    T extends {
        decision: 'pass' | 'refuse' | 'cannot_verify'
        orientationAssessment: 'correct' | 'reversed' | 'uncertain'
        reason: string
        missingEvidence: string[]
        layout?: unknown
        observedRegion?: unknown
    },
>(value: T): T {
    if (value.orientationAssessment !== 'uncertain') return value
    const evidence = value.missingEvidence.filter((item) => item !== RETAKE_FROM_FRONT)
    return {
        ...value,
        decision: 'cannot_verify',
        reason:
            value.decision === 'cannot_verify' && evidence.length < 100
                ? value.reason
                : `The orientation could not be determined. ${RETAKE_FROM_FRONT}`,
        // Keep every supplied item at the public 100-item boundary; the reason still leads with the retake action.
        missingEvidence: evidence.length < 100 ? [RETAKE_FROM_FRONT, ...evidence] : value.missingEvidence,
    }
}

const providerCheckShape = z
    .strictObject({
        ...checkResultSchema.shape,
        layout: layoutProposal,
        nextPartRegion: gridPartRegion,
        targetRegion: gridPartRegion,
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
    .omit({ model: true, modelNotes: true, telemetry: true, secondOpinion: true, followUps: true, evidence: true })
export const providerCheckSchema = providerCheckShape
    .transform(unverifiableWhenOrientationUncertain)
    .superRefine((value, ctx) => {
        const {
            partsAssessment: _parts,
            connectionAssessment: _connection,
            checks: _checks,
            layout: _layout,
            nextPartRegion: _next,
            targetRegion: _target,
            ...publicValue
        } = value
        if (!checkResultSchema.safeParse(publicValue).success)
            ctx.addIssue({ code: 'custom', message: 'Invalid check evidence' })
    })
/**
 * The Spark verdict when a Wonder overlay stage follows: a decision with its grounded evidence and no geometry at all
 * (no observedRegion, layout or regions). A refusal is valid without a region; orientation, parts, connection and
 * visible-check evidence are still required, so the evidence needed for a pass or a refusal is unchanged.
 */
const verdictShape = z
    .strictObject(providerCheckShape.shape)
    .omit({ layout: true, nextPartRegion: true, targetRegion: true, observedRegion: true })
export const providerVerdictSchema = verdictShape
    .transform(unverifiableWhenOrientationUncertain)
    .superRefine((value, ctx) => {
        const { partsAssessment: _parts, connectionAssessment: _connection, checks: _checks, ...publicValue } = value
        if (!checkResultSchema.safeParse({ ...publicValue, observedRegion: null }).success)
            ctx.addIssue({ code: 'custom', message: 'Invalid check evidence' })
    })
export const providerQuestionSchema = z
    .strictObject({
        ...questionResultSchema.shape,
        layout: layoutProposal,
        nextPartRegion: gridPartRegion,
        targetRegion: gridPartRegion,
        observedRegion: gridBox.nullable(),
    })
    .omit({ model: true, modelNotes: true, telemetry: true })
    .superRefine(({ layout: _layout, nextPartRegion: _next, targetRegion: _target, ...value }, ctx) => {
        if (!questionResultSchema.safeParse(value).success)
            ctx.addIssue({ code: 'custom', message: 'Invalid question evidence' })
    })

/**
 * Presentation-only output of the asynchronous overlay stage. There is deliberately no decision, reason or citation
 * field: the published verdict is fixed context, so this stage cannot change it. Regions use the strict grid.
 */
export const providerOverlaySchema = z.strictObject({
    observedRegion: gridBox.nullable(),
    layout: layoutProposal,
    nextPartRegion: gridPartRegion,
    targetRegion: gridPartRegion,
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

// Geometry inference uses the six primitives and extrude named by the active prompt. Reuse the shared part bounds and
// refinements; legacy lathe geometry remains valid in cached registries and viewer fixtures.
const piecePartOptions = pieceSpecSchema.shape.parts.element.options
type PiecePartOf<Type extends string> = Extract<
    (typeof piecePartOptions)[number],
    { shape: { type: { values: Set<Type> } } }
>
// Select by literal type rather than position, so a contract reorder cannot silently swap a part schema.
function piecePartOf<Type extends string>(type: Type): PiecePartOf<Type> {
    const option = piecePartOptions.find((part): part is PiecePartOf<Type> => {
        const values: ReadonlySet<string> = part.shape.type.values
        return values.has(type)
    })
    if (!option) throw new Error(`invalid_piece_part_schema:${type}`)
    return option
}
const requestedPieceSchema = pieceSpecSchema.extend({
    parts: z
        .array(
            z.discriminatedUnion('type', [
                piecePartOf('box'),
                piecePartOf('cylinder'),
                piecePartOf('cone'),
                piecePartOf('sphere'),
                piecePartOf('torus'),
                piecePartOf('capsule'),
                piecePartOf('extrude'),
            ]),
        )
        .min(1)
        .max(PIECE_SPEC_LIMITS.parts),
})

export const metaOutputSchemas = {
    pieces: strictSchema(
        z.toJSONSchema(
            z.strictObject({
                pieces: z.array(requestedPieceSchema).max(8),
            }),
            { target: 'draft-7', io: 'input' },
        ),
    ),
    parse: strictSchema(z.toJSONSchema(providerParseSchema, { target: 'draft-7' })),
    // Legacy wire schemas: no layout or regions. The provider sends these unless MODEL_LAYOUT=1 selects the variants below.
    check: strictSchema(
        z.toJSONSchema(
            z.strictObject(providerCheckShape.shape).omit({ layout: true, nextPartRegion: true, targetRegion: true }),
            {
                target: 'draft-7',
                io: 'input',
            },
        ),
    ),
    question: strictSchema(
        z.toJSONSchema(
            z
                .strictObject(providerQuestionSchema.shape)
                .omit({ layout: true, nextPartRegion: true, targetRegion: true }),
            {
                target: 'draft-7',
                io: 'input',
            },
        ),
    ),
    overlay: strictSchema(z.toJSONSchema(providerOverlaySchema, { target: 'draft-7', io: 'input' })),
    screen: strictSchema(z.toJSONSchema(providerScreenProposalSchema, { target: 'draft-7', io: 'input' })),
    // Version 2 document: a flat node table (finite, no recursion); the server rebuilds the tree (see document-wire.ts).
    document: strictSchema(z.toJSONSchema(wireProposalSchema, { target: 'draft-7', io: 'input' })),
}

/** Wire schema of the verdict-only Spark call (same `truebuild_check` name; no geometry property exists in it). */
export const metaVerdictOutputSchema = strictSchema(z.toJSONSchema(verdictShape, { target: 'draft-7', io: 'input' }))

/** Variants selected by the provider only for MODEL_LAYOUT=1: same single call, adds nullable layout and regions. */
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

/** True when the provider reports an unfinished response (for example the output cap was reached). */
export function isIncompleteResponse(raw: unknown): boolean {
    return (
        typeof raw === 'object' &&
        raw !== null &&
        'status' in raw &&
        (raw.status === 'incomplete' ||
            ('incomplete_details' in raw && raw.incomplete_details !== null && raw.incomplete_details !== undefined))
    )
}
