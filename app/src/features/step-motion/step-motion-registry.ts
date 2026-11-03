import {
    canonicalJson,
    STEP_MOTION_PROMPT_VERSION,
    stepMotionRequestSchema,
    stepMotionResultSchema,
    type ManualSession,
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

function stringField(value: object, key: string): string | undefined {
    const field: unknown = Reflect.get(value, key)
    return typeof field === 'string' && field.length > 0 ? field : undefined
}

/** The raw parse remains the source. Supplementary directions never replace its printed text or figure citation. */
export function motionRequestForStep(
    session: ManualSession,
    stepId: string,
    requestId: string,
): StepMotionRequest | null {
    const step = session.rawExtraction?.steps.find((candidate) => candidate.stepId === stepId)
    if (step === undefined) return null
    const ref = step.sourceRefs.find((candidate) => session.pages.some((page) => page.pageId === candidate.pageId))
    const page = session.pages.find((candidate) => candidate.pageId === ref?.pageId)
    if (ref === undefined || page === undefined) return null
    // Older parses retain the title only. Future source-text fields are copied exactly when present.
    const sourceText = [stringField(step, 'sourceText'), stringField(step, 'instructionText')].filter(
        (value): value is string => value !== undefined,
    )
    const reviewed = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
    const actions: unknown = reviewed === undefined ? undefined : Reflect.get(reviewed, 'actions')
    const parts = session.rawExtraction?.parts ?? session.parts
    const request = stepMotionRequestSchema.safeParse({
        requestId,
        manualHash: sha256Hex(
            canonicalJson(session.pages.map((item) => [item.contentHash, item.width, item.height, item.mimeType])),
        ),
        stepId,
        readingLanguage: session.readingLanguage ?? 'en',
        instructionText: [step.title, ...sourceText].join('\n'),
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
        actions: Array.isArray(actions) && actions.every((action) => typeof action === 'string') ? actions : [],
        orientation: step.orientation.state === 'known' ? step.orientation.value.description : null,
        connection: step.connection.state === 'known' ? step.connection.value.description : null,
        page: { pageId: page.pageId, width: page.width, height: page.height, mimeType: page.mimeType },
        // A source region can cite text rather than a figure. The cited full page keeps the drawing in context.
        figureBox: null,
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
            const result = stepMotionResultSchema.safeParse(attempt)
            if (!result.success || (result.data.scene !== null && result.data.scene.stepId !== request.stepId))
                return null
            await this.storage.setItem(key, JSON.stringify(result.data))
            return result.data.scene
        } catch {
            return null
        }
    }
}
