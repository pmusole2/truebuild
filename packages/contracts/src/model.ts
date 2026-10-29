import {
    aiEffortSchema,
    callTelemetrySchema,
    captureBindingSchema,
    carriedQuantitySourceRefs,
    checkResultSchema,
    fixtureEvidenceSchema,
    layoutSchema,
    normalizedBoxSchema,
    partRegionSchema,
    questionResultSchema,
    screenKindSchema,
    screenUiStateSchema,
    SCREEN_FAILURES,
    standardModelSchema,
    hasValidQuantityEvidence,
    LIMITS,
    manualBindingSchema,
    manualSessionSchema,
    questionTargetSchema,
    stepEvidenceRequirements,
    type Fact,
    type ManualStep,
    type ManualSession,
    type ScreenContextInputs,
    type SourceRef,
} from '@truebuild/contracts'
import { z } from 'zod'

export const MAX_PARSE_PAGES = 8
export const PARSE_SPLIT_MESSAGE = 'Read up to 8 pages at a time. Split this manual into sections of 8 pages or fewer.'
export const parseLanguageSchema = z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
    .max(16)

// Shared client/server multipart metadata ceiling; independent of the aggregate image budget.
export const MODEL_METADATA_MAX_BYTES = 524_288

const requestId = z.string().trim().min(1).max(128)
const imageMetadata = z
    .strictObject({
        mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        width: z.number().int().positive().max(LIMITS.imagePixels),
        height: z.number().int().positive().max(LIMITS.imagePixels),
    })
    .refine((image): boolean => image.width * image.height <= LIMITS.imagePixels)
const common = { mode: z.literal('model'), requestId }

export const modelParseMetadataSchema = z
    .strictObject({
        ...common,
        binding: manualBindingSchema,
        pages: z.array(manualSessionSchema.shape.pages.element).min(1).max(LIMITS.manualPages),
        language: parseLanguageSchema.optional(),
    })
    .superRefine((value, ctx): void => {
        if (
            new Set(value.pages.map((page) => page.pageId)).size !== value.pages.length ||
            new Set(value.pages.map((page) => page.assetId)).size !== value.pages.length
        ) {
            ctx.addIssue({ code: 'custom', message: 'Duplicate source identity' })
        }
    })

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
/**
 * Optional identity of the generated step screen the person is looking at. The server recomputes the expected
 * context key from the supplied session and step itself and rejects a mismatch; it never trusts any text the client
 * could attach, only the facts it resolves from the validated manual. Absent keeps the previous behavior.
 */
export const screenContextSchema = z.strictObject({ screenId: sha256, contextKey: sha256 })
export type ScreenContext = z.infer<typeof screenContextSchema>

const checkFields = {
    ...common,
    binding: captureBindingSchema,
    session: manualSessionSchema,
    sourcePageIds: z.array(requestId).min(1).max(LIMITS.manualPages),
    observation: imageMetadata,
    screen: screenContextSchema.optional(),
}
const baseCheck = z.strictObject(checkFields)
type CheckContext = z.infer<typeof baseCheck>

function refs<T>(fact: Fact<T>): SourceRef[] {
    return fact.state === 'known' ? fact.sourceRefs : []
}

function usedParts(step: ManualStep): Set<string> {
    return new Set([
        ...step.parts.map((part) => part.partId),
        ...(step.orientation.state === 'known' ? [step.orientation.value.partId] : []),
        ...(step.connection.state === 'known' ? step.connection.value.partIds : []),
    ])
}

function checkCitations(step: ManualStep, session: ManualSession): SourceRef[] {
    const parts = usedParts(step)
    return [
        ...step.sourceRefs,
        ...carriedQuantitySourceRefs(step, session.reviewedSteps),
        ...step.parts.flatMap((part) => [...refs(part.quantity), ...(part.quantityBasis?.sourceRefs ?? [])]),
        ...(step.alternatives?.flatMap((alternative) => alternative.sourceRefs) ?? []),
        ...refs(step.orientation),
        ...refs(step.connection),
        ...step.visibleChecks.flatMap((check) => refs(check.description)),
        ...(step.safetyNotes ?? []).flatMap((note) => refs(note.note)),
        ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
        ...session.parts.filter((part) => parts.has(part.partId)).flatMap((part) => refs(part.name)),
    ]
}

/** Default full-manual context in manual order; unresolved current-step evidence fails closed. */
export function selectStepSourcePageIds(session: ManualSession, stepId: string): string[] | null {
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
    if (
        !step ||
        session.reviewStatus !== 'reviewed' ||
        step.parts.some((part) => !hasValidQuantityEvidence(step, part, session.reviewedSteps))
    ) {
        return null
    }
    const pages = session.pages.map((page) => page.pageId)
    const ids = new Set(pages)
    if (
        pages.length === 0 ||
        pages.length > LIMITS.manualPages ||
        ids.size !== pages.length ||
        checkCitations(step, session).some((ref) => !ids.has(ref.pageId))
    )
        return null
    return pages
}

