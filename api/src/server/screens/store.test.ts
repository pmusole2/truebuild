import { describe, expect, it } from 'vitest'

import { ConcurrencyGate } from '../budget'
import { PrecomputeRegistry, ScreenCache, SingleFlight, StaleGuard, StaleRevisionError } from './store'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('screen cache', (): void => {
    it('expires entries and evicts the least recently used one', (): void => {
        let now = 0
        const cache = new ScreenCache<string>(2, 100, () => now)
        cache.set('a', 'A')
        cache.set('b', 'B')
        expect(cache.get('a')).toBe('A')
        cache.set('c', 'C')
        expect(cache.get('b')).toBeUndefined()
        now = 100
        expect(cache.get('a')).toBeUndefined()
        expect(cache.size).toBe(1)
    })
})

describe('single flight', (): void => {
    it('shares one computation across concurrent waiters', async (): Promise<void> => {
        const flights = new SingleFlight<number>()
        let starts = 0
        const start = async (): Promise<number> => {
            starts += 1
            await tick()
            return 7
        }
        expect(await Promise.all([flights.run('k', start), flights.run('k', start), flights.run('k', start)])).toEqual([
            7, 7, 7,
        ])
        expect(starts).toBe(1)
        expect(flights.active).toBe(0)
        await flights.run('k', start)
        expect(starts).toBe(2)
    })

    it('stops the computation only when the last waiter leaves, and does not cache a failure', async (): Promise<void> => {
        const flights = new SingleFlight<number>()
        let signal: AbortSignal | undefined
        const start = (s: AbortSignal): Promise<number> => {
            signal = s
            return new Promise<number>((_resolve, reject) =>
                s.addEventListener('abort', () => reject(new Error('aborted'))),
            )
        }
        const one = new AbortController()
        const two = new AbortController()
        const first = flights.run('k', start, one.signal)
        const second = flights.run('k', start, two.signal)
        one.abort(new Error('left'))
        await expect(first).rejects.toThrow('left')
        expect(signal?.aborted).toBe(false)
        two.abort(new Error('left too'))
        await expect(second).rejects.toThrow('left too')
        expect(signal?.aborted).toBe(true)
        await tick()
        expect(flights.active).toBe(0)
        expect(await flights.run('k', async () => 9)).toBe(9)
    })

    it('never starts work for, or holds a waiter count on behalf of, an already-aborted waiter', async (): Promise<void> => {
        const flights = new SingleFlight<number>()
        const gone = new AbortController()
        gone.abort(new Error('already gone'))
        let starts = 0
        await expect(
            flights.run(
                'k',
                async () => {
                    starts += 1
                    return 1
                },
                gone.signal,
            ),
        ).rejects.toThrow('already gone')
        expect(starts).toBe(0)
        expect(flights.active).toBe(0)
        // Joining a live flight with a dead waiter must not leak a count that would keep the flight alive.
        let signal: AbortSignal | undefined
        const live = new AbortController()
        const running = flights.run(
            'k',
            (s) => {
                signal = s
                return new Promise<number>((_resolve, reject) =>
                    s.addEventListener('abort', () => reject(new Error('stopped'))),
                )
            },
            live.signal,
        )
        await expect(flights.run('k', async () => 2, gone.signal)).rejects.toThrow('already gone')
        live.abort(new Error('left'))
        await expect(running).rejects.toThrow('left')
        expect(signal?.aborted).toBe(true)
    })
})

describe('stale revisions', (): void => {
    it('cancels older work when a newer revision is observed and reports older revisions stale', (): void => {
        const guard = new StaleGuard()
        const old = new AbortController()
        const current = new AbortController()
        expect(guard.observe('m', 1)).toBe(true)
        guard.register('m', 1, old)
        guard.register('m', 2, current)
        expect(guard.observe('m', 2)).toBe(true)
        expect(old.signal.aborted).toBe(true)
        expect(old.signal.reason).toBeInstanceOf(StaleRevisionError)
        expect(current.signal.aborted).toBe(false)
        expect(guard.observe('m', 1)).toBe(false)
        expect(guard.observe('other', 1)).toBe(true)
    })

    it('registers atomically: work for an older revision is aborted at once and work registered earlier is cancelled', (): void => {
        const guard = new StaleGuard()
        // Registered before it waits for capacity, then a newer revision is observed while it waits.
        const waiting = new AbortController()
        guard.register('m', 1, waiting)
        expect(waiting.signal.aborted).toBe(false)
        guard.observe('m', 2)
        expect(waiting.signal.aborted).toBe(true)
        expect(waiting.signal.reason).toBeInstanceOf(StaleRevisionError)
        // Registering for a revision that is already superseded never runs.
        const late = new AbortController()
        guard.register('m', 1, late)()
        expect(late.signal.aborted).toBe(true)
        expect(late.signal.reason).toBeInstanceOf(StaleRevisionError)
    })
})

