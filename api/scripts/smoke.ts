/** Local-only fixture smoke. Creates its own ephemeral loopback listener; public demo header only; no model key or external base URL. */
import assert from 'node:assert/strict'

import { serve } from '@hono/node-server'
import { apiResultSchema, checkResultSchema, parsedManualSchema, questionResultSchema } from '@truebuild/contracts'
import type { z } from 'zod'

import { createApp } from '../src/app'
import { segmentResultSchema } from '../src/providers/types'
import { createRuntimeFromEnvironment } from '../src/server/model-runtime'

const app = createApp({
    runtime: createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: 'truebuild-fixture-demo' }),
    onDuration: (): void => {},
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
try {
    if (!server.listening) {
        await new Promise<void>((resolve, reject): void => {
            server.once('listening', resolve)
            server.once('error', reject)
        })
    }
    const address = server.address()
    assert(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    let assertions = 0
    async function send(path: string, init?: RequestInit): Promise<Response> {
        const response = await fetch(`${base}${path}`, {
            ...init,
            headers: { 'x-truebuild-key': 'truebuild-fixture-demo', ...Object.fromEntries(new Headers(init?.headers)) },
            signal: AbortSignal.timeout(5_000),
        })
        assertions += 1
        return response
    }
    const manual = { kind: 'manual', manualId: 'demo-divider', revision: 1 }
    const capture = { kind: 'capture', manualId: 'demo-divider', revision: 1, stepId: 'step-1', captureId: 'capture-1' }
    for (const [headers, status] of [
        [{ 'x-truebuild-key': '' }, 401],
        [{ origin: 'https://foreign.example' }, 403],
    ] as const) {
        const denied = await send('/api/checks', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: '{}',
        })
        assert.equal(denied.status, status)
        assert.equal((await denied.json()).code, 'unauthorized')
    }
    for (const path of ['/health', '/api/health']) {
        const response = await send(path)
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), {
            status: 'ok',
            fixture: 'available',
            live: 'unconfigured',
            label: 'Demo data — simulated results',
        })
    }
    async function fixture(path: string, body: Record<string, unknown>, value: z.ZodType): Promise<void> {
        const response = await send(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
        assert.equal(response.status, 200)
        const result = apiResultSchema(value).parse(await response.json())
        assert.equal(result.status, 'ok')
        if (result.status === 'ok') {
            assert.equal(result.mode, 'fixture')
            assert.deepEqual(result.binding, body.binding)
            assert.equal(result.requestId, body.requestId)
        }
    }
    await fixture('/api/manuals/parse', { mode: 'fixture', requestId: 'parse-1', binding: manual }, parsedManualSchema)
    await fixture(
        '/api/checks',
        {
            mode: 'fixture',
            requestId: 'check-1',
            binding: capture,
            scenario: 'correct',
        },
        checkResultSchema,
    )
    await fixture(
        '/api/questions',
        {
            mode: 'fixture',
            requestId: 'question-1',
            binding: capture,
            question: 'Where?',
            target: { kind: 'point', x: 0.4, y: 0.5 },
        },
        questionResultSchema,
    )
    await fixture('/api/segments', { mode: 'fixture', requestId: 'segment-1', binding: capture }, segmentResultSchema)
    assert.equal((await send('/api/checks')).status, 405)
    assert.equal(
        (
            await send('/api/checks', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{',
            })
        ).status,
        400,
    )
    const model = await send('/api/checks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'model', requestId: 'model-1', binding: capture, scenario: 'correct' }),
    })
    assert.equal(model.status, 503)
    assert.deepEqual(await model.json(), {
        status: 'unavailable',
        requestId: 'model-1',
        binding: capture,
        code: 'unconfigured',
        retryable: false,
    })
    const options = await send('/api/checks', {
        method: 'OPTIONS',
        headers: {
            origin: 'http://localhost:8081',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'Content-Type, X-TrueBuild-Key',
        },
    })
    assert.equal(options.status, 204)
    assert.equal(options.headers.get('access-control-allow-headers'), 'Content-Type, X-TrueBuild-Key')
    console.info(`Local fixture smoke passed: ${assertions} HTTP requests; no model key or external dispatch.`)
} finally {
    await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error ? reject(error) : resolve()))
        if ('closeAllConnections' in server) {
            server.closeAllConnections()
        }
    })
}
