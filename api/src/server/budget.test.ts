import { describe, expect, it } from 'vitest'

import { ModelCallCounter } from './budget'

describe('process model-call counter', (): void => {
    it('defaults to 200 and never refunds admitted attempts', (): void => {
        const counter = new ModelCallCounter()
        for (let i = 0; i < 200; i += 1) {
            counter.claim()
        }
        expect(counter.used).toBe(200)
        expect(() => counter.claim()).toThrow('budget_exhausted')
        expect(counter.used).toBe(200)
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

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid cap %s', (cap): void => {
        expect(() => new ModelCallCounter(cap)).toThrow('invalid_model_call_limit')
    })
})
