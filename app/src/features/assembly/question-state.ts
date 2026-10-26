import {
    matchesBinding,
    type ApiResult,
    type CaptureBinding,
    type ManualSession,
    type ManualStep,
    type QuestionResult,
    type QuestionTarget,
} from '@truebuild/contracts'

export const QUESTION_MAX_LENGTH = 500

// Short, fixed wording for the most common assembly questions. Chosen by a person; the model never proposes them.
export const QUESTION_PRESETS: readonly string[] = [
    'Which way should this part face?',
    'Is this connection seated as the manual shows?',
    'Which part is this?',
]

export type QuestionState = {
    readonly binding: CaptureBinding
    readonly question: string
    readonly target: QuestionTarget | null
    readonly pendingRequestId: string | null
    readonly result: ApiResult<QuestionResult> | null
}

export type QuestionEvent =
    | { readonly type: 'bindingSynced'; readonly binding: CaptureBinding }
    | { readonly type: 'questionChanged'; readonly question: string }
    | { readonly type: 'targetChanged'; readonly target: QuestionTarget | null }
    | { readonly type: 'started'; readonly requestId: string }
    | {
          readonly type: 'finished'
          readonly requestId: string
          readonly binding: CaptureBinding
          readonly result: ApiResult<QuestionResult>
      }
    | { readonly type: 'aborted'; readonly requestId: string }
    | { readonly type: 'invalidated' }

export function createQuestionState(binding: CaptureBinding): QuestionState {
    return { binding, question: '', target: null, pendingRequestId: null, result: null }
}

/** Only a question and a target from the current step (or a tap on the frozen photo) may be asked. */
export function questionReady(state: QuestionState): boolean {
    return (
        state.pendingRequestId === null &&
        state.question.trim().length > 0 &&
        state.question.trim().length <= QUESTION_MAX_LENGTH &&
        state.target !== null
    )
}

export function questionReducer(state: QuestionState, event: QuestionEvent): QuestionState {
    switch (event.type) {
        case 'bindingSynced':
            // A different step, photo, revision or capture makes the old answer and any chosen target stale.
            return matchesBinding(event.binding, state.binding)
                ? state
                : { ...createQuestionState(event.binding), question: state.question }
        case 'questionChanged':
        case 'targetChanged':
            // Editing the wording or the target invalidates the answer shown for the previous ones.
            return {
                ...state,
                ...(event.type === 'questionChanged' ? { question: event.question } : { target: event.target }),
                pendingRequestId: null,
                result: null,
            }
        case 'started':
            return state.pendingRequestId === null
                ? { ...state, pendingRequestId: event.requestId, result: null }
                : state
        case 'finished':
            if (event.requestId !== state.pendingRequestId || !matchesBinding(event.binding, state.binding)) {
                return state
            }
            if (event.result.requestId !== event.requestId) {
                return { ...state, pendingRequestId: null, result: null }
            }
            return { ...state, pendingRequestId: null, result: event.result }
        case 'invalidated':
            // Keeps the wording the user typed; drops the target, any pending request and any answer.
            return { ...state, target: null, pendingRequestId: null, result: null }
        case 'aborted':
            return event.requestId === state.pendingRequestId ? { ...state, pendingRequestId: null } : state
    }
}

/** Parts the current step uses, labelled by their known registry name. The step is the only source of choices. */
export function stepPartChoices(session: ManualSession, step: ManualStep): { partId: string; label: string }[] {
    const ids = [
        ...step.parts.map((part) => part.partId),
        ...(step.orientation.state === 'known' ? [step.orientation.value.partId] : []),
        ...(step.connection.state === 'known' ? step.connection.value.partIds : []),
    ]
    return [...new Set(ids)].map((partId) => {
        const registry = session.parts.find((part) => part.partId === partId)
        return {
            partId,
            label: registry !== undefined && registry.name.state === 'known' ? registry.name.value : partId,
        }
    })
}
