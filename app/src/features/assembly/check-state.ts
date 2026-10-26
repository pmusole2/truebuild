import { matchesBinding, type ApiResult, type CaptureBinding, type CheckResult } from '@truebuild/contracts'

export type CheckMode = 'fixture' | 'model'
export type Scenario = 'correct' | 'wrong' | 'unclear'

export type RunCheck = (request: CheckRequest, signal: AbortSignal) => Promise<ApiResult<CheckResult>>

export type CheckRequest = {
    readonly mode: CheckMode
    readonly requestId: string
    readonly binding: CaptureBinding
    readonly scenario: Scenario
}

export type CheckState = {
    readonly binding: CaptureBinding
    readonly mode: CheckMode
    readonly scenario: Scenario
    readonly pendingRequestId: string | null
    readonly result: ApiResult<CheckResult> | null
}

export type CheckEvent =
    | { readonly type: 'bindingSynced'; readonly binding: CaptureBinding }
    | { readonly type: 'modeChanged'; readonly mode: CheckMode }
    | { readonly type: 'scenarioChanged'; readonly scenario: Scenario }
    | { readonly type: 'checkStarted'; readonly requestId: string }
    | {
          readonly type: 'checkFinished'
          readonly requestId: string
          readonly binding: CaptureBinding
          readonly result: ApiResult<CheckResult>
      }
    | { readonly type: 'checkAborted'; readonly requestId: string }
    // Connection replaced/cleared or mode changed: any pending request and visible verdict are stale.
    | { readonly type: 'invalidated' }

export function createCheckState(binding: CaptureBinding): CheckState {
    return { binding, mode: 'fixture', scenario: 'correct', pendingRequestId: null, result: null }
}

// Every visible change to the capture, step, revision, mode or scenario drops the previous verdict.
export function checkReducer(state: CheckState, event: CheckEvent): CheckState {
    switch (event.type) {
        case 'bindingSynced':
            return matchesBinding(event.binding, state.binding)
                ? state
                : { ...state, binding: event.binding, pendingRequestId: null, result: null }
        case 'modeChanged':
            return { ...state, mode: event.mode, pendingRequestId: null, result: null }
        case 'scenarioChanged':
            return { ...state, scenario: event.scenario, pendingRequestId: null, result: null }
        case 'checkStarted':
            // A second tap while a request is in flight is ignored, so each tap dispatches at most once.
            if (state.pendingRequestId !== null) {
                return state
            }
            return { ...state, pendingRequestId: event.requestId, result: null }
        case 'checkFinished':
            // Late replies for an earlier request or an earlier binding never replace the current verdict.
            if (event.requestId !== state.pendingRequestId || !matchesBinding(event.binding, state.binding)) {
                return state
            }
            // The reply itself must echo this request, its binding and the selected mode; otherwise it is not published.
            if (!resultMatchesRequest(event.result, state)) {
                return { ...state, pendingRequestId: null, result: invalidOutput(state, event.requestId) }
            }
            return { ...state, pendingRequestId: null, result: event.result }
        case 'invalidated':
            return { ...state, pendingRequestId: null, result: null }
        case 'checkAborted':
            return event.requestId === state.pendingRequestId ? { ...state, pendingRequestId: null } : state
    }
}

function resultMatchesRequest(result: ApiResult<CheckResult>, state: CheckState): boolean {
    if (state.pendingRequestId === null || result.requestId !== state.pendingRequestId) {
        return false
    }
    if (result.status === 'ok') {
        return result.mode === state.mode && matchesBinding(result.binding, state.binding)
    }
    // Unavailable replies may omit the binding; when present it must be this capture.
    return result.binding === null || matchesBinding(result.binding, state.binding)
}

// Used when a reply does not match the request: the user sees a failed check, never a verdict.
function invalidOutput(state: CheckState, requestId: string): ApiResult<CheckResult> {
    return {
        status: 'unavailable',
        requestId,
        binding: state.binding,
        code: 'invalid_output',
        retryable: false,
    }
}

export function canRunCheck(state: CheckState, reviewed: boolean): boolean {
    return reviewed && state.pendingRequestId === null
}
