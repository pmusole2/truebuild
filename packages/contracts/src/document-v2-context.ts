import type { ManualSession, ManualStep, QuestionResult } from './index'
import {
    canonicalJson,
    screenFacts,
    screenResultView,
    screenContextParts,
    screenUiForKind,
    type ScreenContextInputs,
    type ScreenResultInput,
} from './screen-context'
import type { ScreenFailure, ScreenKind } from './screen'
import type { PieceSpec } from './piece-spec'
import {
    SCREEN_CATALOG_V2_VERSION,
    type DocumentSourceV2,
    type ScreenKindV2,
    type ScreenUiStateV2,
} from './document-v2'

/**
 * The answer a person got about the photo of a retained check, held beside that check by a step-scoped More. Legal only
 * on `more` with a check as the primary result and the same held capture (an answer held alone is the primary result).
 */
export interface CompanionAnswerV2 {
    question: string
    value: QuestionResult
}

/** Most pieces a guide's step may name (the closed catalog of one step). */
export const STEP_PIECES_MAX_V2 = 30

/**
 * One piece a guide's step names: its registry id and its quantity (null: not known). The app draws the piece and its
 * quantity; the model names the id only.
 */
export interface StepPieceV2 {
    pieceId: string
    quantity: number | null
}

/**
 * Everything a version 2 composition is derived from. The API builds its grounding from exactly this and the app builds
 * its request (and its local deterministic document) from exactly this, so the context key cannot drift between them.
 */
export interface ScreenContextInputsV2 {
    kind: ScreenKindV2
    session: ManualSession | null
    stepId: string | null
    captureId: string | null
    result: ScreenResultInput | null
    failure: ScreenFailure | null
    /** Completion screen only. */
    completedStepIds?: readonly string[] | undefined
    uiState?: ScreenUiStateV2 | null | undefined
    /** More only: the answer held beside a retained check (see `CompanionAnswerV2`). Absent/null: none. */
    companionAnswer?: CompanionAnswerV2 | null | undefined
    /**
     * The app's piece registry: the only pieces a native piece node may name. Absent/null: none is available, and the
     * key of the screen is exactly what it was before the registry existed.
     */
    pieces?: readonly PieceSpec[] | null | undefined
    /**
     * Guide only: the closed catalog of the pieces this step names, known before the registry's geometry is ready. Absent,
     * null or empty: the guide names no piece, and the key of the screen is exactly what it was before this existed.
     */
    stepPieces?: readonly StepPieceV2[] | null | undefined
}

/**
 * The step's piece catalog as a document uses it: a guide's non-empty `stepPieces`, reduced to its id and quantity, or
 * null. Every other screen has none, whatever the caller sent, so the key and the request read the same value.
 */
export function stepPiecesUsedV2(
    inputs: Pick<ScreenContextInputsV2, 'kind' | 'stepPieces'>,
): readonly StepPieceV2[] | null {
    const pieces = inputs.kind === 'guide' ? inputs.stepPieces : null
    return pieces != null && pieces.length > 0
        ? pieces.map((piece) => ({ pieceId: piece.pieceId, quantity: piece.quantity }))
        : null
}

/** A More that is about one reviewed step (the person opened it from that step); a global More has no step. */
export const moreScopedV2 = (inputs: Pick<ScreenContextInputsV2, 'kind' | 'stepId'>): boolean =>
    inputs.kind === 'more' && inputs.stepId !== null

/**
 * The companion answer a document may hold: only a step-scoped More whose primary result is a check, with that check's
 * held capture. Anything else (another kind, an answer held alone, no photo) has none, whatever the caller sent.
 */
export const companionAnswerOfV2 = (
    inputs: Pick<ScreenContextInputsV2, 'kind' | 'stepId' | 'result' | 'captureId' | 'companionAnswer'>,
): CompanionAnswerV2 | null =>
    moreScopedV2(inputs) && inputs.result?.kind === 'check' && inputs.captureId !== null
        ? (inputs.companionAnswer ?? null)
        : null

