import { z } from 'zod'

import { layoutSchema } from './layout'
import { optionalPieceDrawingBoxSchema } from './piece-generation'
import { callTelemetrySchema, FIXTURE_EVIDENCE, fixtureEvidenceSchema, standardModelSchema } from './telemetry'

export const LIMITS = {
    manualPages: 20,
    imageBytes: 4_194_304,
    imagePixels: 24_000_000,
    requestImages: 21,
    requestBytes: 8_388_608,
} as const

const idSchema = z.string().trim().min(1).max(128)
const descriptionSchema = z.string().trim().min(1).max(500)
const titleSchema = z.string().trim().min(1).max(200)
const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const coordinateSchema = z.number().finite().min(0).max(1)

export const normalizedBoxSchema = z
    .strictObject({
        x: coordinateSchema,
        y: coordinateSchema,
        width: coordinateSchema.positive(),
        height: coordinateSchema.positive(),
    })
    .superRefine((box, ctx) => {
        if (box.x + box.width > 1 || box.y + box.height > 1) {
            ctx.addIssue({ code: 'custom', message: 'Region must lie within the source image' })
        }
    })

export type NormalizedBox = z.infer<typeof normalizedBoxSchema>

/**
 * A grounded region on the exact observation photo for one real part of the current step. The box is public
 * normalized 0..1 (top-left origin, fully inside the image). Absence is meaningful: nothing is ever synthesized.
 */
export const partRegionSchema = z.strictObject({ partId: idSchema, region: normalizedBoxSchema })

export type PartRegion = z.infer<typeof partRegionSchema>

export const sourceRefSchema = z.strictObject({
    pageId: idSchema,
    region: normalizedBoxSchema.nullable(),
})

export type SourceRef = z.infer<typeof sourceRefSchema>

const sourceRefsSchema = z.array(sourceRefSchema).max(100)
const knownSourceRefsSchema = sourceRefsSchema.min(1)

export type Fact<T> = { state: 'known'; value: T; sourceRefs: SourceRef[] } | { state: 'unknown'; reason: string }

function factSchema<T>(valueSchema: z.ZodType<T>): z.ZodType<Fact<T>> {
    return z.discriminatedUnion('state', [
        z.strictObject({ state: z.literal('known'), value: valueSchema, sourceRefs: knownSourceRefsSchema }),
        z.strictObject({ state: z.literal('unknown'), reason: descriptionSchema }),
    ])
}

const orientationSchema = z.strictObject({ partId: idSchema, description: descriptionSchema })
const connectionSchema = z
    .strictObject({
        partIds: z.array(idSchema).min(1).max(256),
        description: descriptionSchema,
    })
    .superRefine((connection, ctx) => {
        rejectDuplicates(connection.partIds, 'connection part', ctx)
    })

export type Orientation = z.infer<typeof orientationSchema>
export type Connection = z.infer<typeof connectionSchema>

const manualPartSchema = z.strictObject({
    partId: idSchema,
    name: factSchema(titleSchema),
    /** Printed inventory data from the same cited page as the name; null/absent when not printed. */
    label: z.string().trim().min(1).max(80).nullable().optional(),
    dimensions: z.string().trim().min(1).max(300).nullable().optional(),
    inventoryQuantity: z.number().int().positive().max(100_000).nullable().optional(),
    /** Drawing on the name's cited inventory page, not a text/table-cell rectangle. */
    drawingBox: optionalPieceDrawingBoxSchema,
})
const partRequirementSchema = z
    .strictObject({
        partId: idSchema,
        quantity: factSchema(positiveIntegerSchema),
        quantityBasis: z
            .strictObject({
                kind: z.enum(['user_supplied', 'not_specified', 'carried_over']),
                sourceRefs: knownSourceRefsSchema,
                stepId: idSchema.nullable().optional(),
                partId: idSchema.nullable().optional(),
            })
            .nullable()
            .optional(),
    })
    .superRefine((part, ctx) => {
        const basis = part.quantityBasis
        if (basis?.kind === 'carried_over') {
            if (basis.stepId == null || basis.partId !== part.partId || part.quantity.state !== 'known') {
                ctx.addIssue({
                    code: 'custom',
                    message: 'Carried quantity requires a known count and same-part reference',
                })
            }
        } else if (basis?.stepId != null || basis?.partId != null) {
            ctx.addIssue({ code: 'custom', message: 'Only carried quantities may reference an earlier step or part' })
        }
        if (part.quantityBasis?.kind === 'not_specified' && part.quantity.state === 'known') {
            ctx.addIssue({ code: 'custom', message: 'An unspecified quantity cannot contain a numeric count' })
        }
    })