/** Explicit compact fallback only. Never drop a cited fact to fit the two-page limit. */
export function selectCompactStepSourcePageIds(session: ManualSession, stepId: string): string[] | null {
    const pages = selectStepSourcePageIds(session, stepId)
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
    if (!pages || !step) return null
    const required = new Set(checkCitations(step, session).map((ref) => ref.pageId))
    const selected = pages.filter((id) => required.has(id))
    return selected.length > 0 && selected.length <= 2 ? selected : null
}

/** Factual unknowns that block a reviewed manual. Human correction review state is intentionally not a factual unknown. */
export function unresolvedCriticalFacts(session: Pick<ManualSession, 'parts' | 'reviewedSteps'>): string[] {
    const issues: string[] = []
    for (const part of session.parts) {
        if (part.name.state === 'unknown') {
            issues.push(`Part ${part.partId} name: ${part.name.reason}`)
        }
    }
    if (session.reviewedSteps.length === 0) {
        issues.push('No assembly steps could be read.')
    }
    for (const step of session.reviewedSteps) {
        const label = `Step ${step.order}`
        const required = stepEvidenceRequirements(step)
        if (step.sourceRefs.length === 0) {
            issues.push(`${label}: expected diagram citation is missing.`)
        }
        if (required.parts && step.parts.length === 0) {
            issues.push(`${label}: required parts are missing.`)
        }
        for (const part of step.parts) {
            if (!hasValidQuantityEvidence(step, part, session.reviewedSteps)) {
                const reason = part.quantity.state === 'unknown' ? part.quantity.reason : 'Invalid quantity evidence.'
                issues.push(`${label}, quantity of ${part.partId}: ${reason}`)
            }
        }
        if (required.orientation && step.orientation.state === 'unknown') {
            issues.push(`${label} orientation: ${step.orientation.reason}`)
        }
        if (required.connection && step.connection.state === 'unknown') {
            issues.push(`${label} connection: ${step.connection.reason}`)
        }
        if (required.visibleChecks && step.visibleChecks.length === 0) {
            issues.push(`${label}: visible checks are missing.`)
        }
        for (const check of step.visibleChecks) {
            if (check.description.state === 'unknown') {
                issues.push(`${label}, visible check ${check.checkId}: ${check.description.reason}`)
            }
        }
        // An unreadable safety note is never dropped or invented: it stays unresolved until a clearer page is read.
        for (const note of step.safetyNotes ?? []) {
            if (note.note.state === 'unknown') {
                issues.push(`${label}, safety note ${note.noteId}: ${note.note.reason}`)
            }
        }
    }
    return issues
}

function validateCheck(value: CheckContext, ctx: z.RefinementCtx): void {
    const { binding, session, sourcePageIds } = value
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === binding.stepId)
    if (
        session.reviewStatus !== 'reviewed' ||
        session.manualId !== binding.manualId ||
        session.revision !== binding.revision ||
        !step
    ) {
        ctx.addIssue({ code: 'custom', message: 'Current reviewed step required' })
        return
    }
    const pages = new Set(sourcePageIds)
    if (
        pages.size !== sourcePageIds.length ||
        sourcePageIds.some((id) => !session.pages.some((page) => page.pageId === id))
    ) {
        ctx.addIssue({ code: 'custom', message: 'Invalid selected sources' })
    }
    const citations = checkCitations(step, session)
    if (citations.some((citation) => !pages.has(citation.pageId))) {
        ctx.addIssue({ code: 'custom', message: 'Selected pages must cover every current-step citation' })
    }
}

export const modelCheckMetadataSchema = baseCheck.superRefine(validateCheck)
export const modelSecondOpinionMetadataSchema = z
    .strictObject({ ...checkFields, secondOpinionToken: z.string().min(1).max(128) })
    .superRefine(validateCheck)
export const modelQuestionMetadataSchema = z
    .strictObject({
        ...checkFields,
        question: z.string().trim().min(1).max(500),
        target: questionTargetSchema,
    })
    .superRefine((value, ctx): void => {
        validateCheck(value, ctx)
        const step = value.session.reviewedSteps.find((candidate) => candidate.stepId === value.binding.stepId)
        if (value.target.kind === 'part' && (!step || !usedParts(step).has(value.target.partId))) {
            ctx.addIssue({ code: 'custom', message: 'Question target must belong to the current step' })
        }
    })

