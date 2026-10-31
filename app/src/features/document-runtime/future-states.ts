import type { BusyActivityV2, ScreenContextInputsV2 } from '@truebuild/contracts'

/** Only contexts whose complete factual/photo identity is already known. Never predict a verdict, answer or capture. */
export function futureDocumentStates(inputs: ScreenContextInputsV2): ScreenContextInputsV2[] {
    if (inputs.uiState?.busy != null) return []
    const activities: readonly BusyActivityV2[] =
        inputs.kind === 'guide'
            ? ['checking', 'second-opinion', 'asking', 'question-waiting']
            : inputs.kind === 'questions' || inputs.kind === 'result'
              ? ['asking', 'question-waiting']
              : inputs.kind === 'camera'
                ? ['checking', 'saving']
                : []
    return activities.map((activity) => ({
        ...inputs,
        uiState: { ...inputs.uiState, busy: { activity } },
    }))
}
