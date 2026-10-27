import { once } from 'node:events'

import { serve } from '@hono/node-server'
import type { SegmentEvent } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app'
import type { SamProvider } from '../providers/sam'
import { createRuntimeFromEnvironment } from './model-runtime'
import { createModelHandlers } from './model-service'

const demoKey = 'truebuild-fixture-demo'

describe('Node adapter cancellation', (): void => {
    it('propagates an HTTP consumer disconnect to the model generator without refund or retry', async (): Promise<void> => {
        const runtime = createRuntimeFromEnvironment({ API_SHARED_SECRET: demoKey })
        let providerSignal: AbortSignal | undefined
        let calls = 0
        let release = (): void => {}
        const returned = new Promise<void>((resolve): void => {
            release = resolve
        })
        const samProvider: SamProvider = {
            async *segment(input, signal): AsyncGenerator<SegmentEvent> {
                calls += 1
                providerSignal = signal
                try {
                    yield {
                        type: 'snapshot',
                        snapshot: {
                            binding: input.binding,
                            capturedAt: input.capturedAt,
                            streamId: 'local-stream',
                            frameIndex: 0,
                            records: [],
                            complete: false,
                        },
                    }
                    if (!signal?.aborted) {
                        await new Promise<void>((resolve): void => {
                            signal?.addEventListener('abort', (): void => resolve(), { once: true })
                        })
                    }
                    yield { type: 'completed' }
                } finally {
                    release()
                }
            },
        }
        runtime.model = createModelHandlers({ ...runtime, provider: null, samProvider })
        const api = createApp({ runtime, onDuration: (): void => {} })
        const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
        try {
            if (!server.listening) {
                await once(server, 'listening')
            }
            const address = server.address()
            if (!address || typeof address === 'string') {
                throw new Error('local_listener_unavailable')
            }
            const form = new FormData()
            form.set(
                'metadata',
                JSON.stringify({
                    mode: 'model',
                    requestId: 'local-segment',
                    binding: {
                        kind: 'capture',
                        manualId: 'demo-divider',
                        revision: 1,
                        stepId: 'step-1',
                        captureId: 'capture-1',
                    },
                    capturedAt: '2026-01-01T00:00:00.000Z',
                    prompt: 'divider',
                    media: { kind: 'image', mimeType: 'image/png', width: 1, height: 1 },
                }),
            )
            // The synthetic provider does not decode bytes; native image qualification has separate real tests.
            form.set('media', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'synthetic.png')
            const controller = new AbortController()
            const response = await fetch(`http://127.0.0.1:${address.port}/api/segments`, {
                method: 'POST',
                headers: { 'x-truebuild-key': demoKey },
                body: form,
                signal: controller.signal,
            })
            expect(response.status).toBe(200)
            const reader = response.body!.getReader()
            const snapshot = await reader.read()
            expect(new TextDecoder().decode(snapshot.value)).toContain('"type":"snapshot"')
            controller.abort()
            await reader.cancel().catch((): void => {})
            await returned
            expect(providerSignal?.aborted).toBe(true)
            expect(calls).toBe(1)
            expect(runtime.counter.used).toBe(1)
        } finally {
            await new Promise<void>((resolve, reject): void => {
                server.close((error): void => (error ? reject(error) : resolve()))
                if ('closeAllConnections' in server) {
                    server.closeAllConnections()
                }
            })
        }
    })
})
