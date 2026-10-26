import {
    matchesBinding,
    type ApiResult,
    type CaptureBinding,
    type NormalizedBox,
    type SegmentEvent,
} from '@truebuild/contracts'

export type LocalizationStatus = 'idle' | 'pending' | 'completed' | 'empty' | 'unavailable'

export type LocalizationState = {
    readonly binding: CaptureBinding
    readonly prompt: string
    readonly pendingRequestId: string | null
    readonly status: LocalizationStatus
    readonly boxes: readonly { readonly label: string; readonly box: NormalizedBox }[]
    readonly code: string | null
}

export type LocalizationEvent =
    | { readonly type: 'bindingSynced'; readonly binding: CaptureBinding }
    | { readonly type: 'promptChanged'; readonly prompt: string }
    | { readonly type: 'started'; readonly requestId: string }
    | { readonly type: 'received'; readonly requestId: string; readonly result: ApiResult<SegmentEvent> }
    | { readonly type: 'aborted'; readonly requestId: string }
    | { readonly type: 'invalidated' }

export function createLocalizationState(binding: CaptureBinding): LocalizationState {
    return { binding, prompt: '', pendingRequestId: null, status: 'idle', boxes: [], code: null }
}

/** Frozen-photo snapshots only: each snapshot replaces the boxes shown; nothing carries over between requests. */
export function localizationReducer(state: LocalizationState, event: LocalizationEvent): LocalizationState {
    switch (event.type) {
        case 'bindingSynced':
            // Hides any previous boxes at once when the photo, step, revision or capture changes.
            return matchesBinding(event.binding, state.binding)
                ? state
                : { ...createLocalizationState(event.binding), prompt: state.prompt }
        case 'promptChanged':
            return { ...state, prompt: event.prompt, pendingRequestId: null, status: 'idle', boxes: [], code: null }
        case 'started':
            if (state.pendingRequestId !== null) {
                return state
            }
            return { ...state, pendingRequestId: event.requestId, status: 'pending', boxes: [], code: null }
        case 'received':
            return receive(state, event.requestId, event.result)
        case 'invalidated':
            return { ...state, pendingRequestId: null, status: 'idle', boxes: [], code: null }
        case 'aborted':
            return event.requestId === state.pendingRequestId
                ? { ...state, pendingRequestId: null, status: 'idle' }
                : state
    }
}

function receive(state: LocalizationState, requestId: string, result: ApiResult<SegmentEvent>): LocalizationState {
    if (requestId !== state.pendingRequestId || result.requestId !== requestId) {
        return state
    }
    if (result.status === 'unavailable') {
        return { ...state, pendingRequestId: null, status: 'unavailable', boxes: [], code: result.code }
    }
    if (result.binding === null || !matchesBinding(result.binding, state.binding)) {
        return { ...state, pendingRequestId: null, status: 'unavailable', boxes: [], code: 'invalid_output' }
    }
    const event = result.value
    if (event.type === 'snapshot') {
        return {
            ...state,
            status: 'pending',
            boxes: event.snapshot.records.map((record) => ({ label: record.label, box: record.box })),
        }
    }
    if (event.type === 'completed') {
        const found = state.boxes.length > 0
        return { ...state, pendingRequestId: null, status: found ? 'completed' : 'empty', code: null }
    }
    return { ...state, pendingRequestId: null, status: 'unavailable', boxes: [], code: event.code }
}

/** A prompt is a short noun phrase: the same rule the frozen wire schema enforces, checked before any request. */
export function localizationReady(state: LocalizationState): boolean {
    return state.pendingRequestId === null && state.prompt.trim().length > 0
}