const visibleCheckSchema = z.strictObject({ checkId: idSchema, description: factSchema(descriptionSchema) })
const correctionActionSchema = z.strictObject({
    actionId: idSchema,
    instruction: descriptionSchema,
    sourceRefs: knownSourceRefsSchema,
})
const correctionPlanSchema = z
    .strictObject({
        reviewed: z.boolean(),
        actions: z.array(correctionActionSchema).min(1).max(100),
    })
    .superRefine((plan, ctx) => {
        rejectDuplicates(
            plan.actions.map((action) => action.actionId),
            'correction action',
            ctx,
        )
    })

/**
 * A safety statement the manual itself makes for a step (a warning, caution or prohibition), read verbatim with the
 * pages that print it. A note the extraction could not read is `unknown`: it stays unresolved and blocks a reviewed
 * manual (it is never invented and never shown as a fact), so a person adds a clearer page.
 */
const safetyNoteSchema = z.strictObject({ noteId: idSchema, note: factSchema(descriptionSchema) })

export type ManualPart = z.infer<typeof manualPartSchema>
export type SafetyNote = z.infer<typeof safetyNoteSchema>
export type PartRequirement = z.infer<typeof partRequirementSchema>
export type VisibleCheck = z.infer<typeof visibleCheckSchema>
export type CorrectionAction = z.infer<typeof correctionActionSchema>
export type CorrectionPlan = z.infer<typeof correctionPlanSchema>

export const manualStepSchema = z
    .strictObject({
        stepId: idSchema,
        order: positiveIntegerSchema,
        title: titleSchema,
        kind: z.enum(['assembly', 'adjust', 'connect', 'tighten', 'route']).nullable().optional(),
        requirements: z
            .strictObject({
                orientation: z.boolean(),
                connection: z.boolean(),
                visibleChecks: z.boolean(),
            })
            .nullable()
            .optional(),
        alternatives: z
            .array(
                z.strictObject({
                    alternativeId: idSchema,
                    title: titleSchema,
                    description: descriptionSchema,
                    sourceRefs: knownSourceRefsSchema,
                }),
            )
            .min(2)
            .max(16)
            .nullable()
            .optional(),
        selectedAlternativeId: idSchema.nullable().optional(),
        parts: z.array(partRequirementSchema).max(256),
        orientation: factSchema(orientationSchema),
        connection: factSchema(connectionSchema),
        visibleChecks: z.array(visibleCheckSchema).max(100),
        sourceRefs: sourceRefsSchema,
        correction: correctionPlanSchema.nullable(),
        /**
         * Explicit safety classification. Absent/null = the step was never classified (older data): every known
         * physical direction of the step is then conservatively treated as potentially safety-bearing (see
         * `requiredManualFacts`). An array, even an empty one, means the extraction read the step's safety text.
         */
        safetyNotes: z.array(safetyNoteSchema).max(100).nullable().optional(),
    })
    .superRefine((step, ctx) => {
        rejectDuplicates(
            (step.safetyNotes ?? []).map((note) => note.noteId),
            'safety note',
            ctx,
        )
        const alternatives = step.alternatives ?? []
        rejectDuplicates(
            alternatives.map((alternative) => alternative.alternativeId),
            'alternative',
            ctx,
        )
        if (
            alternatives.length > 0
                ? !alternatives.some((alternative) => alternative.alternativeId === step.selectedAlternativeId)
                : step.selectedAlternativeId != null
        ) {
            ctx.addIssue({ code: 'custom', message: 'Selected alternative must identify one cited path' })
        }
        rejectDuplicates(
            step.parts.map((part) => part.partId),
            'step part',
            ctx,
        )
        rejectDuplicates(
            step.visibleChecks.map((check) => check.checkId),
            'visible check',
            ctx,
        )
    })

