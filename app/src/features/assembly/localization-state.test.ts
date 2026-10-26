import type { ApiResult, CaptureBinding, SegmentEvent } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { createLocalizationState, localizationReducer, type LocalizationState } from './localization-state'

const binding: CaptureBinding = {
    kind: 'capture',
    manualId: 'manual-1',
    revision: 2,
    stepId: 'step-1',
    captureId: 'capture-1',
}
const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }

const snapshot = (requestId: string, records: { objectId: string; label: string }[]): ApiResult<SegmentEvent> => ({
    status: 'ok',
    requestId,
    mode: 'model',
    binding,
    value: {
        type: 'snapshot',
        snapshot: {
            binding,
            streamId: 'stream-1',
            frameIndex: 0,
            capturedAt: '2026-10-26T10:00:00.000Z',
            records: records.map((record) => ({ ...record, box })),
            complete: false,
        },
    },
})
const completed = (requestId: string): ApiResult<SegmentEvent> => ({
    status: 'ok',
    requestId,
    mode: 'model',
    binding,
    value: { type: 'completed' },
})

function started(): LocalizationState {
    const state = localizationReducer(createLocalizationState(binding), { type: 'promptChanged', prompt: 'side panel' })
    return localizationReducer(state, { type: 'started', requestId: 'loc-1' })
}

describe('localization state', () => {
    it('shows snapshot boxes as pending and completes with the found regions', () => {
        let state = localizationReducer(started(), {
            type: 'received',
            requestId: 'loc-1',
            result: snapshot('loc-1', [{ objectId: 'o1', label: 'Panel' }]),
        })
        expect(state.status).toBe('pending')
        expect(state.boxes).toHaveLength(1)

        state = localizationReducer(state, { type: 'received', requestId: 'loc-1', result: completed('loc-1') })
        expect(state).toMatchObject({ status: 'completed', pendingRequestId: null })
    })

    it('reports an empty result only when the stream completes with no regions', () => {
        const state = localizationReducer(started(), {
            type: 'received',
            requestId: 'loc-1',
            result: completed('loc-1'),
        })
        expect(state).toMatchObject({ status: 'empty', boxes: [] })
    })

    it('ends unavailable with the code and never shows boxes from it', () => {
        const state = localizationReducer(started(), {
            type: 'received',
            requestId: 'loc-1',
            result: { status: 'unavailable', requestId: 'loc-1', binding, code: 'timeout', retryable: true },
        })
        expect(state).toMatchObject({ status: 'unavailable', code: 'timeout', boxes: [] })
    })

    it('ignores a late event for an earlier request', () => {
        const state = started()
        expect(localizationReducer(state, { type: 'received', requestId: 'loc-0', result: completed('loc-0') })).toBe(
            state,
        )
    })

    it('hides the previous boxes immediately when the capture changes', () => {
        const withBoxes = localizationReducer(started(), {
            type: 'received',
            requestId: 'loc-1',
            result: snapshot('loc-1', [{ objectId: 'o1', label: 'Panel' }]),
        })
        const next = localizationReducer(withBoxes, {
            type: 'bindingSynced',
            binding: { ...binding, captureId: 'capture-2' },
        })

        expect(next.boxes).toEqual([])
        expect(next.status).toBe('idle')
        expect(next.pendingRequestId).toBeNull()
    })

    it('refuses a reply whose envelope names a different capture', () => {
        const other: CaptureBinding = { ...binding, captureId: 'capture-9' }
        const state = localizationReducer(started(), {
            type: 'received',
            requestId: 'loc-1',
            result: { ...snapshot('loc-1', []), binding: other } as ApiResult<SegmentEvent>,
        })
        expect(state).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
    })
})
