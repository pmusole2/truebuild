import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeadline } from '../server/deadline'
import { MetaTransport, usageMetrics } from './meta-transport'

afterEach(() => vi.useRealTimers())

describe('absolute retry and model pacing boundaries', () => {
    it.each([
        ['seconds', '10'],
        ['overflow', '9'.repeat(400)],
    ])('does not dispatch a retry beyond the absolute deadline (%s)', async (_label, retryAfter) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        let calls = 0
        let cancelled = false
        const transport = new MetaTransport(async () => {
            calls++
            return new Response(
                new ReadableStream({
                    cancel: (): void => {
                        cancelled = true
                    },
                }),
                { status: 429, headers: { 'retry-after': retryAfter } },
            )
        })
        const deadline = createDeadline(2_000)
        try {
            const pending = transport.send('muse-spark-1.3', {}, deadline).then(
                () => 'unexpected_response',
                (error: unknown) => error,
            )
            await vi.advanceTimersByTimeAsync(2_001)
            expect(await pending).toMatchObject({ message: 'timeout' })
            expect(calls).toBe(1)
            expect(cancelled).toBe(true)
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
