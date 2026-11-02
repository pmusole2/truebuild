import type { BusyActivityV2, ScreenContextInputsV2, ScreenKindV2 } from '@truebuild/contracts'
import { captureUiState, homeUiState, moreUiState, pagesUiState, reviewUiState } from '../screens/ui-state'
import { publishableResult } from '../screens/screen-spec'
import type { QuickProgress } from '../screens/quick-progress'
import type { WorkflowValue } from './workflow-context'
import type { WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import { reviewedSession } from './reviewed-session'
import { stepPiecesForStep } from '../pieces/piece-registry'

function activityOf(pending: string | null): BusyActivityV2 | null {
    if (pending === null) return null
    if (pending.startsWith('Taking a closer look') || pending.startsWith('Second opinion')) return 'second-opinion'
    if (pending.startsWith('Still thinking')) return 'question-waiting'
    if (pending.startsWith('Reading')) return 'reading'
    if (pending.startsWith('Checking') || pending.startsWith('Freezing')) return 'checking'
    if (pending.startsWith('Asking')) return 'asking'
    if (pending.startsWith('Saving')) return 'saving'
    return 'working'
}

export function documentInputs(
    kind: ScreenKindV2,
    workflow: Pick<WorkflowValue, 'state' | 'entry'>,
    quick?: QuickProgress,
    contextualMore = false,
): ScreenContextInputsV2 {
    const { state, entry } = workflow
    const pageCamera = kind === 'camera' && state.cameraIntent?.kind === 'page'
    const step = entry?.session.reviewedSteps[entry.stepIndex]
    const moreContext =
        kind === 'more' && contextualMore && entry?.session.reviewStatus === 'reviewed' && step !== undefined
    const held =
        state.capture !== null &&
        entry !== undefined &&
        step !== undefined &&
        state.capture.binding.manualId === entry.session.manualId &&
        state.capture.binding.revision === entry.session.revision &&
        state.capture.binding.stepId === step.stepId
    const answered =
        state.answer !== null && state.answeredQuestion != null
            ? { question: state.answeredQuestion, value: state.answer }
            : null
    const result =
        (kind === 'answer' || (moreContext && held && state.check === null)) && answered !== null
            ? publishableResult({ kind: 'question', ...answered })
            : (kind === 'result' || (moreContext && held)) && state.check !== null
              ? publishableResult({ kind: 'check', value: state.check })
              : null
    const inputs: ScreenContextInputsV2 = {
        kind,
        session:
            ['home', 'compare', 'judge', 'error'].includes(kind) || (kind === 'more' && !moreContext)
                ? null
                : (entry?.session ?? null),
        stepId:
            kind === 'camera'
                ? !pageCamera && entry?.session.reviewStatus === 'reviewed'
                    ? (step?.stepId ?? null)
                    : null
                : moreContext || ['guide', 'result', 'answer', 'questions', 'recovery'].includes(kind)
                  ? (step?.stepId ?? null)
                  : null,
        captureId:
            kind !== 'camera' && ((moreContext && held) || ['result', 'answer', 'questions'].includes(kind))
                ? (state.capture?.binding.captureId ?? null)
                : null,
        result,
        ...(moreContext && result?.kind === 'check' && answered !== null ? { companionAnswer: answered } : {}),
        failure: kind === 'error' || kind === 'recovery' ? 'provider_error' : null,
        ...(kind === 'completion' ? { completedStepIds: entry?.completedStepIds ?? [] } : {}),
        uiState:
            kind === 'home' || kind === 'compare'
                ? homeUiState(state.entries)
                : kind === 'add' || kind === 'pages'
                  ? entry === undefined
                      ? null
                      : pagesUiState(entry)
                  : kind === 'quick-check'
                    ? entry === undefined
                        ? null
                        : reviewUiState(entry, quick)
                    : kind === 'more' || kind === 'judge'
                      ? {
                            ...moreUiState({ tips: true }),
                            ...(kind === 'more'
                                ? {
                                      ...(moreContext ? (held ? captureUiState(state) : { capture: null }) : {}),
                                      language: { options: ['en', 'es', 'fr', 'de', 'pt-BR'] },
                                      settings: { storage: true as const },
                                  }
                                : {}),
                        }
                      : kind === 'reading'
                        ? { reading: { cancellation: 'confirm-before-stop' as const } }
                        : kind === 'camera'
                          ? {
                                camera: {
                                    mode: state.cameraIntent?.kind === 'page' ? 'manual-page' : 'build-photo',
                                    permission: 'undetermined',
                                },
                            }
                          : captureUiState(state),
    }
    const activity = activityOf(state.pending)
    inputs.uiState = { ...inputs.uiState, busy: activity === null ? null : { activity } }
    if (kind === 'guide' && inputs.session !== null) {
        const pieces = stepPiecesForStep(inputs.session, inputs.stepId)
        if (pieces.length > 0) inputs.stepPieces = pieces
    }
    return inputs
}

/**
 * The Home a person reaches after Confirm: the library as it will be once the candidate `reviewedSession` is saved over
 * the selected entry, built by the screen's own input function so its key is the key the real Home asks for. Null when
 * there is nothing to confirm.
 */
export function homeAfterConfirmInputs(
    state: WorkflowState,
    entry: LibraryEntry | undefined,
): ScreenContextInputsV2 | null {
    const candidate =
        entry === undefined || entry.session.reviewStatus === 'reviewed' ? null : reviewedSession(entry.session)
    if (entry === undefined || candidate === null || (entry.session.rawExtraction?.steps.length ?? 0) === 0) return null
    const entries = state.entries.map((current) =>
        current === entry ? { ...entry, session: candidate, capture: null } : current,
    )
    return documentInputs('home', { state: { ...state, pending: null, entries }, entry })
}

/**
 * Add and its page camera for the manual that Add creates from Home (`reserved`: its id and time are fixed by the
 * controller, so these keys are the real ones). The camera assumes the permission is already granted, as the guide
 * camera preparation does; a different observed access simply keys a different document.
 */
export function newManualInputs(state: WorkflowState, reserved: LibraryEntry): ScreenContextInputsV2[] {
    const idle = { ...state, pending: null, capture: null, cameraIntent: null }
    const camera = documentInputs('camera', { state: { ...idle, cameraIntent: { kind: 'page' } }, entry: reserved })
    if (camera.uiState?.camera != null)
        camera.uiState.camera = { ...camera.uiState.camera, permission: 'granted', failed: false, canAskAgain: true }
    return [documentInputs('add', { state: idle, entry: reserved }), camera]
}