/**
 * The inputs as the document uses them: a global More has no manual, step, photo or result (whatever the caller
 * sent), and a companion answer exists only where it is legal. The key, the material and the request all read this.
 */
export function usedScopeV2(inputs: ScreenContextInputsV2): ScreenContextInputsV2 {
    const global = inputs.kind === 'more' && inputs.stepId === null
    const base: ScreenContextInputsV2 = global
        ? { ...inputs, session: null, captureId: null, result: null, companionAnswer: null, pieces: null }
        : inputs
    const companionAnswer = companionAnswerOfV2(base)
    const scoped = companionAnswer === null && base.companionAnswer === undefined ? base : { ...base, companionAnswer }
    const stepPieces = stepPiecesUsedV2(scoped)
    return stepPieces === null && scoped.stepPieces === undefined ? scoped : { ...scoped, stepPieces }
}

/**
 * The result of one type a document holds: the primary result when it has that type, or the companion answer beside a
 * retained check. This is what a `VerdictCard` of that type shows.
 */
export function resultOfKindV2(
    inputs: Pick<ScreenContextInputsV2, 'kind' | 'stepId' | 'result' | 'captureId' | 'companionAnswer'>,
    kind: 'check' | 'question',
): ScreenResultInput | null {
    if (inputs.result?.kind === kind) return inputs.result
    const companion = kind === 'question' ? companionAnswerOfV2(inputs) : null
    return companion === null ? null : { kind: 'question', question: companion.question, value: companion.value }
}

/** The one busy activity that witnesses a check in flight (`Freezing photo…`, `Checking frozen photo…`). */
export const PENDING_CHECK_ACTIVITY_V2 = 'checking' as const

/**
 * Whether these inputs are the HELD PHOTO OF A CHECK THAT HAS NOT RETURNED: a result screen before its result. It is true
 * only when the app actually holds the evidence for it, all at once: a result screen without a result or a failure, a
 * reviewed manual that has the step, the capture the app holds (named in the inputs and in the held-capture state), and
 * the checking activity. Anything else keeps the meaning it always had; nothing here is ever assumed or inferred.
 */
export function pendingCheckV2(
    inputs: Pick<ScreenContextInputsV2, 'kind' | 'captureId' | 'result' | 'uiState'> &
        Partial<Pick<ScreenContextInputsV2, 'session' | 'stepId' | 'failure'>>,
): boolean {
    const { session, stepId, captureId } = inputs
    return (
        inputs.kind === 'result' &&
        inputs.result === null &&
        (inputs.failure ?? null) === null &&
        session != null &&
        session.reviewStatus === 'reviewed' &&
        stepId != null &&
        session.reviewedSteps.some((step) => step.stepId === stepId) &&
        captureId != null &&
        inputs.uiState?.capture?.captureId === captureId &&
        inputs.uiState?.busy?.activity === PENDING_CHECK_ACTIVITY_V2
    )
}

/**
 * Exact held capture used by a document, including a question before its answer exists and a check before its result
 * returns (see `pendingCheckV2`).
 */
export function captureWitnessV2(
    inputs: Pick<ScreenContextInputsV2, 'kind' | 'result' | 'captureId' | 'uiState'> &
        Partial<Pick<ScreenContextInputsV2, 'session' | 'stepId' | 'failure'>>,
): string | null {
    if (inputs.result !== null) return inputs.captureId
    if (pendingCheckV2(inputs)) return inputs.captureId
    const heldHere = inputs.kind === 'questions' || (inputs.kind === 'more' && (inputs.stepId ?? null) !== null)
    const held = heldHere ? inputs.uiState?.capture : null
    return held && (inputs.captureId === null || inputs.captureId === held.captureId) ? held.captureId : null
}

/** A step's own source references, restricted to the pages the manual really has (a missing page is never cited). */
export const usableRefsOf = (step: ManualStep, session: ManualSession | null): DocumentSourceV2[] =>
    step.sourceRefs
        .filter((ref) => session?.pages.some((page) => page.pageId === ref.pageId) === true)
        .slice(0, 100)
        .map((ref) => ({ pageId: ref.pageId, region: ref.region }))

