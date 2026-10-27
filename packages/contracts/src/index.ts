import { z } from 'zod'

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

const manualPartSchema = z.strictObject({ partId: idSchema, name: factSchema(titleSchema) })
const partRequirementSchema = z.strictObject({ partId: idSchema, quantity: factSchema(positiveIntegerSchema) })
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

export type ManualPart = z.infer<typeof manualPartSchema>
export type PartRequirement = z.infer<typeof partRequirementSchema>
export type VisibleCheck = z.infer<typeof visibleCheckSchema>
export type CorrectionAction = z.infer<typeof correctionActionSchema>
export type CorrectionPlan = z.infer<typeof correctionPlanSchema>

export const manualStepSchema = z
    .strictObject({
        stepId: idSchema,
        order: positiveIntegerSchema,
        title: titleSchema,
        parts: z.array(partRequirementSchema).max(256),
        orientation: factSchema(orientationSchema),
        connection: factSchema(connectionSchema),
        visibleChecks: z.array(visibleCheckSchema).max(100),
        sourceRefs: sourceRefsSchema,
        correction: correctionPlanSchema.nullable(),
    })
    .superRefine((step, ctx) => {
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

export const parsedManualSchema = z
    .strictObject({
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
            ...step.parts.flatMap((part) => factRefs(part.quantity)),
            ...factRefs(step.orientation),
            ...factRefs(step.connection),
            ...step.visibleChecks.flatMap((check) => factRefs(check.description)),
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
                session.reviewedSteps.some(
                    (step) =>
                        step.sourceRefs.length === 0 ||
                        step.parts.length === 0 ||
                        step.parts.some((part) => part.quantity.state === 'unknown') ||
                        step.orientation.state === 'unknown' ||
                        step.connection.state === 'unknown' ||
                        step.visibleChecks.length === 0 ||
                        step.visibleChecks.some((check) => check.description.state === 'unknown') ||
                        (step.correction !== null && !step.correction.reviewed),
                )
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
        decision: z.enum(['pass', 'refuse', 'cannot_verify']),
        orientationAssessment: z.enum(['correct', 'reversed', 'uncertain']).optional(),
        reason: descriptionSchema,
        sourceRefs: sourceRefsSchema,
        observedRegion: normalizedBoxSchema.nullable(),
        missingEvidence: z.array(descriptionSchema).max(100),
    })
    .superRefine((result, ctx) => {
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
    observedRegion: normalizedBoxSchema.nullable().optional(),
    answer: z.string().trim().min(1).max(2_000),
    sourceRefs: sourceRefsSchema,
    missingEvidence: z.array(descriptionSchema).max(100),
})

export type QuestionTarget = z.infer<typeof questionTargetSchema>
export type QuestionResult = z.infer<typeof questionResultSchema>

const trackRecordSchema = z.strictObject({ objectId: idSchema, label: titleSchema, box: normalizedBoxSchema })

export type TrackRecord = z.infer<typeof trackRecordSchema>

export const trackSnapshotSchema = z
    .strictObject({
        binding: captureBindingSchema,
        streamId: idSchema,
        frameIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        capturedAt: z.iso.datetime(),
        records: z.array(trackRecordSchema).max(256),
        complete: z.boolean(),
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