export type ManualStep = z.infer<typeof manualStepSchema>

/** Validate every link by identity and order; the public numeric Fact shape stays unchanged. */
export function hasValidQuantityEvidence(
    step: ManualStep,
    part: PartRequirement,
    steps: readonly ManualStep[],
): boolean {
    let currentStep = step
    let currentPart = part
    const visited = new Set<string>()

    for (let depth = 0; depth <= steps.length; depth++) {
        if (!partRequirementSchema.safeParse(currentPart).success) {
            return false
        }
        const basis = currentPart.quantityBasis
        if (basis?.kind !== 'carried_over') {
            return currentPart.quantity.state === 'known' || basis != null
        }
        if (currentPart.quantity.state !== 'known' || visited.has(currentStep.stepId)) {
            return false
        }
        visited.add(currentStep.stepId)
        const targets = steps.filter((candidate) => candidate.stepId === basis.stepId)
        const target = targets.length === 1 ? targets[0] : undefined
        if (!target || target.order >= currentStep.order || basis.partId !== currentPart.partId) {
            return false
        }
        const targetParts = target.parts.filter((candidate) => candidate.partId === basis.partId)
        const targetPart = targetParts.length === 1 ? targetParts[0] : undefined
        if (
            !targetPart ||
            targetPart.quantity.state !== 'known' ||
            targetPart.quantity.value !== currentPart.quantity.value
        ) {
            return false
        }
        currentStep = target
        currentPart = targetPart
    }
    return false
}

/** Include anchor fact/basis citations without following arbitrary or invalid references. */
export function carriedQuantitySourceRefs(step: ManualStep, steps: readonly ManualStep[]): SourceRef[] {
    const refs = new Map<string, SourceRef>()
    for (const part of step.parts) {
        if (part.quantityBasis?.kind !== 'carried_over' || !hasValidQuantityEvidence(step, part, steps)) {
            continue
        }
        let currentPart = part
        for (let depth = 0; depth < steps.length; depth++) {
            const basis = currentPart.quantityBasis
            if (basis?.kind !== 'carried_over') {
                break
            }
            const target = steps.find((candidate) => candidate.stepId === basis.stepId)
            const targetPart = target?.parts.find((candidate) => candidate.partId === basis.partId)
            if (!targetPart || targetPart.quantity.state !== 'known') {
                break
            }
            for (const ref of [...targetPart.quantity.sourceRefs, ...(targetPart.quantityBasis?.sourceRefs ?? [])]) {
                refs.set(JSON.stringify(ref), ref)
            }
            currentPart = targetPart
        }
    }
    return [...refs.values()]
}

/** Legacy or assembly steps always retain every assembly evidence requirement. */
export function stepEvidenceRequirements(step: ManualStep): {
    parts: boolean
    orientation: boolean
    connection: boolean
    visibleChecks: boolean
} {
    const assembly = step.kind == null || step.kind === 'assembly'
    return {
        parts: assembly,
        orientation: assembly || step.requirements?.orientation === true,
        connection: assembly || step.requirements?.connection === true,
        visibleChecks: assembly || step.requirements?.visibleChecks === true,
    }
}

const manualPageSchema = z
    .strictObject({
        pageId: idSchema,
        assetId: idSchema,
        width: positiveIntegerSchema,
        height: positiveIntegerSchema,
        mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .superRefine((page, ctx) => {
        if (page.width * page.height > LIMITS.imagePixels) {
            ctx.addIssue({ code: 'custom', message: 'Image exceeds pixel limit' })
        }
    })

export type ManualPage = z.infer<typeof manualPageSchema>

function rejectDuplicates(values: readonly (string | number)[], label: string, ctx: z.RefinementCtx): void {
    if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: 'custom', message: `Duplicate ${label} identity` })
    }
}