/**
 * The manual's own picture for a finished build. `whole` is true when it is a whole page, not a figure.
 */
export interface CompletionFigureV2 {
    ref: DocumentSourceV2
    whole: boolean
}

/**
 * The picture the finished-build screen shows, from the manual itself and nothing else: the first usable reference of
 * the manual's LAST step (as the legacy Done hero did), exactly as cited (a region stays that region, a whole page stays
 * a whole page); else the manual's FIRST page, whole. A region is never invented or widened, and a manual with no page
 * has no picture. Reviewed or not, the steps are the ones every other screen reads (`screenFacts`).
 */
export function completionFigureV2(session: ManualSession | null): CompletionFigureV2 | null {
    if (session === null) return null
    const steps = screenFacts(session)?.steps ?? []
    const last = steps[steps.length - 1]
    const own = last === undefined ? undefined : usableRefsOf(last, session)[0]
    if (own !== undefined) return { ref: own, whole: own.region === null }
    const first = session.pages[0]
    return first === undefined ? null : { ref: { pageId: first.pageId, region: null }, whole: true }
}

/** The v1 kind whose session, step and result identity a v2 kind shares. */
export function baseKindV2(kind: ScreenKindV2): ScreenKind {
    switch (kind) {
        case 'camera':
            return 'guide'
        case 'judge':
            return 'more'
        case 'compare':
            return 'home'
        default:
            return kind
    }
}

/**
 * What a camera screen can honestly do right now, derived only from the witnessed state (absent state is never granted):
 * `ready` the permission is granted and the camera runs (the raw camera belongs on the screen); `retry` it is granted but
 * the camera failed; `allow` it is not granted and the system prompt can still be shown (or that is unknown); `settings`
 * it is not granted and only the device settings can grant it. A missing permission always wins over a failure.
 */
export type CameraAccessV2 = 'ready' | 'retry' | 'allow' | 'settings'
export function cameraAccessV2(camera: ScreenUiStateV2['camera'] | undefined): CameraAccessV2 {
    if (!camera || camera.permission !== 'granted') return camera?.canAskAgain === false ? 'settings' : 'allow'
    return camera.failed === true ? 'retry' : 'ready'
}

/**
 * The camera state a context key covers: only the fields that change the document. The defaults (`failed: false`,
 * `canAskAgain: null`) and the fields that do not matter to the access (a failure while the permission is missing, a
 * prompt hint while it is granted) are normalized away, so equivalent states share one key.
 */
function cameraKeyV2(camera: ScreenUiStateV2['camera'] | undefined): Record<string, unknown> | null {
    if (!camera) return null
    const granted = camera.permission === 'granted'
    return {
        mode: camera.mode,
        permission: camera.permission,
        failed: granted && camera.failed === true,
        canAskAgain: granted || camera.canAskAgain !== false ? null : false,
    }
}

/** Kinds whose busy variant is authored from what the app is busy doing (error, More, judge and compare are never busy). */
const BUSY_KINDS_V2: ReadonlySet<ScreenKindV2> = new Set<ScreenKindV2>([
    'home',
    'add',
    'pages',
    'reading',
    'quick-check',
    'guide',
    'camera',
    'result',
    'questions',
    'answer',
    'recovery',
    'completion',
])

/**
 * The part of the app state a kind of v2 screen uses (and the provider is shown): exactly the fields its composition may
 * depend on. Volatile data stays out (a count, a draft, the current language): bound text reads those live.
 */
