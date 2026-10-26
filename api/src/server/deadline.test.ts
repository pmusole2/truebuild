import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDeadline, RequestStoppedError } from './deadline'

afterEach((): void => {
    vi.restoreAllMocks()
})

describe('absolute request deadline', (): void => {
    it('rejects invalid budgets', (): void => {
        for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 30_001]) {
            expect(() => createDeadline(value)).toThrow('invalid_timeout')
        }
    })

    it('stops a pre-aborted parent before work and retains cancellation', (): void => {
        const parent = new AbortController()
        parent.abort('private caller data')
        const deadline = createDeadline(8_000, parent.signal)
        expect(deadline.signal.aborted).toBe(true)
        expect(() => deadline.checkpoint()).toThrow('cancelled')
        deadline.dispose()
        expect(() => deadline.checkpoint()).toThrow('cancelled')
    })

    it('propagates inflight cancellation without exposing parent reasons', (): void => {
        const parent = new AbortController()
        const deadline = createDeadline(8_000, parent.signal)
        parent.abort('secret')
        expect(deadline.signal.reason).toBeInstanceOf(RequestStoppedError)
        expect(deadline.signal.reason.message).toBe('cancelled')
        expect(() => deadline.checkpoint()).toThrow('cancelled')
        deadline.dispose()
    })

    it('refuses late success when the event loop has not run the timer', (): void => {
        let monotonic = 100
        vi.spyOn(performance, 'now').mockImplementation((): number => monotonic)
        const deadline = createDeadline(8_000)
        monotonic = 8_100
        expect(deadline.signal.aborted).toBe(false)
        expect(() => deadline.checkpoint()).toThrow('timeout')
        expect(deadline.signal.aborted).toBe(true)
        monotonic = 100
        expect(() => deadline.checkpoint()).toThrow('timeout')
        deadline.dispose()
    })

    it('disposes timer/listener and forbids reusing a disposed deadline', (): void => {
        const parent = new AbortController()
        const remove = vi.spyOn(parent.signal, 'removeEventListener')
        const deadline = createDeadline(30_000, parent.signal)
        deadline.checkpoint()
        deadline.dispose()
        deadline.dispose()
        expect(remove).toHaveBeenCalledOnce()
        expect(() => deadline.checkpoint()).toThrow('cancelled')
    })
})
