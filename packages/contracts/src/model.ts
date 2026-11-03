import {
    aiEffortSchema,
    apiResultSchema,
    callTelemetrySchema,
    captureBindingSchema,
    carriedQuantitySourceRefs,
    checkResultSchema,
    fixtureEvidenceSchema,
    layoutSchema,
    normalizedBoxSchema,
    screenDocumentV2Schema,
    screenKindV2Schema,
    screenContextJsonV2,
    screenManualJsonV2,
    screenUiStateV2Schema,
    screenStateSchema,
    STEP_PIECES_MAX_V2,
    stepPiecesUsedV2,
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
    type ScreenContextInputsV2,
    type SourceRef,
} from '@truebuild/contracts'
import { z } from 'zod'

import { pieceIdSchema, piecesSpecSchema } from './piece-spec'

export const MAX_PARSE_PAGES = 8
export const PARSE_SPLIT_MESSAGE = 'Read up to 8 pages at a time. Split this manual into sections of 8 pages or fewer.'
export { parseLanguageSchema } from './reading-language'
import { parseLanguageSchema } from './reading-language'

// Shared client/server multipart metadata ceiling; independent of the aggregate image budget.
// The measured valid 100-note/100-reference manual needs ~830 KB before multipart framing.
export const MODEL_METADATA_MAX_BYTES = 1_048_576

/** Non-parse routes have an absolute ceiling, including one screen repair; parse has its own longer budget. */
export const MODEL_ROUTE_TIMEOUT_MAX_MS = 105_000
/** Let the server return its bounded generation/repair outcome before the client stops the request. */
export const MODEL_STEP_PAGE_TIMEOUT_MS = MODEL_ROUTE_TIMEOUT_MAX_MS + 5_000

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

// ---------------------------------------------------------------------------------------------------------------------
// Overlay job: the same custody as a slow question. 200 = answered or terminal, 202 = still working (collect by ticket).
// ---------------------------------------------------------------------------------------------------------------------

export const OVERLAY_JOB_PATHS = {
    result: '/api/checks/overlay/result',
    cancel: '/api/checks/overlay/cancel',
} as const
/** JSON body `{mode, requestId, binding, ticket}` of the ORIGINAL overlay request (collect/cancel). Never resend the photo. */
export const modelOverlayJobMetadataSchema = modelQuestionJobMetadataSchema
export type ModelOverlayJobMetadata = ModelQuestionJobMetadata
/** 202 body of `POST /api/checks/overlay` and of `/result` while the job runs. Same shape as the question handle. */
export const overlayPendingSchema = pendingResultSchema
export type OverlayPending = PendingResult

/**
 * Everything `POST /api/checks/overlay` and `/api/checks/overlay/result` can answer: 200 with a published overlay, 200
 * `unavailable` (a timeout or failure is collected here, never a 504, and never affects the verdict), or 202 pending.
 * `/cancel` answers 204. A repeated original request is `unavailable` / `duplicate_request` before any dispatch.
 */
export const overlayResponseSchema = z.union([apiResultSchema(overlayResultSchema), overlayPendingSchema])
export type OverlayResponse = z.infer<typeof overlayResponseSchema>

// ---------------------------------------------------------------------------------------------------------------------
// POST /api/screens/v2
// ---------------------------------------------------------------------------------------------------------------------

const SESSIONLESS_SCREENS_V2 = new Set<string>(['home', 'add', 'pages', 'more', 'error', 'judge', 'compare'])
const STEP_SCREENS_V2 = new Set<string>(['guide', 'result', 'questions', 'answer', 'recovery'])

/**
 * The answer a person got about the photo of a retained check, held beside that check by a step-scoped More (see
 * `CompanionAnswerV2`). The question is the person's own words (they were already sent with the question itself).
 */
export const companionAnswerV2Schema = z.strictObject({
    question: z.string().trim().min(1).max(500),
    value: questionResultSchema,
})

/**
 * A guide's closed piece catalog (see `StepPieceV2`): at most `STEP_PIECES_MAX_V2` distinct valid registry ids, each with a
 * positive safe-integer quantity or null (not known). The app supplies ids and quantities; nothing is inferred.
 */
export const stepPiecesV2Schema = z
    .array(
        z.strictObject({
            pieceId: pieceIdSchema,
            quantity: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
        }),
    )
    .max(STEP_PIECES_MAX_V2)
    .refine((pieces) => new Set(pieces.map((piece) => piece.pieceId)).size === pieces.length, {
        message: 'Step piece ids are unique',
    })

/** The screens a precompute can prepare, by kind (a guide is one per step). The default is all of them. */
export const PRECOMPUTE_KINDS_V2 = ['reading', 'guide', 'completion', 'judge', 'compare', 'home'] as const
export type PrecomputeKindV2 = (typeof PRECOMPUTE_KINDS_V2)[number]

