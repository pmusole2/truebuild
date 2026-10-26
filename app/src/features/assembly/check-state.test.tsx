import type { ApiResult, CaptureBinding, CheckResult } from '@truebuild/contracts'
import { canRunCheck, checkReducer, createCheckState, type CheckState } from './check-state'

const binding: CaptureBinding = {
    kind: 'capture',
    manualId: 'demo-divider',
    revision: 1,
    stepId: 'step-1',
    captureId: 'capture-1',
}

const passResult: CheckResult = {
    decision: 'pass',
    reason: 'Demo data — simulated results',
    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
    observedRegion: null,
    missingEvidence: [],
}

function okFor(requestBinding: CaptureBinding, requestId: string): ApiResult<CheckResult> {
    return { status: 'ok', requestId, mode: 'fixture', binding: requestBinding, value: passResult }
}

describe('checkReducer', () => {
    it('ignores a second start while a request is in flight', () => {
        const started = checkReducer(createCheckState(binding), { type: 'checkStarted', requestId: 'r1' })
        const again = checkReducer(started, { type: 'checkStarted', requestId: 'r2' })

        expect(again.pendingRequestId).toBe('r1')
        expect(canRunCheck(again, true)).toBe(false)
    })

    it('ignores a late reply for an earlier request', () => {
        const started = checkReducer(createCheckState(binding), { type: 'checkStarted', requestId: 'r2' })
        const late = checkReducer(started, {
            type: 'checkFinished',
            requestId: 'r1',
            binding,
            result: okFor(binding, 'r1'),
        })

        expect(late.result).toBeNull()
        expect(late.pendingRequestId).toBe('r2')
    })

    it('ignores a reply whose binding no longer matches the current capture', () => {
        const started = checkReducer(createCheckState(binding), { type: 'checkStarted', requestId: 'r1' })
        const corrected = checkReducer(started, {
            type: 'bindingSynced',
            binding: { ...binding, captureId: 'capture-2' },
        })
        const stale = checkReducer(corrected, {
            type: 'checkFinished',
            requestId: 'r1',
            binding,
            result: okFor(binding, 'r1'),
        })

        expect(stale.result).toBeNull()
    })

    it('accepts the current reply and then allows a fresh check', () => {
        const started = checkReducer(createCheckState(binding), { type: 'checkStarted', requestId: 'r1' })
        const finished = checkReducer(started, {
            type: 'checkFinished',
            requestId: 'r1',
            binding,
            result: okFor(binding, 'r1'),
        })

        expect(finished.result?.status).toBe('ok')
        expect(canRunCheck(finished, true)).toBe(true)
    })

    it('clears a verdict when the scenario or mode changes', () => {
        const finished = checkReducer(
            checkReducer(createCheckState(binding), { type: 'checkStarted', requestId: 'r1' }),
            { type: 'checkFinished', requestId: 'r1', binding, result: okFor(binding, 'r1') },
        )

        expect(checkReducer(finished, { type: 'scenarioChanged', scenario: 'wrong' }).result).toBeNull()
        expect(checkReducer(finished, { type: 'modeChanged', mode: 'model' }).result).toBeNull()
    })

    it('clears a verdict when the revision or capture identity changes', () => {
        const finished = checkReducer(
            checkReducer(createCheckState(binding), { type: 'checkStarted', requestId: 'r1' }),
            { type: 'checkFinished', requestId: 'r1', binding, result: okFor(binding, 'r1') },
        )
        const edited = checkReducer(finished, { type: 'bindingSynced', binding: { ...binding, revision: 2 } })

        expect(edited.result).toBeNull()
    })

    it('does not run an unreviewed step', () => {
        expect(canRunCheck(createCheckState(binding), false)).toBe(false)
    })
})

describe('checkReducer reply validation', () => {
    const started = (): CheckState => checkReducer(createCheckState(binding), { type: 'checkStarted', requestId: 'r1' })

    it('publishes a matching reply unchanged', () => {
        const finished = checkReducer(started(), {
            type: 'checkFinished',
            requestId: 'r1',
            binding,
            result: okFor(binding, 'r1'),
        })
        expect(finished.result).toEqual(okFor(binding, 'r1'))
    })

    it('replaces a reply that echoes another request id with a failed check, not a verdict', () => {
        const wrongId = checkReducer(started(), {
            type: 'checkFinished',
            requestId: 'r1',
            binding,
            result: okFor(binding, 'r9'),
        })
        expect(wrongId.result).toEqual({
            status: 'unavailable',
            requestId: 'r1',
            binding,
            code: 'invalid_output',
            retryable: false,
        })
        expect(wrongId.pendingRequestId).toBeNull()
    })

    it('rejects an ok reply for another capture binding', () => {
        const other: CaptureBinding = { ...binding, captureId: 'capture-9' }
        const wrongBinding = checkReducer(started(), {
            type: 'checkFinished',
            requestId: 'r1',
            binding,
            result: okFor(other, 'r1'),
        })
        expect(wrongBinding.result?.status).toBe('unavailable')
    })

    it('rejects an ok reply whose mode differs from the selected mode', () => {
        const modelReply: ApiResult<CheckResult> = {
            status: 'ok',
            requestId: 'r1',
            mode: 'model',
            binding,
            value: passResult,
        }
        const wrongMode = checkReducer(started(), {
            type: 'checkFinished',
            requestId: 'r1',
            binding,
            result: modelReply,
        })
        expect(wrongMode.result?.status).toBe('unavailable')
    })

    it('rejects an unavailable reply that names a different binding', () => {
        const other: CaptureBinding = { ...binding, stepId: 'step-2' }
        const unavailable: ApiResult<CheckResult> = {
            status: 'unavailable',
            requestId: 'r1',
            binding: other,
            code: 'invalid_input',
            retryable: false,
        }
        const wrong = checkReducer(started(), { type: 'checkFinished', requestId: 'r1', binding, result: unavailable })
        expect(wrong.result?.status).toBe('unavailable')
        expect(wrong.result).toEqual({
            status: 'unavailable',
            requestId: 'r1',
            binding,
            code: 'invalid_output',
            retryable: false,
        })
    })
})