export function screenUiForKindV2(
    kind: ScreenKindV2,
    ui: ScreenUiStateV2 | null | undefined,
    scope: { stepScoped: boolean } = { stepScoped: false },
): Record<string, unknown> | null {
    const base = ((): Record<string, unknown> | null => {
        // A problem notice is part of the key only where one is shown, and only when one exists (idle keys are unchanged).
        const failure = ui?.failure?.notice === true ? { failure: { notice: true } } : {}
        switch (kind) {
            case 'camera':
                return { camera: cameraKeyV2(ui?.camera) }
            case 'judge':
                return { ...screenUiForKind('more', ui), judge: ui?.judge ?? null }
            case 'compare':
                return screenUiForKind('home', ui)
            case 'pages':
                // The cancellation witness is part of the key only where it exists (every other pages key is unchanged).
                return {
                    ...screenUiForKind('pages', ui),
                    ...(ui?.cancelled?.reading === true ? { cancelled: { reading: true } } : {}),
                }
            case 'reading':
                return { reading: ui?.reading ?? null, ...failure }
            case 'error':
                return Object.keys(failure).length > 0 ? failure : null
            case 'recovery':
                return { ...screenUiForKind('recovery', ui), ...failure }
            case 'more':
                return {
                    ...screenUiForKind('more', ui),
                    language: ui?.language ? { options: [...ui.language.options] } : null,
                    settings: ui?.settings ? { storage: true } : null,
                    // Only a step-scoped More holds a photo, and only its identity matters to the composition.
                    ...(scope.stepScoped ? { capture: ui?.capture ? { captureId: ui.capture.captureId } : null } : {}),
                }
            default:
                return screenUiForKind(kind, ui)
        }
    })()
    return BUSY_KINDS_V2.has(kind) ? { ...(base ?? {}), busy: ui?.busy ?? null } : base
}

/**
 * `content` is what the composition is grounded in (reusable across revisions of identical facts); `identity` binds it
 * to one manual revision, step, capture and review state. The v2 catalog is part of the content, so a v2 key never
 * equals a v1 key for the same screen.
 */
export function screenContextPartsV2(raw: ScreenContextInputsV2): ReturnType<typeof screenContextParts> {
    const inputs = usedScopeV2(raw)
    const base: ScreenContextInputs = {
        kind: baseKindV2(inputs.kind),
        session: inputs.session,
        stepId: inputs.stepId,
        captureId: inputs.captureId,
        result: inputs.result,
        failure: inputs.failure,
        completedStepIds: inputs.completedStepIds,
        uiState: null,
    }
    const parts = screenContextParts(base)
    const companion = inputs.companionAnswer ?? null
    // The finished build's picture is grounded in the manual's own cited step: part of the key only where it exists.
    const figure = inputs.kind === 'completion' ? completionFigureV2(inputs.session) : null
    return {
        content: {
            ...parts.content,
            captureId: captureWitnessV2(inputs),
            kind: inputs.kind,
            catalogV2: SCREEN_CATALOG_V2_VERSION,
            ui: screenUiForKindV2(inputs.kind, inputs.uiState, { stepScoped: moreScopedV2(inputs) }),
            // Present only when held, so the key of every other screen is exactly what it always was.
            ...(companion === null
                ? {}
                : {
                      companion: screenResultView({
                          kind: 'question',
                          question: companion.question,
                          value: companion.value,
                      }),
                  }),
            ...(figure === null ? {} : { figure: figure.ref }),
            // The piece registry is grounding only where supplied: absent keeps every existing key exactly as it was.
            ...(inputs.pieces == null ? {} : { pieces: inputs.pieces }),
            // A guide's closed piece catalog: part of the key only where it names pieces (already normalized, see above).
            ...(inputs.stepPieces == null ? {} : { stepPieces: inputs.stepPieces }),
        },
        identity: { ...parts.identity, captureId: captureWitnessV2(inputs) },
    }
}

/** The exact bytes whose SHA-256 is `ScreenBound.contextKey` of a version 2 document. */
export function screenContextJsonV2(inputs: ScreenContextInputsV2): string {
    return canonicalJson(screenContextPartsV2(inputs))
}

/** The bytes whose SHA-256 identifies composition content independent of manual id, revision and review state. */
export function screenContentJsonV2(inputs: ScreenContextInputsV2): string {
    return canonicalJson(screenContextPartsV2(inputs).content)
}

/**
 * The bytes whose SHA-256 is the request's `manualHash`: the whole supplied session. The key above binds the facts a
 * screen uses; this binds the complete manual state the request was built from, so a stale or edited copy is refused.
 */
export function screenManualJsonV2(session: ManualSession): string {
    return canonicalJson(session)
}