/**
 * `/api/screens/v2` input: zero-file multipart, explicit version 2. Bound to the full state: `manualHash` is the
 * SHA-256 of `screenManualJsonV2(session)` and `contextKey` (generate) is the SHA-256 of `screenContextJsonV2(inputs)`;
 * the server recomputes both and refuses a mismatch as `invalid_input`.
 */
export const modelScreensV2MetadataSchema = z
    .strictObject({
        ...common,
        op: z.enum(['generate', 'precompute', 'progress', 'cancel']),
        kind: screenKindV2Schema.nullable(),
        binding: manualBindingSchema.nullable(),
        session: manualSessionSchema.nullable(),
        manualHash: sha256.nullable(),
        stepId: z.string().trim().min(1).max(128).nullable(),
        captureId: z.string().trim().min(1).max(128).nullable(),
        result: checkOrQuestion.nullable(),
        failure: z.enum(SCREEN_FAILURES).nullable(),
        /** generate: the context key the client computed. precompute/progress/cancel: null. */
        contextKey: sha256.nullable(),
        /** precompute/progress: the item to prepare or return first (`guide:<stepId>`, `home`, ...) and keys to include. */
        focusKey: z.string().trim().min(1).max(160).nullable(),
        want: z.array(z.string().trim().min(1).max(160)).max(8),
        completedStepIds: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
        uiState: screenUiStateV2Schema.nullable().optional(),
        /** More only: the answer held beside a retained check on the same held photo (absent/null: none). */
        companionAnswer: companionAnswerV2Schema.nullable().optional(),
        /**
         * generate only: the app's piece registry (absent/null: none). It grounds native piece nodes; the model never
         * generates geometry, it only names ids the registry supplies.
         */
        pieces: piecesSpecSchema.nullable().optional(),
        /** generate only, guide only: the step's closed piece catalog (absent/null/empty: none known). Ids and quantities. */
        stepPieces: stepPiecesV2Schema.nullable().optional(),
        /**
         * precompute/progress/cancel: the kinds the job prepares (a finite allowlist; absent = the existing full set). A
         * client that wants only the guides of unreviewed steps sends `['guide']` on the whole job. Only precompute acts
         * on it; the other two name the same job. The server's generative-UI mode still bounds what is prepared.
         */
        requestedKinds: z.array(z.enum(PRECOMPUTE_KINDS_V2)).min(1).max(PRECOMPUTE_KINDS_V2.length).optional(),
    })
    .superRefine((value, ctx): void => {
        const issue = (message: string): void => {
            ctx.addIssue({ code: 'custom', message })
        }
        if (value.pieces != null && value.op !== 'generate')
            issue('A piece registry is sent with a generate request only')
        if (value.stepPieces != null && (value.op !== 'generate' || value.kind !== 'guide'))
            issue('A step piece catalog is sent with a guide generate request only')
        if (value.requestedKinds !== undefined) {
            if (value.op === 'generate') issue('A single screen takes no requested kinds')
            if (new Set(value.requestedKinds).size !== value.requestedKinds.length) issue('Requested kinds are unique')
        }
        const { session, binding } = value
        if (
            session !== null &&
            (binding === null || binding.manualId !== session.manualId || binding.revision !== session.revision)
        ) {
            issue('Binding must name the supplied session revision')
        }
        if ((session === null) !== (value.manualHash === null)) issue('A session is sent with its manual hash')
        if (value.op === 'progress' || value.op === 'cancel') {
            if (binding === null) issue('Binding required')
            if (session === null) issue('Job context requires its session')
            return
        }
        if (value.op === 'precompute') {
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
        if (value.contextKey === null) issue('Context key required')
        const camera = value.uiState?.camera ?? null
        if (kind === 'camera' && camera === null) issue('Camera state required')
        // A More is global (no manual, step, photo or result) or about one reviewed step and what the person holds of it.
        const more = kind === 'more'
        const stepBound =
            STEP_SCREENS_V2.has(kind) ||
            (kind === 'camera' && camera?.mode === 'build-photo') ||
            (more && value.stepId !== null)
        if (!SESSIONLESS_SCREENS_V2.has(kind) && !(kind === 'camera' && !stepBound) && session === null) {
            issue('Session required')
        }
        const step = value.stepId === null ? undefined : session?.reviewedSteps.find((s) => s.stepId === value.stepId)
        if (stepBound && (session?.reviewStatus !== 'reviewed' || step === undefined)) {
            issue('Current reviewed step required')
        }
        if (!stepBound && value.stepId !== null) issue('This screen is not step-bound')
        if (kind === 'completion' && session?.reviewStatus !== 'reviewed') issue('Reviewed session required')
        if (value.completedStepIds !== undefined && kind !== 'completion')
            issue('Only completion takes completed steps')
        const needsResult = kind === 'result' || kind === 'answer'
        if (needsResult && (value.result === null || value.captureId === null)) issue('Current result required')
        if (!needsResult && kind !== 'recovery' && kind !== 'questions' && !more && value.result !== null) {
            issue('This screen takes no result')
        }
        if (kind === 'result' && value.result?.kind !== 'check' && value.result !== null) issue('Check result required')
        if (kind === 'answer' && value.result?.kind !== 'question' && value.result !== null) {
            issue('Question result required')
        }
        if (value.result !== null && value.captureId === null) issue('Result requires its capture identity')
        if (kind === 'error' && value.failure === null) issue('Failure class required')
        if (more) {
            if (session !== null && value.stepId === null) issue('More with a manual names its reviewed step')
            if (value.stepId === null && (value.captureId !== null || value.result !== null)) {
                issue('A More without a step holds no photo or result')
            }
            if (
                value.captureId !== null &&
                value.result === null &&
                value.uiState?.capture?.captureId !== value.captureId
            ) {
                issue('A held photo without a result is the photo the app holds')
            }
        }
        if (value.companionAnswer != null && !(more && value.result?.kind === 'check' && value.captureId !== null)) {
            issue('A companion answer needs a retained check and its photo on More')
        }
        // Everything a held result cites is a page of this manual: nothing is shown for a source that does not exist.
        const pageIds = new Set(session?.pages.map((page) => page.pageId) ?? [])
        const cited = [...(value.result?.value.sourceRefs ?? []), ...(value.companionAnswer?.value.sourceRefs ?? [])]
        if (more && cited.some((ref) => !pageIds.has(ref.pageId))) {
            issue('Result cites a page this manual does not have')
        }
    })
export type ModelScreensV2Metadata = z.infer<typeof modelScreensV2MetadataSchema>

/** `generate` request built from the same inputs the context key is computed from. `sha256` is the app's own SHA-256 (hex). */
export function screensV2GenerateRequest(
    requestId: string,
    inputs: ScreenContextInputsV2,
    sha256Hex: (text: string) => string,
): ModelScreensV2Metadata {
    const { session } = inputs
    const stepPieces = stepPiecesUsedV2(inputs)
    return {
        mode: 'model',
        requestId,
        op: 'generate',
        kind: inputs.kind,
        binding: session === null ? null : { kind: 'manual', manualId: session.manualId, revision: session.revision },
        session,
        manualHash: session === null ? null : sha256Hex(screenManualJsonV2(session)),
        stepId: inputs.stepId,
        captureId: inputs.captureId,
        result: inputs.result,
        failure: inputs.failure,
        contextKey: sha256Hex(screenContextJsonV2(inputs)),
        focusKey: null,
        want: [],
        ...(inputs.completedStepIds === undefined ? {} : { completedStepIds: [...inputs.completedStepIds] }),
        ...(inputs.uiState === undefined ? {} : { uiState: inputs.uiState }),
        ...(inputs.companionAnswer == null ? {} : { companionAnswer: inputs.companionAnswer }),
        ...(inputs.pieces == null ? {} : { pieces: [...inputs.pieces] }),
        ...(stepPieces === null ? {} : { stepPieces: [...stepPieces] }),
    }
}

/** Items a precompute prepares, keyed: `home`, `reading`, `guide:<stepId>`, `completion`, `judge`, `compare`. */
export const screenProgressItemV2Schema = z.strictObject({
    key: z.string().trim().min(1).max(160),
    kind: screenKindV2Schema,
    stepId: z.string().trim().min(1).max(128).nullable(),
    state: screenStateSchema,
    screenId: sha256.nullable(),
})
export const screenProgressV2Schema = z.strictObject({
    manualId: requestId,
    revision: z.number().int().positive(),
    contextKey: sha256,
    mode: z.enum(['full', 'steps', 'off']),
    items: z.array(screenProgressItemV2Schema).max(240),
})
export type ScreenProgressV2 = z.infer<typeof screenProgressV2Schema>

export const screensV2ResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('ok'),
        requestId,
        mode: z.enum(['fixture', 'model']),
        value: z.strictObject({
            document: screenDocumentV2Schema.nullable(),
            progress: screenProgressV2Schema.nullable(),
            /** Documents the client asked for in `want`; each carries its own `bound` identity. */
            documents: z.array(screenDocumentV2Schema).max(8),
        }),
    }),
    z.strictObject({
        status: z.literal('unavailable'),
        requestId,
        binding: z.null(),
        code: z.enum([
            'unconfigured',
            'unauthorized',
            'invalid_input',
            'timeout',
            'provider_error',
            'invalid_output',
            'budget_exhausted',
            'duplicate_request',
        ]),
        retryable: z.boolean(),
    }),
])
export type ScreensV2Result = z.infer<typeof screensV2ResultSchema>