export const modelSegmentMetadataSchema = z.strictObject({
    ...common,
    binding: captureBindingSchema,
    capturedAt: z.iso.datetime(),
    prompt: z
        .string()
        .refine((text): boolean => !/[\r\n]/u.test(text))
        .trim()
        .min(1)
        .max(100)
        .refine(
            (text): boolean =>
                /^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(text) &&
                !/\b(and|or|not|without)\b/iu.test(text) &&
                !/^(find|segment|show|locate|identify|detect|ignore|explain|describe|where|which|what|please|is|are|do|does|can|could|should|would|will|why|how|when|who|count|tell|compare|check|verify|inspect|look|return|output|give|answer)\b/iu.test(
                    text,
                ),
        ),
    media: z.discriminatedUnion('kind', [
        z
            .strictObject({ kind: z.literal('image'), ...imageMetadata.shape })
            .refine((image): boolean => image.width * image.height <= LIMITS.imagePixels),
        z.strictObject({ kind: z.literal('clip'), mimeType: z.enum(['video/mp4', 'video/quicktime']) }),
    ]),
})

export type ModelParseMetadata = z.infer<typeof modelParseMetadataSchema>
export type ModelSecondOpinionMetadata = z.infer<typeof modelSecondOpinionMetadataSchema>
export type ModelCheckMetadata = z.infer<typeof modelCheckMetadataSchema>
export type ModelQuestionMetadata = z.infer<typeof modelQuestionMetadataSchema>
export type ModelSegmentMetadata = z.infer<typeof modelSegmentMetadataSchema>

export const modelOverlayMetadataSchema = z
    .strictObject({ ...checkFields, overlayToken: z.string().min(1).max(128) })
    .superRefine(validateCheck)
export type ModelOverlayMetadata = z.infer<typeof modelOverlayMetadataSchema>

/**
 * Presentation-only addition for one published verdict. It has no decision field, so it cannot change one. A region
 * survives only for a real part of the bound step and only inside the image; absence stays absent.
 */
export const overlayResultSchema = z
    .strictObject({
        /** Required for a live overlay; absent from a fixture overlay, which ran no model. */
        model: standardModelSchema.optional(),
        effort: aiEffortSchema.optional(),
        /** Server-stamped: an isolated fixture runtime produced this without a model call (see `FIXTURE_EVIDENCE`). */
        evidence: fixtureEvidenceSchema.optional(),
        observedRegion: normalizedBoxSchema.nullable(),
        nextPartRegion: partRegionSchema.optional(),
        targetRegion: partRegionSchema.optional(),
        layout: layoutSchema.optional(),
        /** Server-observed facts about the overlay call. Absent when none is attributable; null values are unknown. */
        telemetry: callTelemetrySchema.optional(),
    })
    .superRefine((value, ctx): void => {
        if (value.evidence === undefined) {
            if (value.model === undefined || value.effort === undefined) {
                ctx.addIssue({ code: 'custom', message: 'A live overlay names its model and effort' })
            }
        } else if (value.model !== undefined || value.effort !== undefined || value.telemetry !== undefined) {
            ctx.addIssue({
                code: 'custom',
                message: 'A synthetic fixture overlay claims no model, effort or telemetry',
            })
        }
    })
export type OverlayResult = z.infer<typeof overlayResultSchema>

/** Slow-question job handle. 202 means "still working": poll with the ticket; never resend the question. */
export const QUESTION_JOB_ACTIONS = ['result', 'cancel'] as const
export const modelQuestionJobMetadataSchema = z.strictObject({
    ...common,
    binding: captureBindingSchema,
    ticket: z.string().trim().min(1).max(128),
})
export type ModelQuestionJobMetadata = z.infer<typeof modelQuestionJobMetadataSchema>
export const pendingResultSchema = z.strictObject({
    status: z.literal('pending'),
    requestId,
    binding: captureBindingSchema,
    ticket: z.string().min(1).max(128),
    retryAfterMs: z.number().int().positive(),
    /** Server-side horizon: after this the job is cancelled and reported as a timeout, never a 504 mid-request. */
    expiresInMs: z.number().int().positive(),
})
export type PendingResult = z.infer<typeof pendingResultSchema>

const checkOrQuestion = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('check'), value: checkResultSchema }),
    z.strictObject({
        kind: z.literal('question'),
        question: z.string().trim().min(1).max(500),
        value: questionResultSchema,
    }),
])

const SESSIONLESS_SCREENS = new Set<string>(['home', 'add', 'pages', 'more', 'error'])
const STEP_SCREENS = new Set<string>(['guide', 'result', 'questions', 'answer', 'recovery'])

/**
 * `/api/screens` input: the current ManualSession/revision/step and optionally the current result, product-agnostic.
 * Zero image files. Home, add, pages, more and error work before any manual exists (`session: null`).
 */