function validateRegistry(parts: ManualPart[], steps: ManualStep[], ctx: z.RefinementCtx): void {
    rejectDuplicates(
        parts.map((part) => part.partId),
        'part',
        ctx,
    )
    rejectDuplicates(
        steps.map((step) => step.stepId),
        'step',
        ctx,
    )
    rejectDuplicates(
        steps.map((step) => step.order),
        'step order',
        ctx,
    )
    const partIds = new Set(parts.map((part) => part.partId))

    for (const step of steps) {
        for (const part of step.parts) {
            if (part.quantityBasis?.kind === 'carried_over' && !hasValidQuantityEvidence(step, part, steps)) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'Carried quantity must match valid earlier same-part evidence',
                })
            }
        }
        const references = step.parts.map((part) => part.partId)
        if (step.orientation.state === 'known') {
            references.push(step.orientation.value.partId)
        }
        if (step.connection.state === 'known') {
            references.push(...step.connection.value.partIds)
        }
        if (references.some((partId) => !partIds.has(partId))) {
            ctx.addIssue({ code: 'custom', message: 'Step refers to an unresolved part' })
        }
    }
}

const modelProvenance = {
    model: standardModelSchema.optional(),
    modelNotes: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
    /** Server-observed facts about the one provider call behind this result. Absent when no call is attributable. */
    telemetry: callTelemetrySchema.optional(),
}
const secondOpinionSchema = z.discriminatedUnion('status', [
    z.strictObject({ model: standardModelSchema, status: z.literal('available'), token: z.string().min(1).max(128) }),
    z.strictObject({ model: standardModelSchema, status: z.literal('completed') }),
    z.strictObject({ model: standardModelSchema, status: z.literal('unavailable') }),
])

/**
 * Optional follow-up work offered after the verdict is published. Neither can change the decision. Absent unless the
 * server enables them (GENERATIVE_UI other than off), so an old client sees the exact previous shape.
 */
export const SEGMENT_PROMPT_LIMIT = 8
export const checkFollowUpsSchema = z.strictObject({
    overlay: z
        .discriminatedUnion('status', [
            z.strictObject({
                status: z.literal('available'),
                model: standardModelSchema,
                token: z.string().min(1).max(128),
            }),
            z.strictObject({ status: z.literal('unavailable') }),
        ])
        .optional(),
    segments: z
        .strictObject({
            status: z.literal('available'),
            model: z.literal('sam-3.1'),
            /** Noun phrases built by the server from validated part names of the current step only. */
            prompts: z.array(z.string().trim().min(1).max(100)).min(1).max(SEGMENT_PROMPT_LIMIT),
        })
        .optional(),
})
export type CheckFollowUps = z.infer<typeof checkFollowUpsSchema>

export const parsedManualSchema = z
    .strictObject({
        ...modelProvenance,
        parts: z.array(manualPartSchema).max(256),
        steps: z.array(manualStepSchema).max(200),
        unknowns: z.array(descriptionSchema).max(200),
    })
    .superRefine((manual, ctx) => {
        validateRegistry(manual.parts, manual.steps, ctx)
        if (manual.steps.some((step) => step.correction?.reviewed === true)) {
            ctx.addIssue({ code: 'custom', message: 'Extraction cannot mark a correction human-reviewed' })
        }
    })

export type ParsedManual = z.infer<typeof parsedManualSchema>

function factRefs<T>(fact: Fact<T>): SourceRef[] {
    return fact.state === 'known' ? fact.sourceRefs : []
}

function allSourceRefs(parts: ManualPart[], steps: ManualStep[]): SourceRef[] {
    return [
        ...parts.flatMap((part) => factRefs(part.name)),
        ...steps.flatMap((step) => [
            ...step.sourceRefs,
            ...step.parts.flatMap((part) => [...factRefs(part.quantity), ...(part.quantityBasis?.sourceRefs ?? [])]),
            ...(step.alternatives?.flatMap((alternative) => alternative.sourceRefs) ?? []),
            ...factRefs(step.orientation),
            ...factRefs(step.connection),
            ...step.visibleChecks.flatMap((check) => factRefs(check.description)),
            ...(step.safetyNotes ?? []).flatMap((note) => factRefs(note.note)),
            ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
        ]),
    ]
}

