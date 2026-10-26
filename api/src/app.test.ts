import { describe, expect, it, vi } from 'vitest'

import { createApp } from './app'
import { createRuntimeFromEnvironment } from './server/model-runtime'

const binding = { kind: 'capture', manualId: 'demo-divider', revision: 1, stepId: 'step-1', captureId: 'capture-1' }
const payload = { mode: 'fixture', requestId: 'request-1', binding, scenario: 'correct' }

function app(environment: Record<string, string | undefined> = {}): ReturnType<typeof createApp> {
    return createApp({
        runtime: createRuntimeFromEnvironment({ API_SHARED_SECRET: 'truebuild-fixture-demo', ...environment }),
        onDuration: (): void => {},
    })
}

describe('Hono HTTP boundary', (): void => {
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
        expect(accepted.status).toBe(200)
        expect(await accepted.json()).toMatchObject({ mode: 'fixture' })
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