export const modelScreensMetadataSchema = z
    .strictObject({
        ...common,
        op: z.enum(['generate', 'precompute', 'progress', 'cancel']),
        kind: screenKindSchema.nullable(),
        binding: manualBindingSchema.nullable(),
        session: manualSessionSchema.nullable(),
        stepId: z.string().trim().min(1).max(128).nullable(),
        captureId: z.string().trim().min(1).max(128).nullable(),
        result: checkOrQuestion.nullable(),
        /** Closed failure class for error/recovery composition. Never a message, stack or provider text. */
        failure: z.enum(SCREEN_FAILURES).nullable(),
        /** progress/precompute: step to generate or return first, and finished documents to include. */
        focusStepId: z.string().trim().min(1).max(128).nullable(),
        want: z.array(z.string().trim().min(1).max(128)).max(8),
        /**
         * Completion screen only: step ids the app has saved as completed. The server states that the build is
         * finished only if this contains every reviewed step of the supplied session; absent or partial keeps the
         * completion document neutral. It is a witness for wording, not authority: the native guard owns completion.
         */
        completedStepIds: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
        /**
         * Optional live app state a composition may bind to (library summaries, the current review question, pages,
         * the held capture, available sections). Presence flags and ids only; never raw drafts, photos or tickets.
         */
        uiState: screenUiStateSchema.nullable().optional(),
    })
    .superRefine((value, ctx): void => {
        const issue = (message: string): void => {
            ctx.addIssue({ code: 'custom', message })
        }
        const { session, binding } = value
        if (
            session !== null &&
            (binding === null || binding.manualId !== session.manualId || binding.revision !== session.revision)
        ) {
            issue('Binding must name the supplied session revision')
        }
        if (value.op === 'progress' || value.op === 'cancel') {
            if (binding === null) issue('Binding required')
            return
        }
        if (value.op === 'precompute') {
            // A reviewed session, or a fresh parse whose known raw steps are prepared before Quick check confirms them.
            if (
                session === null ||
                (session.reviewStatus !== 'reviewed' && (session.rawExtraction?.steps.length ?? 0) === 0)
            ) {
                issue('Session with steps required')
            }
            return
        }
        const kind = value.kind
        if (kind === null) {
            issue('Screen kind required')
            return
        }
        if (!SESSIONLESS_SCREENS.has(kind) && session === null) issue('Session required')
        const step = value.stepId === null ? undefined : session?.reviewedSteps.find((s) => s.stepId === value.stepId)
        if (STEP_SCREENS.has(kind) && (session?.reviewStatus !== 'reviewed' || step === undefined)) {
            issue('Current reviewed step required')
        }
        if (!STEP_SCREENS.has(kind) && value.stepId !== null) issue('This screen is not step-bound')
        if (kind === 'completion' && session?.reviewStatus !== 'reviewed') issue('Reviewed session required')
        if (value.completedStepIds !== undefined && kind !== 'completion')
            issue('Only completion takes completed steps')
        const needsResult = kind === 'result' || kind === 'answer'
        if (needsResult && (value.result === null || value.captureId === null)) issue('Current result required')
        if (!needsResult && kind !== 'recovery' && kind !== 'questions' && value.result !== null) {
            issue('This screen takes no result')
        }
        if (kind === 'result' && value.result?.kind !== 'check' && value.result !== null) issue('Check result required')
        if (kind === 'answer' && value.result?.kind !== 'question' && value.result !== null) {
            issue('Question result required')
        }
        if (value.result !== null && value.captureId === null) issue('Result requires its capture identity')
        if (kind === 'error' && value.failure === null) issue('Failure class required')
    })
export type ModelScreensMetadata = z.infer<typeof modelScreensMetadataSchema>

/**
 * The generate request for one screen, built from the same inputs the context key is computed from
 * (`screenContextJson`), so the request and the key cannot drift. A one-use follow-up token inside a result is not
 * part of the key and should be removed by the caller before sending.
 */
export function screensGenerateRequest(requestId: string, inputs: ScreenContextInputs): ModelScreensMetadata {
    const { session } = inputs
    return {
        mode: 'model',
        requestId,
        op: 'generate',
        kind: inputs.kind,
        binding: session === null ? null : { kind: 'manual', manualId: session.manualId, revision: session.revision },
        session,
        stepId: inputs.stepId,
        captureId: inputs.captureId,
        result: inputs.result,
        failure: inputs.failure,
        focusStepId: null,
        want: [],
        ...(inputs.completedStepIds === undefined ? {} : { completedStepIds: [...inputs.completedStepIds] }),
        ...(inputs.uiState === undefined ? {} : { uiState: inputs.uiState }),
    }
}