export const manualSessionSchema = z
    .strictObject({
        manualId: idSchema,
        title: titleSchema,
        updatedAt: z.iso.datetime(),
        revision: positiveIntegerSchema,
        pages: z.array(manualPageSchema).max(LIMITS.manualPages),
        parts: z.array(manualPartSchema).max(256),
        rawExtraction: parsedManualSchema.nullable(),
        // User-selected extraction inputs, including pages from which no facts could be read.
        // Optional for sessions saved before extraction custody was recorded explicitly.
        extractionSourcePageIds: z.array(idSchema).max(LIMITS.manualPages).optional(),
        reviewedSteps: z.array(manualStepSchema).max(200),
        reviewStatus: z.enum(['unreviewed', 'reviewed']),
    })
    .superRefine((session, ctx) => {
        rejectDuplicates(
            session.pages.map((page) => page.pageId),
            'page',
            ctx,
        )
        rejectDuplicates(
            session.pages.map((page) => page.assetId),
            'asset',
            ctx,
        )
        validateRegistry(session.parts, session.reviewedSteps, ctx)
        const pageIds = new Set(session.pages.map((page) => page.pageId))
        const extractionPages = session.extractionSourcePageIds ?? []
        rejectDuplicates(extractionPages, 'extraction source page', ctx)
        if (extractionPages.some((pageId) => !pageIds.has(pageId))) {
            ctx.addIssue({ code: 'custom', message: 'Extraction source points to an unresolved page' })
        }
        if (extractionPages.length > 0 && session.rawExtraction === null) {
            ctx.addIssue({ code: 'custom', message: 'Extraction sources require preserved raw evidence' })
        }
        const refs = [
            ...allSourceRefs(session.parts, session.reviewedSteps),
            ...allSourceRefs(session.rawExtraction?.parts ?? [], session.rawExtraction?.steps ?? []),
        ]
        if (refs.some((ref) => !pageIds.has(ref.pageId))) {
            ctx.addIssue({ code: 'custom', message: 'Source reference points to an unresolved page' })
        }
        if (session.reviewStatus === 'reviewed') {
            const unresolved =
                session.reviewedSteps.length === 0 ||
                session.parts.some((part) => part.name.state === 'unknown') ||
                session.reviewedSteps.some((step) => {
                    const required = stepEvidenceRequirements(step)
                    return (
                        step.sourceRefs.length === 0 ||
                        (required.parts && step.parts.length === 0) ||
                        step.parts.some((part) => !hasValidQuantityEvidence(step, part, session.reviewedSteps)) ||
                        (required.orientation && step.orientation.state === 'unknown') ||
                        (required.connection && step.connection.state === 'unknown') ||
                        (required.visibleChecks && step.visibleChecks.length === 0) ||
                        step.visibleChecks.some((check) => check.description.state === 'unknown') ||
                        (step.safetyNotes ?? []).some((note) => note.note.state === 'unknown') ||
                        (step.correction !== null && !step.correction.reviewed)
                    )
                })
            if (unresolved) {
                ctx.addIssue({ code: 'custom', message: 'Reviewed manual has unresolved critical facts or review' })
            }
        }
    })

export type ManualSession = z.infer<typeof manualSessionSchema>

export type ManualSummary = Pick<ManualSession, 'manualId' | 'title' | 'updatedAt' | 'reviewStatus'> & {
    stepCount: number
}

export const manualBindingSchema = z.strictObject({
    kind: z.literal('manual'),
    manualId: idSchema,
    revision: positiveIntegerSchema,
})
export const captureBindingSchema = z.strictObject({
    kind: z.literal('capture'),
    manualId: idSchema,
    revision: positiveIntegerSchema,
    stepId: idSchema,
    captureId: idSchema,
})

export type ManualBinding = z.infer<typeof manualBindingSchema>
export type CaptureBinding = z.infer<typeof captureBindingSchema>

const bindingSchema = z.discriminatedUnion('kind', [manualBindingSchema, captureBindingSchema])

