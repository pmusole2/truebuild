import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoManual, OVERLAY_JOB_IO_FIXTURES, type CaptureBinding } from '@truebuild/contracts'
import { ModelApiClient, type ImageBytes, type ModelFetch } from './model-client'

const session = { ...createDemoManual(), manualId: 'fixture-manual' }
const binding: CaptureBinding = {
    kind: 'capture',
    manualId: session.manualId,
    revision: 1,
    stepId: 'step-1',
    captureId: 'capture-1',
}
const image: ImageBytes = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', width: 4, height: 3 }
const source: ImageBytes = { ...image, width: session.pages[0]!.width, height: session.pages[0]!.height }
const requestId = 'overlay-fixture-1'
const start = (fetch: ModelFetch, signal?: AbortSignal): ReturnType<ModelApiClient['overlay']> =>
    new ModelApiClient({
        baseUrl: 'http://127.0.0.1:3001',
        secret: 'public-fixture-key',
        fetch,
    }).overlay(binding, session, ['demo-page-1'], [source], image, 'one-use-token', { requestId, signal })

afterEach(() => vi.useRealTimers())

describe('overlay collection through the real client', () => {
    it('rejects a model envelope that falsely labels synthetic overlay IO as live', async () => {
        const response = OVERLAY_JOB_IO_FIXTURES.success.responses[0].body
        const fetch = vi.fn<ModelFetch>(async () => Response.json({ ...response, mode: 'model' }))
        expect(await start(fetch)).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it.each(['success', 'stale', 'replay'] as const)(
        'accepts terminal fixture %s without collecting or replaying',
        async (scenario) => {
            const response = OVERLAY_JOB_IO_FIXTURES[scenario].responses[0]
            const fetch = vi.fn<ModelFetch>(async () => Response.json(response.body, { status: response.status }))
            const result = await start(fetch)
            expect(result.status).toBe(scenario === 'success' ? 'ok' : 'unavailable')
            expect(fetch).toHaveBeenCalledTimes(1)
            expect(new URL(fetch.mock.calls[0]![0]).pathname).toBe('/api/checks/overlay')
        },
    )

    it('collects the late fixture by exact original identity without resending photo or token', async () => {
        vi.useFakeTimers()
        const responses = [...OVERLAY_JOB_IO_FIXTURES.late.responses]
        const fetch = vi.fn<ModelFetch>(async () => {
            const next = responses.shift()!
            return Response.json(next.body, { status: next.status })
        })
        const pending = start(fetch)
        await vi.advanceTimersByTimeAsync(3_100)
        expect(await pending).toMatchObject({ status: 'ok', mode: 'fixture', value: { evidence: 'synthetic-fixture' } })
        expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            '/api/checks/overlay',
            '/api/checks/overlay/result',
            '/api/checks/overlay/result',
        ])
        for (const [, init] of fetch.mock.calls.slice(1)) {
            expect(typeof init.body).toBe('string')
            expect(JSON.parse(String(init.body))).toEqual({
                mode: 'model',
                requestId,
                binding,
                ticket: 'fixture-ticket-1',
            })
            expect(String(init.body)).not.toContain('one-use-token')
            expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
            expect(init.headers).toMatchObject({
                'x-truebuild-key': 'public-fixture-key',
                'content-type': 'application/json',
            })
        }
    })

    it('returns collected timeout quietly and never redispatches the original effect', async () => {
        vi.useFakeTimers()
        const responses = [...OVERLAY_JOB_IO_FIXTURES.timeout.responses]
        const fetch = vi.fn<ModelFetch>(async () => {
            const next = responses.shift()!
            return Response.json(next.body, { status: next.status })
        })
        const pending = start(fetch)
        await vi.advanceTimersByTimeAsync(1_600)
        expect(await pending).toMatchObject({ status: 'unavailable', code: 'timeout', retryable: false })
        expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('cancels the original ticket once on caller abort without resending its photo', async () => {
        vi.useFakeTimers()
        const abort = new AbortController()
        const first = OVERLAY_JOB_IO_FIXTURES.late.responses[0]
        const fetch = vi.fn<ModelFetch>(async (url) =>
            new URL(url).pathname.endsWith('/cancel')
                ? new Response(null, { status: 204 })
                : Response.json(first.body, { status: 202 }),
        )
        const pending = start(fetch, abort.signal)
        await vi.advanceTimersByTimeAsync(0)
        abort.abort()
        expect(await pending).toMatchObject({ status: 'unavailable' })
        await vi.advanceTimersByTimeAsync(0)
        expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            '/api/checks/overlay',
            '/api/checks/overlay/cancel',
        ])
        const cancel = fetch.mock.calls[1]![1]
        expect(typeof cancel.body).toBe('string')
        expect(JSON.parse(String(cancel.body))).toEqual({
            mode: 'model',
            requestId,
            binding,
            ticket: 'fixture-ticket-1',
        })
        expect(String(cancel.body)).not.toContain('observation')
        expect(cancel.headers).toMatchObject({ 'content-type': 'application/json' })
    })

    it('refuses a changed ticket or binding and never adopts a foreign collection identity', async () => {
        vi.useFakeTimers()
        for (const patch of [{ ticket: 'foreign-ticket' }, { binding: { ...binding, captureId: 'foreign-capture' } }]) {
            let calls = 0
            const original = OVERLAY_JOB_IO_FIXTURES.late.responses[0].body
            const fetch = vi.fn<ModelFetch>(async (url) => {
                if (new URL(url).pathname.endsWith('/cancel')) return new Response(null, { status: 204 })
                return Response.json(calls++ === 0 ? original : { ...original, ...patch }, { status: 202 })
            })
            const pending = start(fetch)
            await vi.advanceTimersByTimeAsync(1_600)
            expect(await pending).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
            expect(fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/checks/overlay')).toHaveLength(1)
            expect(
                fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/checks/overlay/result'),
            ).toHaveLength(1)
            expect(
                fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/checks/overlay/cancel'),
            ).toHaveLength(1)
        }
    })

    it('never extends the first ticket expiry and discards late success after a caller checkpoint becomes stale', async () => {
        vi.useFakeTimers()
        const first = OVERLAY_JOB_IO_FIXTURES.late.responses[0].body
        const fetch = vi.fn<ModelFetch>(async (url) =>
            new URL(url).pathname.endsWith('/cancel')
                ? new Response(null, { status: 204 })
                : Response.json({ ...first, expiresInMs: 1_000 }, { status: 202 }),
        )
        const pending = start(fetch)
        await vi.advanceTimersByTimeAsync(6_100)
        expect(await pending).toMatchObject({ status: 'unavailable', code: 'timeout', retryable: false })
        expect(fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/checks/overlay')).toHaveLength(1)
        expect(fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/checks/overlay/result')).toHaveLength(
            3,
        )
        expect(fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/checks/overlay/cancel')).toHaveLength(
            1,
        )

        let stale = false
        const responses = [...OVERLAY_JOB_IO_FIXTURES.late.responses]
        const late = vi.fn<ModelFetch>(async (url) => {
            if (new URL(url).pathname.endsWith('/cancel')) return new Response(null, { status: 204 })
            const next = responses.shift()!
            if (next.status === 200) stale = true
            return Response.json(next.body, { status: next.status })
        })
        const result = new ModelApiClient({
            baseUrl: 'http://127.0.0.1:3001',
            secret: 'public-fixture-key',
            fetch: late,
        }).overlay(binding, session, ['demo-page-1'], [source], image, 'one-use-token', {
            requestId,
            checkpoint: (): void => {
                if (stale) throw new Error('stale_capture')
            },
        })
        await vi.advanceTimersByTimeAsync(3_100)
        expect(await result).toMatchObject({ status: 'unavailable' })
        expect(late.mock.calls.filter(([url]) => new URL(url).pathname === '/api/checks/overlay')).toHaveLength(1)
    })
})
