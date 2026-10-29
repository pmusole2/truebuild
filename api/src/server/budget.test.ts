import { describe, expect, it } from 'vitest'

import { ModelCallCounter } from './budget'

describe('process model-call counter', (): void => {
    it('has no default cap, and an explicit cap never refunds admitted attempts', (): void => {
        const unlimited = new ModelCallCounter()
        for (let i = 0; i < 5_000; i += 1) unlimited.claim()
        expect(unlimited.used).toBe(5_000)
        const capped = new ModelCallCounter(200)
        for (let i = 0; i < 200; i += 1) {
            capped.claim()
        }
        expect(capped.used).toBe(200)
        expect(() => capped.claim()).toThrow('budget_exhausted')
        expect(capped.used).toBe(200)
    })

    it('admits at most the configured cap across competing asynchronous requests', async (): Promise<void> => {
        const counter = new ModelCallCounter(2)
        const attempts = await Promise.allSettled(
            Array.from({ length: 10 }, async (): Promise<void> => {
                await Promise.resolve()
                counter.claim()
            }),
        )
        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(2)
        expect(counter.used).toBe(2)
    })

    it.each([0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY])('rejects an invalid cap %s', (cap): void => {
        expect(() => new ModelCallCounter(cap)).toThrow('invalid_model_call_limit')
    })
})