export const checkResultSchema = z
    .strictObject({
        ...modelProvenance,
        secondOpinion: secondOpinionSchema.optional(),
        followUps: checkFollowUpsSchema.optional(),
        /** Server-stamped: an isolated fixture runtime produced this without a model call (see `FIXTURE_EVIDENCE`). */
        evidence: fixtureEvidenceSchema.optional(),
        decision: z.enum(['pass', 'refuse', 'cannot_verify']),
        orientationAssessment: z.enum(['correct', 'reversed', 'uncertain']).optional(),
        reason: descriptionSchema,
        sourceRefs: sourceRefsSchema,
        observedRegion: normalizedBoxSchema.nullable(),
        missingEvidence: z.array(descriptionSchema).max(100),
        layout: layoutSchema.optional(),
        /** Where the real next part of the current step is in the observation photo. */
        nextPartRegion: partRegionSchema.optional(),
        /** Where `partId` is meant to go in the observation photo. */
        targetRegion: partRegionSchema.optional(),
    })
    .superRefine((result, ctx) => {
        // A fixture result observed no model call: nothing may claim one, and its offer needs no Spark identity.
        const fixture = result.evidence === FIXTURE_EVIDENCE
        if (fixture && (result.model !== undefined || result.telemetry !== undefined)) {
            ctx.addIssue({ code: 'custom', message: 'A synthetic fixture result claims no model or telemetry' })
        }
        if (
            result.secondOpinion?.status === 'available' &&
            (result.decision !== 'cannot_verify' || (result.model !== 'muse-spark-1.3' && !fixture))
        ) {
            ctx.addIssue({ code: 'custom', message: 'Only an uncertain Spark result can offer a second opinion' })
        }

        if (
            result.orientationAssessment === 'reversed' &&
            (result.decision !== 'refuse' || result.sourceRefs.length === 0)
        ) {
            ctx.addIssue({
                code: 'custom',
                message: 'Reversed orientation requires refusal and expected diagram citation',
            })
        }
        if (result.orientationAssessment === 'uncertain' && result.decision !== 'cannot_verify') {
            ctx.addIssue({ code: 'custom', message: 'Uncertain orientation cannot establish a decision' })
        }
        if (result.decision === 'refuse' && result.sourceRefs.length === 0) {
            ctx.addIssue({ code: 'custom', message: 'Refusal requires an expected diagram citation' })
        }
        if (result.decision === 'pass' && (result.sourceRefs.length === 0 || result.missingEvidence.length !== 0)) {
            ctx.addIssue({ code: 'custom', message: 'Pass requires source evidence without missing evidence' })
        }
    })

export type CheckResult = z.infer<typeof checkResultSchema>

export const questionTargetSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('point'), x: coordinateSchema, y: coordinateSchema }),
    z.strictObject({ kind: z.literal('part'), partId: idSchema }),
])
export const questionResultSchema = z.strictObject({
    ...modelProvenance,
    observedRegion: normalizedBoxSchema.nullable().optional(),
    answer: z.string().trim().min(1).max(2_000),
    sourceRefs: sourceRefsSchema,
    missingEvidence: z.array(descriptionSchema).max(100),
    layout: layoutSchema.optional(),
    nextPartRegion: partRegionSchema.optional(),
    targetRegion: partRegionSchema.optional(),
})

export type QuestionTarget = z.infer<typeof questionTargetSchema>
export type QuestionResult = z.infer<typeof questionResultSchema>

/** Longest accepted SVG path for one mask; a longer mask is omitted (the box remains), never truncated. */
export const MAX_MASK_PATH_CHARS = 12_000
export const trackMaskSchema = z.strictObject({
    /** The path lives on this width x height raster grid, which maps onto the record's `box` in the image. */
    width: positiveIntegerSchema.max(16_384),
    height: positiveIntegerSchema.max(16_384),
    /** SVG path data only: absolute/relative path commands and numbers. No markup, script, URL or other command text. */
    path: z
        .string()
        .min(1)
        .max(MAX_MASK_PATH_CHARS)
        .regex(/^[Mm][MmLlHhVvCcSsQqTtAaZz0-9eE+\-., \t\r\n]*$/u),
})
const trackRecordSchema = z.strictObject({
    objectId: idSchema,
    label: titleSchema,
    box: normalizedBoxSchema,
    /** Optional: older servers and the frozen demo omit it. Present only when a validated mask fits its bound. */
    mask: trackMaskSchema.optional(),
})

