import type { BusyActivityV2, ScreenContextInputsV2, ScreenKindV2 } from '@truebuild/contracts'
import { captureUiState, homeUiState, moreUiState, pagesUiState, reviewUiState } from '../screens/ui-state'
import { publishableResult } from '../screens/screen-spec'
import type { QuickProgress } from '../screens/quick-progress'
import type { WorkflowValue } from './workflow-context'

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
    return inputs
}
