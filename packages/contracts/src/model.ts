import {
    captureBindingSchema,
    LIMITS,
    manualBindingSchema,
    manualSessionSchema,
    questionTargetSchema,
    type Fact,
    type ManualStep,
    type ManualSession,
    type SourceRef,
} from '@truebuild/contracts'
import { z } from 'zod'

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
    })
    .superRefine((value, ctx): void => {
        if (
            new Set(value.pages.map((page) => page.pageId)).size !== value.pages.length ||
            new Set(value.pages.map((page) => page.assetId)).size !== value.pages.length
        ) {
            ctx.addIssue({ code: 'custom', message: 'Duplicate source identity' })
        }
    })

const checkFields = {
    ...common,
    binding: captureBindingSchema,
    session: manualSessionSchema,
    sourcePageIds: z.array(requestId).min(1).max(LIMITS.manualPages),
    observation: imageMetadata,
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
        ...step.parts.flatMap((part) => refs(part.quantity)),
        ...refs(step.orientation),
        ...refs(step.connection),
        ...step.visibleChecks.flatMap((check) => refs(check.description)),
        ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
        ...session.parts.filter((part) => parts.has(part.partId)).flatMap((part) => refs(part.name)),
    ]
}

/** Default full-manual context in manual order; unresolved current-step evidence fails closed. */
export function selectStepSourcePageIds(session: ManualSession, stepId: string): string[] | null {
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
    if (!step || session.reviewStatus !== 'reviewed') return null
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
export type ModelCheckMetadata = z.infer<typeof modelCheckMetadataSchema>
export type ModelQuestionMetadata = z.infer<typeof modelQuestionMetadataSchema>
export type ModelSegmentMetadata = z.infer<typeof modelSegmentMetadataSchema>