export type TrackRecord = z.infer<typeof trackRecordSchema>

export const trackSnapshotSchema = z
    .strictObject({
        binding: captureBindingSchema,
        streamId: idSchema,
        frameIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        capturedAt: z.iso.datetime(),
        records: z.array(trackRecordSchema).max(256),
        complete: z.boolean(),
        /** Server-observed stage facts; absent for the frozen demo and older servers. */
        stage: z.strictObject({ model: z.literal('sam-3.1'), elapsedMs: z.number().min(0) }).optional(),
    })
    .superRefine((snapshot, ctx) => {
        rejectDuplicates(
            snapshot.records.map((record) => record.objectId),
            'track object',
            ctx,
        )
    })

export type TrackSnapshot = z.infer<typeof trackSnapshotSchema>

export const segmentEventSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('snapshot'), snapshot: trackSnapshotSchema }),
    z.strictObject({ type: z.literal('completed') }),
    z.strictObject({ type: z.literal('unavailable'), code: z.enum(['timeout', 'provider_error', 'invalid_output']) }),
])

export type SegmentEvent = z.infer<typeof segmentEventSchema>

const unavailableCodeSchema = z.enum([
    'unconfigured',
    'unauthorized',
    'invalid_input',
    'timeout',
    'provider_error',
    'invalid_output',
    'budget_exhausted',
    'duplicate_request',
])

export type ApiResult<T> =
    | {
          status: 'ok'
          requestId: string
          mode: 'fixture' | 'model'
          binding: ManualBinding | CaptureBinding
          value: T
      }
    | {
          status: 'unavailable'
          requestId: string
          binding: ManualBinding | CaptureBinding | null
          code: z.infer<typeof unavailableCodeSchema>
          retryable: boolean
          message?: string
      }

export function apiResultSchema<T>(valueSchema: z.ZodType<T>): z.ZodType<ApiResult<T>> {
    return z.discriminatedUnion('status', [
        z.strictObject({
            status: z.literal('ok'),
            requestId: idSchema,
            mode: z.enum(['fixture', 'model']),
            binding: bindingSchema,
            value: valueSchema,
        }),
        z.strictObject({
            status: z.literal('unavailable'),
            requestId: idSchema,
            binding: bindingSchema.nullable(),
            code: unavailableCodeSchema,
            retryable: z.boolean(),
            message: descriptionSchema.optional(),
        }),
    ])
}

export function matchesBinding(a: ManualBinding | CaptureBinding, b: ManualBinding | CaptureBinding): boolean {
    if (a.kind !== b.kind || a.manualId !== b.manualId || a.revision !== b.revision) {
        return false
    }
    if (a.kind === 'capture' && b.kind === 'capture') {
        return a.stepId === b.stepId && a.captureId === b.captureId
    }

    return true
}

export function isCurrentResult<T>(result: ApiResult<T>, currentBinding: ManualBinding | CaptureBinding): boolean {
    return result.status === 'ok' && matchesBinding(result.binding, currentBinding)
}

export { createDemoManual } from './demo'
export * from './layout'
export * from './screen'
export * from './screen-context'
export * from './screen-facts'
export * from './telemetry'
export * from './document-v2'
export * from './document-v2-context'
export * from './document-v2-material'
export * from './document-v2-copy'
export * from './document-v2-action-copy'
export * from './document-v2-semantic'
export * from './document-v2-title'
export * from './document-v2-assemble'
export * from './document-v2-citations'
export * from './document-v2-fallback'
export * from './document-v2-recorded'
export * from './document-v2-rebind'
export * from './document-v2-verify'
export * from './document-v2-layout-template'
export * from './document-v2-layout-template-compile'
export * from './overlay-job-fixtures'
export * from './piece-spec'
export * from './piece-generation'
