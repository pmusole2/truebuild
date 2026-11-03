import {
    canonicalJson,
    paddedStepFigureBox,
    STEP_MOTION_PROMPT_VERSION,
    stepMotionRequestSchema,
    stepMotionResultSchema,
    type ManualSession,
    type ManualStep,
    type StepMotionRequest,
    type StepMotionScene,
} from '@truebuild/contracts'
import type { KeyValueStorage } from '../capture/library'
import type { StepMotionAttempt } from '../../api/model-client'
import { sha256Hex } from '../documents/sha256'

type Generate = (
    request: StepMotionRequest,
    pageUris: Readonly<Record<string, string>>,
) => Promise<StepMotionAttempt | null>

export function stepMotionCacheKey(request: StepMotionRequest, version = STEP_MOTION_PROMPT_VERSION): string {
    return `truebuild/step-motion/${sha256Hex(canonicalJson([request.manualHash, request.stepId, request.readingLanguage, version]))}`
}

/** A review action is plain text or an action object; each contributes its instruction text and anything else is ignored. */
function actionTexts(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.flatMap((action: unknown): string[] => {
        const text: unknown =
            typeof action === 'object' && action !== null ? Reflect.get(action, 'instruction') : action
        return typeof text === 'string' && text.length > 0 ? [text] : []
    })
}

/** Printed text outranks review actions, which outrank the raw title. Orientation and connection are sent separately. */
function instructionTextOf(printed: string | null | undefined, actions: readonly string[], title: string): string {
    if (printed !== null && printed !== undefined && printed.length > 0) return printed
    return actions.length > 0 ? actions.join('\n') : title
}

/**
 * The crop of the step's cited page: only its own cited region, padded. A whole-page citation sends no crop, so the
 * server accepts it as the full page and no other picture on that page is selected.
 */
function figureBoxFor(step: ManualStep, pageId: string): [number, number, number, number] | null {
    const region = step.sourceRefs.find((ref) => ref.pageId === pageId && ref.region !== null)?.region
    return region ? paddedStepFigureBox([region.x, region.y, region.width, region.height]) : null
}

/** The raw parse remains the source. Supplementary directions never replace its printed text or figure citation. */
export function motionRequestForStep(
    session: ManualSession,
    stepId: string,
    requestId: string,
): StepMotionRequest | null {
    const step = session.rawExtraction?.steps.find((candidate) => candidate.stepId === stepId)
    if (step === undefined) return null
    // A cited region across all pages beats a whole-page citation, so the crop is never lost to an earlier full page.
    const cited = step.sourceRefs.filter((candidate) => session.pages.some((page) => page.pageId === candidate.pageId))
    const ref = cited.find((candidate) => candidate.region !== null) ?? cited[0]
    const page = session.pages.find((candidate) => candidate.pageId === ref?.pageId)
    if (ref === undefined || page === undefined) return null
    const reviewed = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
    // Review actions when the reviewed entry carries them; an older or missing entry keeps the raw step's actions.
    const reviewedActions = reviewed === undefined ? undefined : Reflect.get(reviewed, 'actions')
    const actions = actionTexts(reviewedActions ?? Reflect.get(step, 'actions')).slice(0, 32)
    const parts = session.rawExtraction?.parts ?? session.parts
    const request = stepMotionRequestSchema.safeParse({
        requestId,
        manualHash: sha256Hex(
            canonicalJson(session.pages.map((item) => [item.contentHash, item.width, item.height, item.mimeType])),
        ),
        stepId,
        readingLanguage: session.readingLanguage ?? 'en',
        instructionText: instructionTextOf(step.sourceText, actions, step.title),
        sourceRefs: step.sourceRefs,
        parts: step.parts.flatMap((required) => {
            const part = parts.find((candidate) => candidate.partId === required.partId)
            return part?.name.state === 'known'
                ? [
                      {
                          id: part.partId,
                          name: part.name.value,
                          quantity: required.quantity.state === 'known' ? required.quantity.value : null,
                      },
                  ]
                : []
        }),
        actions,
        orientation: step.orientation.state === 'known' ? step.orientation.value.description : null,
        connection: step.connection.state === 'known' ? step.connection.value.description : null,
        page: { pageId: page.pageId, width: page.width, height: page.height, mimeType: page.mimeType },
        figureBox: figureBoxFor(step, page.pageId),
    })
    return request.success ? request.data : null
}

/** A dispatch marker survives a crash or ambiguous response. No implicit resend can spend for the same device key. */
export class StepMotionRegistry {
    private readonly pending = new Map<string, Promise<StepMotionScene | null>>()

    constructor(
        private readonly storage: KeyValueStorage,
        private readonly generate: Generate | null,
        private readonly canGenerate: () => Promise<boolean> = async (): Promise<boolean> => true,
    ) {}

    load(request: StepMotionRequest, pageUris: Readonly<Record<string, string>>): Promise<StepMotionScene | null> {
        const key = stepMotionCacheKey(request)
        const existing = this.pending.get(key)
        if (existing !== undefined) return existing
        if (this.pending.size >= 128) return Promise.resolve(null)
        const result = this.readOrGenerate(key, request, pageUris)
        this.pending.set(key, result)
        return result
    }

    private async readOrGenerate(
        key: string,
        request: StepMotionRequest,
        pageUris: Readonly<Record<string, string>>,
    ): Promise<StepMotionScene | null> {
        try {
            const raw = await this.storage.getItem(key)
            if (raw !== null) {
                if (raw.length > 500_000) return null
                const parsed = stepMotionResultSchema.safeParse(JSON.parse(raw))
                return parsed.success && (parsed.data.scene === null || parsed.data.scene.stepId === request.stepId)
                    ? parsed.data.scene
                    : null
            }
            if (this.generate === null) return null
            // Resolve permission before creating a marker that must survive a crash.
            if (!(await this.canGenerate())) {
                this.pending.delete(key)
                return null
            }
            await this.storage.setItem(key, JSON.stringify({ scene: null }))
            const attempt = await this.generate(request, pageUris)
            if (attempt !== null && 'status' in attempt && attempt.status === 'not_sent') {
                await this.storage.removeItem(key)
                this.pending.delete(key)
                return null
            }
            // An ambiguous outcome may already have a finished scene on the server: one cache-only lookup reads it, never
            // dispatches, and any miss, refusal or failure keeps the marker so the original uncertainty stays terminal.
            const outcome =
                attempt !== null && 'status' in attempt && attempt.status === 'unknown'
                    ? await this.generate({ ...request, cacheOnly: true }, {})
                    : attempt
            const result = stepMotionResultSchema.safeParse(outcome)
            if (!result.success || (result.data.scene !== null && result.data.scene.stepId !== request.stepId))
                return null
            await this.storage.setItem(key, JSON.stringify(result.data))
            return result.data.scene
        } catch {
            return null
        }
    }
}
