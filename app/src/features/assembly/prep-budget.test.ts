import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beforeDispatch } from './prep-budget'

describe('beforeDispatch', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('returns the prepared value when it settles inside the budget', async () => {
        const outcome = await beforeDispatch(undefined, 8000, () => Promise.resolve('ready'))

        expect(outcome).toEqual({ ok: true, value: 'ready' })
    })

    it('stops at caller cancellation even when the preparation promise never settles', async () => {
        const caller = new AbortController()
        const pending = beforeDispatch(caller.signal, 8000, () => new Promise<string>(() => undefined))

        caller.abort()

        await expect(pending).resolves.toEqual({ ok: false, reason: 'caller' })
    })

    it('stops at the action budget when preparation never settles', async () => {
        const pending = beforeDispatch(undefined, 8000, () => new Promise<string>(() => undefined))

        await vi.advanceTimersByTimeAsync(8001)

        await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' })
    })

    it('drops a preparation that resolves after the budget instead of dispatching it', async () => {
        let release: (value: string) => void = () => undefined
        const pending = beforeDispatch(undefined, 8000, () => new Promise<string>((resolve) => (release = resolve)))

        await vi.advanceTimersByTimeAsync(8001)
        release('late')

        await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' })
    })

    it('does not start preparation at all when the caller has already cancelled', async () => {
        const caller = new AbortController()
        caller.abort()
        const prepare = vi.fn(() => Promise.resolve('never'))

        const outcome = await beforeDispatch(caller.signal, 8000, prepare)

        expect(outcome).toEqual({ ok: false, reason: 'caller' })
        expect(prepare).not.toHaveBeenCalled()
    })

    it('rejects monotonic expiry even before the timer callback runs', async () => {
        let now = 100
        vi.spyOn(performance, 'now').mockImplementation((): number => now)
        const outcome = await beforeDispatch(undefined, 8000, async (): Promise<string> => {
            now += 8001
            return 'late'
        })

        expect(outcome).toEqual({ ok: false, reason: 'timeout' })
    })

    it('classifies a failed preparation as invalid input rather than a timeout', async () => {
        const outcome = await beforeDispatch(undefined, 8000, async (): Promise<string> => {
            throw new Error('Synthetic preparation failure')
        })

        expect(outcome).toEqual({ ok: false, reason: 'invalid_input' })
    })
})
