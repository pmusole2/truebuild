import { describe, expect, it, vi } from 'vitest'

import { createApp } from './app'
import { createRuntimeFromEnvironment } from './server/model-runtime'
import { PublicLimitError, PublicModelCallCounter } from './server/public-limits'

const binding = { kind: 'capture', manualId: 'demo-divider', revision: 1, stepId: 'step-1', captureId: 'capture-1' }
const payload = { mode: 'fixture', requestId: 'request-1', binding, scenario: 'correct' }

function app(environment: Record<string, string | undefined> = {}): ReturnType<typeof createApp> {
    return createApp({
        runtime: createRuntimeFromEnvironment({
            PROVIDER_MODE: 'fixture',
            API_SHARED_SECRET: 'truebuild-fixture-demo',
            ...environment,
        }),
        onDuration: (): void => {},
    })
}

describe('Hono HTTP boundary', (): void => {
    it('allows cache-only motion reads after quota exhaustion without bypassing actual per-client claims', async () => {
        const runtime = createRuntimeFromEnvironment({
            PROVIDER_MODE: 'fixture',
            API_SHARED_SECRET: 'truebuild-fixture-demo',
            MODEL_CALL_LIMIT_PER_DAY: '1',
        })
        const api = createApp({ runtime, onDuration: (): void => {} })
        runtime.counter.claim()
        const form = new FormData()
        form.set(
            'metadata',
            JSON.stringify({
                requestId: 'cached-motion',
                manualHash: 'a'.repeat(64),
                stepId: 'step-1',
                readingLanguage: 'en',
                instructionText: 'Move the part.',
                sourceRefs: [{ pageId: 'page-1', region: null }],
                parts: [],
                actions: [],
                orientation: null,
                connection: null,
                page: { pageId: 'page-1', width: 1, height: 1, mimeType: 'image/png' },
                figureBox: null,
                cacheOnly: true,
            }),
        )
        const response = await api.request('/api/step-motion?cacheOnly=1', {
            method: 'POST',
            headers: { 'x-truebuild-key': 'truebuild-fixture-demo' },
            body: form,
        })
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ code: 'cache_miss' })
        expect(runtime.counter.used).toBe(1)

        const claim = vi.spyOn(runtime.counter, 'claim')
        const metadata: unknown = JSON.parse(String(form.get('metadata')))
        if (typeof metadata !== 'object' || metadata === null) throw new Error('Expected fixture metadata')
        form.set('metadata', JSON.stringify({ ...metadata, cacheOnly: false }))
        form.set('page:page-1', new File([new Uint8Array([0])], 'page.png', { type: 'image/png' }))
        const mismatched = await api.request('/api/step-motion?cacheOnly=1', {
            method: 'POST',
            headers: { 'x-truebuild-key': 'truebuild-fixture-demo' },
            body: form,
        })
        expect(mismatched.status).toBe(400)
        expect(await mismatched.json()).toMatchObject({ notDispatched: true })
        expect(claim).not.toHaveBeenCalled()
        expect(runtime.counter.used).toBe(1)

        const counter = new PublicModelCallCounter(10, 1)
        const request = new Request('http://localhost/api/step-motion?cacheOnly=1', {
            headers: { 'cf-connecting-ip': '192.0.2.1' },
        })
        counter.runForClient(request, false, () => counter.claim())
        expect(() => counter.runForClient(request, false, () => counter.claim(), true)).toThrow(PublicLimitError)
        expect(counter.used).toBe(1)
    })

    it('limits parses per client without locking out a different client', async (): Promise<void> => {
        const api = app({ MODEL_CALL_LIMIT: '8' })
        const parse = async (ip: string, forwarded = '198.51.100.9'): Promise<Response> =>
            api.request('/api/manuals/parse', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-truebuild-key': 'truebuild-fixture-demo',
                    'cf-connecting-ip': ip,
                    'x-forwarded-for': forwarded,
                },
                body: JSON.stringify({
                    mode: 'fixture',
                    requestId: 'parse-limit',
                    binding: { kind: 'manual', manualId: 'demo-divider', revision: 1 },
                }),
            })
        for (let attempt = 0; attempt < 10; attempt++) expect((await parse('192.0.2.1')).status).toBe(200)
        const limited = await parse('192.0.2.1', '198.51.100.10')
        expect(limited.status).toBe(429)
        expect(await limited.json()).toMatchObject({
            code: 'budget_exhausted',
            message: 'Too many builds right now, try again later.',
        })
        expect((await parse('192.0.2.2')).status).toBe(200)
    })

    it('serves the public privacy statement as HTML with no key or limits, even while the daily model cap is exhausted', async (): Promise<void> => {
        const runtime = createRuntimeFromEnvironment({
            PROVIDER_MODE: 'fixture',
            API_SHARED_SECRET: 'truebuild-fixture-demo',
            MODEL_CALL_LIMIT_PER_DAY: '1',
        })
        const api = createApp({ runtime, onDuration: (): void => {} })
        runtime.counter.claim()
        const exhausted = await api.request('/api/manuals/parse', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-truebuild-key': 'truebuild-fixture-demo' },
            body: JSON.stringify({
                mode: 'fixture',
                requestId: 'parse-capped',
                binding: { kind: 'manual', manualId: 'demo-divider', revision: 1 },
            }),
        })
        expect(exhausted.status).toBe(429)
        const privacy = await api.request('/privacy')
        expect(privacy.status).toBe(200)
        expect(privacy.headers.get('content-type')).toMatch(/^text\/html/)
        expect((await api.request('/privacy', { headers: { origin: 'https://store-review.example' } })).status).toBe(
            200,
        )
        const html = await privacy.text()
        for (const claim of [
            'Manual pages and photos from the app are sent to our server.',
            "Meta's AI models process them to create guides and checks.",
            'TrueBuild holds manual pages and photos in server memory only for session processing.',
            'Uploads are not saved to server disk.',
            'Closing the app does not immediately clear server caches.',
            'TrueBuild does not sell this data or use it for ads.',
            'No accounts and no advertising or analytics tracking.',
            'Temporary IP-based usage counters help prevent abuse.',
            'Dated 2 November 2026.',
            'pmusole2@gmail.com',
        ])
            expect(html).toContain(claim)
    })

    it('keeps both public health paths, exact JSON envelopes, and explicit method errors', async (): Promise<void> => {
        const api = app()
        for (const path of ['/health', '/api/health']) {
            const response = await api.request(path)
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                status: 'ok',
                fixture: 'available',
                live: 'unconfigured',
                label: 'Demo data — simulated results',
            })
        }
        for (const path of ['/api/checks', '/api/manuals/parse', '/api/questions', '/api/segments']) {
            expect((await api.request(path, { headers: { 'x-truebuild-key': 'truebuild-fixture-demo' } })).status).toBe(
                405,
            )
        }
        expect((await api.request('/missing')).status).toBe(404)
        expect((await api.request('/api/health', { method: 'POST' })).status).toBe(405)
    })

    it('refuses a missing shared header before reading a body and accepts native requests without Origin', async (): Promise<void> => {
        const api = app({ PROVIDER_MODE: 'meta', API_SHARED_SECRET: 'synthetic-local-test-value' })
        const request = new Request('http://localhost/api/checks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        })
        const read = vi.spyOn(request, 'json')
        const readMultipart = vi.spyOn(request, 'formData')
        const cancel = vi.spyOn(request.body!, 'cancel')
        const denied = await api.fetch(request)
        expect(denied.status).toBe(401)
        expect(read).not.toHaveBeenCalled()
        expect(readMultipart).not.toHaveBeenCalled()
        expect(cancel).toHaveBeenCalledOnce()
        const accepted = await api.request('/api/checks', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-truebuild-key': 'synthetic-local-test-value' },
            body: JSON.stringify(payload),
        })
        expect(accepted.status).toBe(503)
        expect(await accepted.json()).toMatchObject({ status: 'unavailable', code: 'unconfigured' })
    })

    it('requires the demo header for fixture JSON and never turns model intent into fixture success', async (): Promise<void> => {
        const api = app()
        const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('outbound forbidden'))
        const response = await api.request('/api/checks', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-truebuild-key': 'truebuild-fixture-demo' },
            body: JSON.stringify(payload),
        })
        expect(await response.json()).toMatchObject({ status: 'ok', mode: 'fixture' })
        const model = await api.request('/api/checks', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-truebuild-key': 'truebuild-fixture-demo' },
            body: JSON.stringify({ ...payload, mode: 'model' }),
        })
        expect(model.status).toBe(503)
        const form = new FormData()
        form.set('metadata', JSON.stringify({ ...payload, mode: 'model' }))
        const multipart = await api.request('/api/checks', {
            method: 'POST',
            headers: { 'x-truebuild-key': 'truebuild-fixture-demo' },
            body: form,
        })
        expect(multipart.status).toBe(503)
        expect(await multipart.json()).toMatchObject({ code: 'unconfigured' })
        expect(outbound).not.toHaveBeenCalled()
    })

    it('supports configured deployed origins, denies foreign origins and only permits the shared header', async (): Promise<void> => {
        const api = app({ CORS_ORIGINS: 'https://deployed.example' })
        for (const origin of ['http://localhost:8081', 'http://127.0.0.1:8081', 'https://deployed.example']) {
            const preflight = await api.request('/api/checks', {
                method: 'OPTIONS',
                headers: {
                    origin,
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'content-type, x-truebuild-key',
                },
            })
            expect(preflight.status).toBe(204)
            expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
            expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type, X-TrueBuild-Key')
        }
        const foreignPreflight = await api.request('/api/session', {
            method: 'OPTIONS',
            headers: { origin: 'https://foreign.example', 'access-control-request-method': 'GET' },
        })
        expect(foreignPreflight.status).toBe(401)
        expect(await foreignPreflight.json()).toEqual({
            status: 'unavailable',
            requestId: 'invalid-request',
            binding: null,
            code: 'unauthorized',
            retryable: false,
        })
        const denied = await api.request('/api/checks', {
            method: 'POST',
            headers: { origin: 'https://foreign.example' },
            body: '{',
        })
        expect(denied.status).toBe(403)
        expect(denied.headers.has('access-control-allow-origin')).toBe(false)
        expect(
            (
                await api.request('/api/checks', {
                    method: 'OPTIONS',
                    headers: { 'access-control-request-headers': 'authorization' },
                })
            ).status,
        ).toBe(401)
    })

    it('preserves the authenticated session success shape with process-stable compatibility metadata', async (): Promise<void> => {
        const api = app({ API_SHARED_SECRET: 'synthetic-local-test-value' })
        const denied = await api.request('/api/session')
        expect(denied.status).toBe(401)
        expect(await denied.json()).toEqual({ status: 'unavailable', code: 'unauthorized' })
        const init = { headers: { 'x-truebuild-key': 'synthetic-local-test-value' } }
        const first = await (await api.request('/api/session', init)).json()
        const second = await (await api.request('/api/session', init)).json()
        expect(first).toEqual({
            status: 'ok',
            runId: expect.any(String),
            expiresAt: Number.MAX_SAFE_INTEGER,
            model: 'unconfigured',
            providerMode: 'fixture',
            sparkModel: 'muse-spark-1.3',
            parseModel: 'muse-spark-1.3',
            samModel: 'sam-3.1',
            checkContext: 'full',
            secondOpinionModel: 'muse-wonder-1.0',
            aiPolicy: expect.objectContaining({ generativeUi: 'full' }),
            followUps: { overlay: true, segments: true },
            capabilities: { pieceFigureBox: true },
            screensV2: { documentVersion: 2, catalogVersion: 2, route: '/api/screens/v2' },
        })
        expect(second).toEqual(first)
        expect((await app({ API_SHARED_SECRET: undefined }).request('/api/session')).status).toBe(401)
        const options = await api.request('/api/session', {
            method: 'OPTIONS',
            headers: { 'access-control-request-method': 'GET' },
        })
        expect(options.status).toBe(204)
    })

    it('reports only numeric durations to the timing sink', async (): Promise<void> => {
        const duration = vi.fn<(milliseconds: number) => void>()
        const api = createApp({ runtime: createRuntimeFromEnvironment({}), onDuration: duration })
        await api.request('/api/health')
        expect(duration).toHaveBeenCalledWith(expect.any(Number))
        expect(duration.mock.calls[0]).toHaveLength(1)
    })
})
