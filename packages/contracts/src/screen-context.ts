import type { CheckResult, ManualSession, ManualStep, QuestionResult } from './index'
import { SCREEN_CATALOG_VERSION, type ScreenFailure, type ScreenKind, type ScreenUiState } from './screen'

/** The current check or question result a screen is composed around (the same shape as the request carries). */
export type ScreenResultInput =
    { kind: 'check'; value: CheckResult } | { kind: 'question'; question: string; value: QuestionResult }

/**
 * Everything a screen composition is derived from. The API builds its grounding from exactly this and the app builds
 * its request from exactly this, so the context key cannot drift between them.
 */
export interface ScreenContextInputs {
    kind: ScreenKind
    session: ManualSession | null
    stepId: string | null
    captureId: string | null
    result: ScreenResultInput | null
    failure: ScreenFailure | null
    /** Completion screen only. */
    completedStepIds?: readonly string[] | undefined
    uiState?: ScreenUiState | null | undefined
}

/**
 * Canonical JSON: object keys sorted by code unit, `undefined` omitted, no whitespace. Pure and portable (no Node API),
 * so a server hashing it with Node crypto and an app hashing it with its own SHA-256 get the same digest.
 */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
            .join(',')}}`
    }
    return JSON.stringify(value) ?? 'null'
}

interface Facts {
    parts: ManualSession['parts']
    steps: readonly ManualStep[]
    reviewed: boolean
}

/** Reviewed facts when the session is reviewed; otherwise the known raw extraction (never guessed or merged). */
export function screenFacts(session: ManualSession | null): Facts | null {
    if (session === null) return null
    return session.reviewStatus === 'reviewed'
        ? { parts: session.parts, steps: session.reviewedSteps, reviewed: true }
        : { parts: session.rawExtraction?.parts ?? [], steps: session.rawExtraction?.steps ?? [], reviewed: false }
}

/**
 * The part of the app state a kind of screen actually uses (and the provider is shown). State a kind never uses is
 * left out of the identity, as is volatile data the provider never sees (a library entry's `updatedAt`).
 */
export function screenUiForKind(
    kind: ScreenKind,
    ui: ScreenUiState | null | undefined,
): Record<string, unknown> | null {
    switch (kind) {
        case 'home':
            return {
                library: ui?.library
                    ? {
                          soleManualId: ui.library.soleManualId,
                          entries: ui.library.entries.map(({ updatedAt: _updatedAt, ...entry }) => entry),
                      }
                    : null,
            }
        case 'add':
        case 'pages':
            return { pages: ui?.pages ?? null }
        case 'quick-check':
            return { review: ui?.review ?? null }
        case 'result':
        case 'questions':
        case 'answer':
        case 'recovery':
            return { capture: ui?.capture ?? null }
        case 'guide':
            // The guide of a step is prepared before any photo exists and must not be regenerated when one is taken.
            return null
        case 'more':
            return { sections: ui?.sections ? [...new Set(ui.sections)].sort() : null }
        case 'reading':
        case 'completion':
        case 'error':
            return null
    }
}

/** What the provider sees of a result: decision, words, citations and geometry. Telemetry and tickets are never seen. */
export function screenResultView(result: ScreenResultInput | null): Record<string, unknown> | null {
    if (result === null) return null
    const { value } = result
    const regions = {
        observedRegion: value.observedRegion ?? null,
        nextPartRegion: value.nextPartRegion ?? null,
        targetRegion: value.targetRegion ?? null,
        sourceRefs: value.sourceRefs,
        missingEvidence: value.missingEvidence,
    }
    return result.kind === 'check'
        ? { kind: 'check', decision: result.value.decision, reason: result.value.reason, ...regions }
        : { kind: 'question', question: result.question, answer: result.value.answer, ...regions }
}

/** The completion wording is factual only when saved progress covers every reviewed step of a reviewed session. */
export function completionWitnessed(
    inputs: Pick<ScreenContextInputs, 'kind' | 'session' | 'completedStepIds'>,
): boolean {
    const facts = screenFacts(inputs.session)
    const completed = new Set(inputs.completedStepIds ?? [])
    return (
        inputs.kind === 'completion' &&
        facts !== null &&
        facts.reviewed &&
        facts.steps.length > 0 &&
        facts.steps.every((step) => completed.has(step.stepId))
    )
}

/**
 * The identity split of a screen: `content` is what the composition is grounded in (reusable across revisions of
 * identical facts), `identity` binds it to one manual revision, step, capture and review state.
 */
export function screenContextParts(inputs: ScreenContextInputs): {
    content: Record<string, unknown>
    identity: {
        manualId: string | null
        revision: number | null
        stepId: string | null
        captureId: string | null
        reviewed: boolean | null
    }
} {
    const { session, kind, result } = inputs
    const facts = screenFacts(session)
    const stepIndex = facts && inputs.stepId ? facts.steps.findIndex((step) => step.stepId === inputs.stepId) : -1
    const step = stepIndex >= 0 && facts ? (facts.steps[stepIndex] ?? null) : null
    return {
        content: {
            catalog: SCREEN_CATALOG_VERSION,
            kind,
            manual: session && {
                title: session.title,
                pages: session.pages.map((page) => ({
                    pageId: page.pageId,
                    assetId: page.assetId,
                    contentHash: page.contentHash,
                    mimeType: page.mimeType,
                    width: page.width,
                    height: page.height,
                })),
                parts: facts?.parts ?? [],
                stepCount: facts?.steps.length ?? 0,
            },
            step,
            stepIndex,
            // A composition may name its capture, so a cached one is never re-grounded for another photo.
            captureId: result === null ? null : inputs.captureId,
            // Quick check states what was read, step by step, so every step's facts are inputs.
            steps: kind === 'quick-check' ? (facts?.steps ?? null) : null,
            failure: inputs.failure,
            completion: kind === 'completion' ? completionWitnessed(inputs) : null,
            result: screenResultView(result),
            ui: screenUiForKind(kind, inputs.uiState),
        },
        identity: {
            manualId: session?.manualId ?? null,
            revision: session?.revision ?? null,
            stepId: step?.stepId ?? null,
            captureId: result === null ? null : inputs.captureId,
            reviewed: facts?.reviewed ?? null,
        },
    }
}

/**
 * The exact bytes whose SHA-256 is `ScreenBound.contextKey`: every used source and media identity, fact (with its
 * sources), safety note, result, completion witness and used UI state. Any change to one is a different key.
 */
export function screenContextJson(inputs: ScreenContextInputs): string {
    return canonicalJson(screenContextParts(inputs))
}

/** The bytes whose SHA-256 identifies composition content independent of manual id, revision and review state. */
export function screenContentJson(inputs: ScreenContextInputs): string {
    return canonicalJson(screenContextParts(inputs).content)
}
