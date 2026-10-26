import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDemoManual, type CheckResult, type SegmentEvent } from '@truebuild/contracts'
import { modelCheckMetadataSchema, type ModelCheckMetadata } from '@truebuild/contracts/model'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMetaProvider, type MetaProvider } from '../providers/meta-provider'
import type { SamProvider } from '../providers/sam'
import { OwnerSessionManager } from './auth'
import { RunLedger } from './budget'
import { createModelHandlers, guardModelFetch, modelOptions } from './model-service'

const directories: string[] = []
const servers: Server[] = []
afterEach(async (): Promise<void> => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve): void => {
                    server.closeAllConnections()
                    server.close((): void => resolve())
                }),
        ),
    )
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const checked: CheckResult = {
    decision: 'pass',
    orientationAssessment: 'correct',
    reason: 'Synthetic check',
    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
    observedRegion: null,
    missingEvidence: [],
}
function provider(check: MetaProvider['checkStep']): MetaProvider {
    return {
        parseManual: async (): Promise<NonNullable<ReturnType<typeof createDemoManual>['rawExtraction']>> =>
            createDemoManual().rawExtraction!,
        checkStep: check,
        answerQuestion: async (): Promise<{ answer: string; sourceRefs: []; missingEvidence: [] }> => ({
            answer: 'Synthetic answer',
            sourceRefs: [],
            missingEvidence: [],
        }),
    }
}

async function setup(): Promise<{
    path: string
    token: string
    manager: OwnerSessionManager
    ledger: RunLedger
    metadata: ModelCheckMetadata
    bytes: Uint8Array
    expire: () => void
}> {
    const path = await mkdtemp(join(tmpdir(), 'truebuild-model-service-'))
    directories.push(path)
    await chmod(path, 0o700)
    let now = Date.now()
    const ledger = new RunLedger({ privateDirectory: path })
    const manager = new OwnerSessionManager({ privateDirectory: path, ledger, now: (): number => now })
    await manager.createSession({ newRun: true })
    const token = await readFile(join(path, 'session-token'), 'utf8')
    const bytes = new Uint8Array(
        await sharp({ create: { width: 20, height: 16, channels: 3, background: 'red' } })
            .png()
            .toBuffer(),
    )
    const session = createDemoManual()
    session.pages[0] = {
        ...session.pages[0]!,
        width: 20,
        height: 16,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
    }
    const metadata = modelCheckMetadataSchema.parse({
        mode: 'model',
        requestId: 'request-1',
        session,
        binding: { kind: 'capture', manualId: session.manualId, revision: 1, stepId: 'step-1', captureId: 'capture-1' },
        sourcePageIds: ['demo-page-1'],
        observation: { mimeType: 'image/png', width: 20, height: 16 },
    })
    return {
        path,
        token,
        manager,
        ledger,
        metadata,
        bytes,
        expire: (): void => {
            now += 30 * 60 * 1_000
        },
    }
}

function request(state: Awaited<ReturnType<typeof setup>>, mutate?: (form: FormData) => void): Request {
    const form = new FormData()
    form.set('metadata', JSON.stringify(state.metadata))
    form.set('source-0', new Blob([new Uint8Array(state.bytes)], { type: 'image/png' }), 'source.png')
    form.set('observation', new Blob([new Uint8Array(state.bytes)], { type: 'image/png' }), 'observation.png')
    mutate?.(form)
    return new Request('http://127.0.0.1:3001/api/checks', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${state.token}`,
            origin: 'http://localhost:8081',
        },
        body: form,
    })
}

function segmentRequest(state: Awaited<ReturnType<typeof setup>>): Request {
    const form = new FormData()
    form.set(
        'metadata',
        JSON.stringify({
            mode: 'model',
            requestId: 'segment-1',
            binding: state.metadata.binding,
            capturedAt: '2026-01-01T00:00:00.000Z',
            prompt: 'divider',
            media: { kind: 'image', ...state.metadata.observation },
        }),
    )
    form.set('media', new Blob([new Uint8Array(state.bytes)], { type: 'image/png' }), 'capture.png')
    return new Request('http://127.0.0.1:3001/api/segments', {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}` },
        body: form,
    })
}

function latch(): { promise: Promise<void>; resolve: () => void } {
    let release = (): void => {}
    const promise = new Promise<void>((resolve): void => {
        release = resolve
    })
    return { promise, resolve: release }
}