describe('precompute registry', (): void => {
    const steps = [3, 1, 2].map((order) => ({ stepId: `s${order}`, order, key: `k${order}` }))
    const input = (
        revision: number,
        focusStepId: string | null = null,
    ): Parameters<PrecomputeRegistry['start']>[0] => ({
        manualId: 'm',
        revision,
        contextKey: 'c'.repeat(64),
        mode: 'full' as const,
        steps,
        focusStepId,
    })

    it('runs the focused step first, then manual order, within the concurrency bound', async (): Promise<void> => {
        const registry = new PrecomputeRegistry(1)
        const order: string[] = []
        let running = 0
        let peak = 0
        const progress = registry.start(input(1, 's3'), async (stepId) => {
            order.push(stepId)
            running += 1
            peak = Math.max(peak, running)
            await tick()
            running -= 1
            return { state: 'ready', screenId: `doc-${stepId}` }
        })
        expect(progress.steps.map((step) => step.stepId)).toEqual(['s1', 's2', 's3'])
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(order).toEqual(['s3', 's1', 's2'])
        expect(peak).toBe(1)
        expect(registry.progress('m', 1)?.steps.every((step) => step.state === 'ready')).toBe(true)
        expect(registry.keyOf('m', 1, 's2')).toBe('k2')
    })

    it('lets the first steps finish before the rest while later ones are still queued', async (): Promise<void> => {
        const registry = new PrecomputeRegistry(1)
        const releases: (() => void)[] = []
        registry.start(
            input(1),
            (stepId) => new Promise((resolve) => releases.push(() => resolve({ state: 'ready', screenId: stepId }))),
        )
        await tick()
        releases.shift()?.()
        await tick()
        const states = registry.progress('m', 1)!.steps.map((step) => step.state)
        expect(states).toEqual(['ready', 'running', 'queued'])
        expect(registry.keyOf('m', 1, 's1')).toBe('k1')
        expect(registry.keyOf('m', 1, 's3')).toBeNull()
    })

    it('cancels the older revision when a newer one starts, and an explicit cancel stops queued work', async (): Promise<void> => {
        const registry = new PrecomputeRegistry(1)
        const signals: AbortSignal[] = []
        registry.start(input(1), (_stepId, signal) => {
            signals.push(signal)
            return new Promise(() => {})
        })
        await tick()
        registry.start(input(2), async () => ({ state: 'ready', screenId: null }))
        expect(signals[0]?.aborted).toBe(true)
        expect(registry.progress('m', 1)).toBeNull()
        const hanging: AbortSignal[] = []
        registry.start({ ...input(3), manualId: 'n' }, (_stepId, signal) => {
            hanging.push(signal)
            return new Promise(() => {})
        })
        await tick()
        registry.cancel('n', 3, true)
        expect(hanging[0]?.aborted).toBe(true)
        expect(registry.progress('n', 3)?.steps.map((step) => step.state)).toEqual([
            'cancelled',
            'cancelled',
            'cancelled',
        ])
    })
})

describe('concurrency gate', (): void => {
    it('fails fast for foreground work and makes background work wait its turn', async (): Promise<void> => {
        const gate = new ConcurrencyGate(1)
        const release = gate.tryAcquire()
        expect(release).not.toBeNull()
        expect(gate.tryAcquire()).toBeNull()
        const waiting = gate.acquire(new AbortController().signal)
        let acquired = false
        void waiting.then(() => {
            acquired = true
        })
        await tick()
        expect(acquired).toBe(false)
        release?.()
        release?.()
        const next = await waiting
        expect(gate.active).toBe(1)
        next()
        expect(gate.active).toBe(0)
    })

    it('keeps reserved slots for foreground work, so background work cannot starve a verdict', async (): Promise<void> => {
        const gate = new ConcurrencyGate(4, 1)
        const background = [1, 2, 3].map(() => gate.tryAcquire({ background: true }))
        expect(background.every((release) => release !== null)).toBe(true)
        // The last slot is reserved: background gets none, foreground still does.
        expect(gate.tryAcquire({ background: true })).toBeNull()
        const waiting = gate.acquire(new AbortController().signal)
        let acquired = false
        void waiting.then(() => {
            acquired = true
        })
        const verdict = gate.tryAcquire()
        expect(verdict).not.toBeNull()
        expect(gate.tryAcquire()).toBeNull()
        verdict?.()
        await tick()
        expect(acquired).toBe(false)
        background[0]?.()
        await tick()
        expect(acquired).toBe(true)
        expect(() => new ConcurrencyGate(2, 2)).toThrow('invalid_concurrency_reserve')
        expect(new ConcurrencyGate(1).reserved).toBe(0)
        expect(new ConcurrencyGate(32).reserved).toBe(8)
    })

    it('stops waiting when the signal aborts', async (): Promise<void> => {
        const gate = new ConcurrencyGate(1)
        gate.tryAcquire()
        const controller = new AbortController()
        const waiting = gate.acquire(controller.signal)
        controller.abort(new Error('cancelled'))
        await expect(waiting).rejects.toThrow('cancelled')
    })
})
