import {
    screenContextJson,
    type CheckResult,
    type ManualSession,
    type QuestionResult,
    type ScreenBound,
    type ScreenContextInputs,
    type ScreenDocument,
    type ScreenKind,
    type ScreenUiState,
} from '@truebuild/contracts'
import type { ModelScreensMetadata } from '@truebuild/contracts/model'
import { outgoingManualSession } from '../../api/outgoing-session'

/** Everything one `/api/screens` generate call is about. The same value keys the cache and the in-flight share. */
export type ScreenSpec = {
    readonly kind: ScreenKind
    readonly session: ManualSession | null
    readonly stepId: string | null
    readonly captureId: string | null
    readonly result: ModelScreensMetadata['result']
    readonly failure: ModelScreensMetadata['failure']
    /** Completion only: the step ids the person has saved as done, a wording witness the server checks. */
    readonly completedStepIds?: readonly string[]
    /** The live app state a composition may bind to: presence flags and ids, never drafts, photos or tickets. */
    readonly uiState?: ScreenUiState | null
}

/**
 * The exact inputs the server derives its grounding and context key from, built from this one request. The session is
 * the outgoing projection the request carries, so the expected key is the one the server computes from what it received.
 */
export function contextInputsOf(spec: ScreenSpec): ScreenContextInputs {
    return {
        kind: spec.kind,
        session: spec.session === null ? null : outgoingManualSession(spec.session),
        stepId: spec.stepId,
        captureId: spec.captureId,
        result: spec.result,
        failure: spec.failure,
        ...(spec.completedStepIds === undefined ? {} : { completedStepIds: spec.completedStepIds }),
        ...(spec.uiState === undefined ? {} : { uiState: spec.uiState }),
    }
}

/** SHA-256 of a string as lowercase hex. Injected so the store never depends on one crypto implementation. */
export type Digest256 = (text: string) => Promise<string>

/** The context key a document composed for this exact request must carry. */
export async function expectedContextKey(spec: ScreenSpec, digest: Digest256): Promise<string> {
    return digest(screenContextJson(contextInputsOf(spec)))
}

export type ScreenIdentity = {
    readonly manualId: string | null
    readonly revision: number | null
    readonly stepId: string | null
    readonly captureId: string | null
}

export const STEP_BOUND_KINDS: ReadonlySet<ScreenKind> = new Set(['guide', 'result', 'questions', 'answer', 'recovery'])
/** Kinds the `steps` mode still generates; everything else keeps its native screen. */
export const STEPS_MODE_KINDS: ReadonlySet<ScreenKind> = new Set(['guide'])

/**
 * The session as a screens request carries it: every fact a screen may state, without the raw extraction evidence a
 * screen never reads. Keeps the request small, and the cache key stable when only that evidence differs.
 */
export function sessionForScreens(session: ManualSession): ManualSession {
    const { extractionSourcePageIds: _sources, ...rest } = session
    void _sources
    return { ...rest, rawExtraction: null }
}

/**
 * A freshly read manual, before the person confirms it: the known raw steps are what the server prepares pages from.
 * Nothing else about the manual's evidence travels.
 */
export function sessionForPrecompute(session: ManualSession): ManualSession {
    const { extractionSourcePageIds: _sources, ...rest } = session
    void _sources
    return rest
}

export function identityOf(spec: ScreenSpec): ScreenIdentity {
    return {
        manualId: spec.session?.manualId ?? null,
        revision: spec.session?.revision ?? null,
        stepId: STEP_BOUND_KINDS.has(spec.kind) ? spec.stepId : null,
        captureId: spec.result === null ? null : spec.captureId,
    }
}

/** Identity fields only; the exact context key is verified separately (see `expectedContextKey`). */
export function sameIdentity(bound: ScreenBound, identity: ScreenIdentity): boolean {
    return (
        bound.manualId === identity.manualId &&
        bound.revision === identity.revision &&
        bound.stepId === identity.stepId &&
        bound.captureId === identity.captureId
    )
}

/** A document may be shown only on the exact screen it was composed for. */
export function documentMatches(document: ScreenDocument, spec: Pick<ScreenSpec, 'kind'> & ScreenIdentity): boolean {
    return document.kind === spec.kind && sameIdentity(document.bound, spec)
}

/** cyrb53: a fast, well-spread, non-cryptographic string hash. It only keys caches; identity fields are compared too. */
export function hashText(text: string): string {
    let h1 = 0xdeadbeef
    let h2 = 0x41c6ce57
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index)
        h1 = Math.imul(h1 ^ code, 2654435761)
        h2 = Math.imul(h2 ^ code, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * The parts of a session that can change what a screen states. The volatile stamp (`updatedAt`) and the raw extraction
 * are left out, so saving a capture never re-composes every page, while any edited fact, title or page does.
 */
export function sessionFingerprint(session: ManualSession | null): string {
    if (session === null) return 'none'
    return hashText(
        JSON.stringify([
            session.manualId,
            session.revision,
            session.title,
            session.reviewStatus,
            session.pages.map((page) => [page.pageId, page.contentHash]),
            session.parts,
            session.reviewedSteps,
            // Quick check is composed from what was read, so a different read is a different screen.
            session.rawExtraction === null ? null : hashText(JSON.stringify(session.rawExtraction.steps)),
        ]),
    )
}

/** A verdict or answer minus anything one-use: tickets never reach a screens request and never key a cache. */
export function publishableResult(
    result:
        | { readonly kind: 'check'; readonly value: CheckResult }
        | { readonly kind: 'question'; readonly question: string; readonly value: QuestionResult },
): NonNullable<ModelScreensMetadata['result']> {
    if (result.kind === 'question') {
        return { kind: 'question', question: result.question, value: result.value }
    }
    const { followUps: _followUps, secondOpinion, ...rest } = result.value
    void _followUps
    const value: CheckResult =
        secondOpinion === undefined
            ? rest
            : {
                  ...rest,
                  secondOpinion:
                      secondOpinion.status === 'available'
                          ? { model: secondOpinion.model, status: 'unavailable' }
                          : secondOpinion,
              }
    return { kind: 'check', value }
}

export function specKey(spec: ScreenSpec): string {
    // Use the complete portable context itself: neither geometry/source updates nor hash collisions can reuse a
    // different screen. Tickets, telemetry and volatile timestamps are already excluded by this shared function.
    return screenContextJson(contextInputsOf(spec))
}

/** Key of a step's guide page, shared by on-demand generation and the background precompute. */
export function guideKey(session: ManualSession, stepId: string): string {
    return specKey({ kind: 'guide', session, stepId, captureId: null, result: null, failure: null })
}