describe('protected model composition', (): void => {
    it('authenticates before body and refuses unconfigured/foreign/bad multipart with zero dispatch', async (): Promise<void> => {
        const state = await setup()
        let calls = 0
        const configured = provider(async (): Promise<CheckResult> => {
            calls += 1
            return checked
        })
        const handlers = createModelHandlers({ ...state, provider: configured, samProvider: null })
        const wrong = request(state)
        wrong.headers.set('authorization', 'Bearer wrong')
        expect((await handlers.check(wrong)).status).toBe(401)
        expect(wrong.bodyUsed).toBe(false)
        const foreign = request(state)
        foreign.headers.set('origin', 'https://foreign.example')
        expect((await handlers.check(foreign)).status).toBe(401)
        const disabled = createModelHandlers({ ...state, provider: null, samProvider: null })
        expect((await disabled.check(request(state))).status).toBe(503)
        expect(
            (
                await handlers.check(
                    request(state, (form): void => {
                        form.append('metadata', '{}')
                    }),
                )
            ).status,
        ).toBe(400)
        expect(
            (
                await handlers.check(
                    request(state, (form): void => {
                        form.set('extra', 'no')
                    }),
                )
            ).status,
        ).toBe(400)
        expect(calls).toBe(0)
    })

    it('reserves once for concurrent duplicate requests and finalizes before success', async (): Promise<void> => {
        const state = await setup()
        let calls = 0
        const handlers = createModelHandlers({
            ...state,
            samProvider: null,
            provider: provider(async (): Promise<CheckResult> => {
                calls += 1
                return checked
            }),
        })
        const responses = await Promise.all([handlers.check(request(state)), handlers.check(request(state))])
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
        expect(calls).toBe(1)
        expect((await readFile(join(state.path, 'run-ledger.json'), 'utf8')).includes('"outcome":"completed"')).toBe(
            true,
        )
    })

    it('wires parse source order and question target without falling back to fixture', async (): Promise<void> => {
        const state = await setup()
        let parsedSources = 0
        let questionCalls = 0
        const testProvider = provider(async (): Promise<CheckResult> => checked)
        testProvider.parseManual = async (
            value,
        ): Promise<NonNullable<ReturnType<typeof createDemoManual>['rawExtraction']>> => {
            parsedSources = value.pages.length
            return createDemoManual().rawExtraction!
        }
        testProvider.answerQuestion = async (
            value,
        ): Promise<{ answer: string; sourceRefs: []; missingEvidence: [] }> => {
            expect(value.target).toEqual({ kind: 'part', partId: 'side-panel' })
            questionCalls += 1
            return { answer: 'Synthetic answer', sourceRefs: [], missingEvidence: [] }
        }
        const handlers = createModelHandlers({ ...state, provider: testProvider, samProvider: null })
        const parse = request(state, (form): void => {
            form.delete('observation')
            form.set(
                'metadata',
                JSON.stringify({
                    mode: 'model',
                    requestId: 'parse-1',
                    binding: { kind: 'manual', manualId: 'demo-divider', revision: 1 },
                    pages: state.metadata.session.pages,
                }),
            )
        })
        expect((await handlers.parse(parse)).status).toBe(200)
        const question = request(state, (form): void => {
            form.set(
                'metadata',
                JSON.stringify({
                    ...state.metadata,
                    requestId: 'question-1',
                    question: 'Which way?',
                    target: { kind: 'part', partId: 'side-panel' },
                }),
            )
        })
        expect((await handlers.question(question)).status).toBe(200)
        expect(parsedSources).toBe(1)
        expect(questionCalls).toBe(1)
    })

    it('withholds late success after session rotation and retains usage', async (): Promise<void> => {
        const state = await setup()
        const entered = latch()
        const release = latch()
        const handlers = createModelHandlers({
            ...state,
            samProvider: null,
            provider: provider(async (): Promise<CheckResult> => {
                entered.resolve()
                await release.promise
                return checked
            }),
        })
        const pending = handlers.check(request(state))
        await entered.promise
        await state.manager.createSession({ newRun: false })
        release.resolve()
        expect((await pending).status).toBe(401)
        expect((await readFile(join(state.path, 'run-ledger.json'), 'utf8')).includes('"outcome":"unknown"')).toBe(true)
    })

    it('never publishes pass when finalization persistence is unavailable', async (): Promise<void> => {
        const state = await setup()
        const moved = `${state.path}-moved`
        directories.push(moved)
        const handlers = createModelHandlers({
            ...state,
            samProvider: null,
            provider: provider(async (): Promise<CheckResult> => {
                await rename(state.path, moved)
                return checked
            }),
        })
        const response = await handlers.check(request(state))
        expect(response.status).toBe(502)
        expect((await readFile(join(moved, 'run-ledger.json'), 'utf8')).includes('"outcome":"reserved"')).toBe(true)
    })

    it('guards actual Meta transport after authority expires during native media awaits', async (): Promise<void> => {
        const state = await setup()
        let networkCalls = 0
        const server = createServer((_request, response): void => {
            networkCalls += 1
            response.end('{}')
        })
        servers.push(server)
        await new Promise<void>((resolve): void => {
            server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
            throw new Error('fixture_unavailable')
        }
        const actual = createMetaProvider({
            apiKey: 'synthetic-test-key',
            fetchImpl: guardModelFetch(async (_url, init): Promise<Response> =>
                fetch(`http://127.0.0.1:${address.port}`, init),
            ),
        })
        const handlers = createModelHandlers({
            ...state,
            samProvider: null,
            provider: {
                ...actual,
                checkStep(input, signal): Promise<CheckResult> {
                    const pending = actual.checkStep(input, signal)
                    state.expire()
                    return pending
                },
            },
        })
        expect((await handlers.check(request(state))).status).toBe(401)
        expect(networkCalls).toBe(0)
    })

    it('refuses missing effect context and a second dispatch in the same reserved context', async (): Promise<void> => {
        const state = await setup()
        let calls = 0
        const guarded = guardModelFetch(async (): Promise<Response> => {
            calls += 1
            return new Response('{}')
        })
        await expect(guarded('https://api.meta.ai/v1/responses', { method: 'POST' })).rejects.toThrow('unauthorized')
        const handlers = createModelHandlers({
            ...state,
            samProvider: null,
            provider: provider(async (): Promise<CheckResult> => {
                await guarded('https://api.meta.ai/v1/responses', { method: 'POST' })
                await guarded('https://api.meta.ai/v1/responses', { method: 'POST' })
                return checked
            }),
        })
        expect((await handlers.check(request(state))).status).not.toBe(200)
        expect(calls).toBe(1)
    })

    it('keeps ALS effect authority through generator consumption and finalizes streamed terminal', async (): Promise<void> => {
        const state = await setup()
        let calls = 0
        const guarded = guardModelFetch(async (): Promise<Response> => {
            calls += 1
            return new Response('{}')
        })
        const samProvider: SamProvider = {
            async *segment(): AsyncGenerator<SegmentEvent> {
                await Promise.resolve()
                await guarded('https://api.meta.ai/v1/responses', { method: 'POST' })
                yield { type: 'completed' }
            },
        }
        const handlers = createModelHandlers({ ...state, provider: null, samProvider })
        const form = new FormData()
        form.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'segment-1',
                binding: state.metadata.binding,
                capturedAt: '2026-01-01T00:00:00.000Z',
                prompt: 'divider',
                media: { kind: 'image', ...state.metadata.observation },
            }),
        )
        form.set('media', new Blob([new Uint8Array(state.bytes)], { type: 'image/png' }), 'capture.png')
        const response = await handlers.segment(
            new Request('http://127.0.0.1:3001/api/segments', {
                method: 'POST',
                headers: { authorization: `Bearer ${state.token}` },
                body: form,
            }),
        )
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        const text = await response.text()
        expect(text.includes('"type":"completed"')).toBe(true)
        expect(text.match(/data:/gu)).toHaveLength(1)
        expect(calls).toBe(1)
        expect((await readFile(join(state.path, 'run-ledger.json'), 'utf8')).includes('"outcome":"completed"')).toBe(
            true,
        )
    })

    it('bounds raw multipart body and absolute body-read time before reservation/dispatch', async (): Promise<void> => {
        const state = await setup()
        let calls = 0
        const handlers = createModelHandlers({
            ...state,
            samProvider: null,
            provider: provider(async (): Promise<CheckResult> => {
                calls += 1
                return checked
            }),
        })
        const oversized = new Request('http://localhost:3001/api/checks', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${state.token}`,
                'content-type': 'multipart/form-data; boundary=synthetic',
            },
            body: new Uint8Array(9 * 1_024 * 1_024 + 1),
        })
        expect((await handlers.check(oversized)).status).toBe(413)
        const template = request(state)
        const bytes = new Uint8Array(await template.arrayBuffer())
        let now = 0
        let cancelled = false
        vi.spyOn(performance, 'now').mockImplementation((): number => now)
        const init: RequestInit & { duplex: 'half' } = {
            method: 'POST',
            duplex: 'half',
            headers: template.headers,
            body: new ReadableStream<Uint8Array>({
                pull(controller): void {
                    now = 9_000
                    controller.enqueue(bytes)
                },
                cancel(): void {
                    cancelled = true
                },
            }),
        }
        expect((await handlers.check(new Request(template.url, init))).status).toBe(504)
        expect(cancelled).toBe(true)
        expect(calls).toBe(0)
    })

    it('dispatches one actual Meta adapter request through the guarded local transport', async (): Promise<void> => {
        const state = await setup()
        let calls = 0
        const server = createServer((incoming, response): void => {
            calls += 1
            incoming.resume()
            incoming.on('end', (): void => {
                response.setHeader('content-type', 'application/json')
                response.end(
                    JSON.stringify({
                        status: 'completed',
                        output: [
                            {
                                type: 'message',
                                role: 'assistant',
                                status: 'completed',
                                content: [{ type: 'output_text', text: JSON.stringify(checked) }],
                            },
                        ],
                    }),
                )
            })
        })
        servers.push(server)
        await new Promise<void>((resolve): void => {
            server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
            throw new Error('fixture_unavailable')
        }
        const actual = createMetaProvider({
            apiKey: 'synthetic-test-key',
            fetchImpl: guardModelFetch(async (_url, init): Promise<Response> =>
                fetch(`http://127.0.0.1:${address.port}`, init),
            ),
        })
        const handlers = createModelHandlers({ ...state, provider: actual, samProvider: null })
        expect((await handlers.check(request(state))).status).toBe(200)
        expect(calls).toBe(1)
    })

    it('cancels generator work and durably retains unknown usage on consumer disconnect', async (): Promise<void> => {
        const state = await setup()
        const released = latch()
        const returned = latch()
        const finalized = latch()
        let observedSignal: AbortSignal | undefined
        const original = state.ledger.finalize.bind(state.ledger)
        vi.spyOn(state.ledger, 'finalize').mockImplementation(async (value): Promise<void> => {
            await original(value)
            finalized.resolve()
        })
        const samProvider: SamProvider = {
            async *segment(input, signal): AsyncGenerator<SegmentEvent> {
                observedSignal = signal
                try {
                    yield {
                        type: 'snapshot',
                        snapshot: {
                            binding: input.binding,
                            capturedAt: input.capturedAt,
                            streamId: 'stream-1',
                            frameIndex: 0,
                            records: [],
                            complete: false,
                        },
                    }
                    await released.promise
                    yield { type: 'completed' }
                } finally {
                    returned.resolve()
                }
            },
        }
        const handlers = createModelHandlers({ ...state, provider: null, samProvider })
        const response = await handlers.segment(segmentRequest(state))
        const reader = response.body!.getReader()
        await reader.read()
        await reader.cancel()
        released.resolve()
        await returned.promise
        await finalized.promise
        expect(observedSignal?.aborted).toBe(true)
        expect((await readFile(join(state.path, 'run-ledger.json'), 'utf8')).includes('"outcome":"unknown"')).toBe(true)
    })

    it('never fabricates completed for truncated streams or failed terminal persistence', async (): Promise<void> => {
        const state = await setup()
        const empty: SamProvider = {
            async *segment(): AsyncGenerator<SegmentEvent> {
                yield* []
            },
        }
        const handlers = createModelHandlers({ ...state, provider: null, samProvider: empty })
        const text = await (await handlers.segment(segmentRequest(state))).text()
        expect(text.includes('"type":"completed"')).toBe(false)
        expect(text.includes('"status":"unavailable"')).toBe(true)
        const second = await setup()
        const moved = `${second.path}-moved`
        directories.push(moved)
        const failed: SamProvider = {
            async *segment(): AsyncGenerator<SegmentEvent> {
                await rename(second.path, moved)
                yield { type: 'completed' }
            },
        }
        const text2 = await (
            await createModelHandlers({ ...second, provider: null, samProvider: failed }).segment(
                segmentRequest(second),
            )
        ).text()
        expect(text2.includes('"type":"completed"')).toBe(false)
        expect(text2.includes('"status":"unavailable"')).toBe(true)
    })

    it('permits only exact local origins and explicit auth/content-type preflight headers', (): void => {
        const allowed = modelOptions(
            new Request('http://localhost:3001/api/checks', {
                method: 'OPTIONS',
                headers: {
                    origin: 'http://localhost:8081',
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'Content-Type, Authorization',
                },
            }),
        )
        expect(allowed.status).toBe(204)
        expect(allowed.headers.get('access-control-allow-credentials')).toBeNull()
        expect(
            modelOptions(
                new Request('http://localhost:3001/api/checks', { headers: { origin: 'https://foreign.example' } }),
            ).status,
        ).toBe(401)
    })
})
