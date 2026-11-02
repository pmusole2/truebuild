import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeadline } from '../server/deadline'
import { MetaTransport, usageMetrics } from './meta-transport'

afterEach(() => vi.useRealTimers())

describe('absolute retry and model pacing boundaries', () => {
    it('separates pacing and retry backoff from time on the network, and observes nothing when not asked', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        const delays = [40, 30]
        let call = 0
        const transport = new MetaTransport(async () => {
            const index = call++
            await new Promise((resolve) => setTimeout(resolve, delays[index]))
            return index === 0
                ? new Response('busy', { status: 429, headers: { 'retry-after': '1' } })
                : Response.json({})
        })
        const observation = { paceWaitMs: 0, networkMs: 0 }
        const deadline = createDeadline(20_000)
        try {
            const pending = transport.send('muse-spark-1.3', {}, deadline, undefined, 3, observation)
            await vi.advanceTimersByTimeAsync(3_000)
            expect((await pending).status).toBe(200)
            // 40 ms + 30 ms on the network; the one-second Retry-After wait is pacing, not provider time.
            expect(observation.networkMs).toBeCloseTo(70, -1)
            expect(observation.paceWaitMs).toBeGreaterThanOrEqual(1_000)
            expect(observation.paceWaitMs).toBeLessThan(1_300)
            const unobserved = transport.send('muse-wonder-1.0', {}, deadline)
            await vi.advanceTimersByTimeAsync(3_000)
            expect((await unobserved).status).toBeGreaterThan(0)
        } finally {
            deadline.dispose()
        }
    })
    it('paces exhausted token/request headers per model without delaying SAM', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        let calls = 0
        const transport = new MetaTransport(async () => {
            calls++
            return Response.json(
                {},
                {
                    headers: {
                        'x-ratelimit-limit-requests': '3000',
                        'x-ratelimit-remaining-requests': '0',
                        'x-ratelimit-limit-tokens': '4000000',
                        'x-ratelimit-remaining-tokens': '0',
                    },
                },
            )
        })
        const first = createDeadline(100)
        const second = createDeadline(100)
        const sam = createDeadline(100)
        try {
            await (await transport.send('muse-spark-1.3', {}, first)).body?.cancel()
            const pending = expect(transport.send('muse-spark-1.3', {}, second)).rejects.toThrow('timeout')
            await (await transport.send('sam-3.1', {}, sam)).body?.cancel()
            await vi.advanceTimersByTimeAsync(101)
            await pending
            expect(calls).toBe(2)
        } finally {
            first.dispose()
            second.dispose()
            sam.dispose()
        }
    })
    it('emits only numeric usage subsets without model text or provider error data', () => {
        expect(
            usageMetrics({
                usage: {
                    input_tokens: 100,
                    input_tokens_details: { cached_tokens: 40 },
                    output_tokens: 20,
                    output_tokens_details: { reasoning_tokens: 5 },
                    private: 'secret',
                },
                error: 'secret',
            }),
        ).toEqual({ inputTokens: 100, cachedTokens: 40, outputTokens: 20, reasoningTokens: 5 })
        expect(usageMetrics({ usage: { input_tokens: 'secret', output_tokens: -1 } })).toEqual({
            inputTokens: undefined,
            cachedTokens: undefined,
            outputTokens: undefined,
            reasoningTokens: undefined,
        })
    })
})
