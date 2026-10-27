import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import { createDemoManual, type CheckResult, type SegmentEvent } from '@truebuild/contracts'
import { modelCheckMetadataSchema, type ModelCheckMetadata } from '@truebuild/contracts/model'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMetaProvider, type MetaProvider } from '../providers/meta-provider'
import { createSamProvider, type SamProvider } from '../providers/sam'
import { SharedKeyAuth } from './auth'
import { ModelCallCounter } from './budget'
import { createModelHandlers, guardModelFetch, modelOptions } from './model-service'

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
    key: string
    auth: SharedKeyAuth
    counter: ModelCallCounter
    metadata: ModelCheckMetadata
    bytes: Uint8Array
}> {
    const key = 'synthetic-local-test-value'
    const auth = new SharedKeyAuth({ sharedSecret: key })
    const counter = new ModelCallCounter(1)
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
        key,
        auth,
        counter,
        metadata,
        bytes,
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
            'x-truebuild-key': state.key,
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
        headers: { 'x-truebuild-key': state.key },
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
        wrong.headers.set('x-truebuild-key', 'wrong')
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
        expect(state.counter.used).toBe(0)
    })

    it('enforces the shared process cap across concurrent model attempts', async (): Promise<void> => {
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
        expect(responses.map((response) => response.status).sort()).toEqual([200, 429])
        expect(calls).toBe(1)
        expect(state.counter.used).toBe(1)
        const exhausted = responses.find((response) => response.status === 429)!
        expect(await exhausted.json()).toEqual({
            status: 'unavailable',
            requestId: state.metadata.requestId,
            binding: state.metadata.binding,
            code: 'budget_exhausted',
            retryable: false,
        })
    })

    it('rejects a late provider success at the configured absolute check deadline', async (): Promise<void> => {
        const state = await setup()
        let now = 0
        vi.spyOn(performance, 'now').mockImplementation((): number => now)
        const handlers = createModelHandlers({
            ...state,
            checkTimeoutMs: 15,
            samProvider: null,
            provider: provider(async (): Promise<CheckResult> => {
                now = 16
                return checked
            }),
        })
        const response = await handlers.check(request(state))
        expect(response.status).toBe(504)
        expect(await response.json()).toEqual({
            status: 'unavailable',
            requestId: state.metadata.requestId,
            binding: state.metadata.binding,
            code: 'timeout',
            retryable: false,
        })
        expect(state.counter.used).toBe(1)
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
        const handlers = createModelHandlers({
            ...state,
            counter: new ModelCallCounter(2),
            provider: testProvider,
            samProvider: null,
        })
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

    it('withholds late success after cancellation and retains the consumed attempt', async (): Promise<void> => {
        const state = await setup()
        const entered = latch()
        const release = latch()
        const controller = new AbortController()
        const handlers = createModelHandlers({
            ...state,
            samProvider: null,
            provider: provider(async (): Promise<CheckResult> => {
                entered.resolve()
                await release.promise
                return checked
            }),
        })
        const template = request(state)
        const pending = handlers.check(new Request(template, { signal: controller.signal }))
        await entered.promise
        controller.abort()
        release.resolve()
        expect((await pending).status).toBe(502)
        expect(state.counter.used).toBe(1)
    })

    it('guards actual Meta transport after cancellation during native media awaits', async (): Promise<void> => {
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
        const controller = new AbortController()
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
                    controller.abort()
                    return pending
                },
            },
        })
        expect((await handlers.check(new Request(request(state), { signal: controller.signal }))).status).toBe(502)
        expect(networkCalls).toBe(0)
    })

    it('refuses missing effect context and a second dispatch in the same admitted context', async (): Promise<void> => {
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

    it('keeps ALS effect authority through generator consumption and delivers exactly one streamed terminal', async (): Promise<void> => {
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
                headers: { 'x-truebuild-key': state.key },
                body: form,
            }),
        )
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        const text = await response.text()
        expect(text.includes('"type":"completed"')).toBe(true)
        expect(text.match(/data:/gu)).toHaveLength(1)
        expect(calls).toBe(1)
        expect(state.counter.used).toBe(1)
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
                'x-truebuild-key': state.key,
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
                                content: [
                                    {
                                        type: 'output_text',
                                        text: JSON.stringify({
                                            ...checked,
                                            partsAssessment: 'matches',
                                            connectionAssessment: 'matches',
                                            checks: [
                                                {
                                                    checkId: 'groove-inward',
                                                    assessment: 'matches',
                                                    sourceRefs: checked.sourceRefs,
                                                },
                                            ],
                                        }),
                                    },
                                ],
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

    it('cancels generator work and retains the consumed attempt on consumer disconnect', async (): Promise<void> => {
        const state = await setup()
        const released = latch()
        const returned = latch()
        let observedSignal: AbortSignal | undefined
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
        expect(observedSignal?.aborted).toBe(true)
        expect(state.counter.used).toBe(1)
    })

    it('never fabricates completed for truncated streams', async (): Promise<void> => {
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
    })

    it('permits only exact local origins and explicit auth/content-type preflight headers', (): void => {
        const allowed = modelOptions(
            new Request('http://localhost:3001/api/checks', {
                method: 'OPTIONS',
                headers: {
                    origin: 'http://localhost:8081',
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'Content-Type, X-TrueBuild-Key',
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

describe('per-attempt accounting for documented status retries', () => {
    it.each([1, 2])('counts every attempt and refuses exhausted retry with cap %i', async (limit) => {
        const state = await setup()
        state.counter = new ModelCallCounter(limit)
        let calls = 0
        const actual = createMetaProvider({
            apiKey: 'synthetic',
            fetchImpl: guardModelFetch(async () => {
                calls++
                return calls === 1
                    ? new Response('private', { status: 429 })
                    : Response.json({
                          status: 'completed',
                          output: [
                              {
                                  type: 'message',
                                  role: 'assistant',
                                  status: 'completed',
                                  content: [
                                      {
                                          type: 'output_text',
                                          text: JSON.stringify({
                                              ...checked,
                                              orientationAssessment: 'correct',
                                              partsAssessment: 'matches',
                                              connectionAssessment: 'matches',
                                              checks: [
                                                  {
                                                      checkId: 'groove-inward',
                                                      assessment: 'matches',
                                                      sourceRefs: checked.sourceRefs,
                                                  },
                                              ],
                                          }),
                                      },
                                  ],
                              },
                          ],
                      })
            }),
        })
        const handlers = createModelHandlers({ ...state, provider: actual, samProvider: null })
        const response = await handlers.check(request(state))
        expect(response.status).toBe(limit === 1 ? 429 : 200)
        if (limit === 1) expect(await response.json()).toMatchObject({ code: 'budget_exhausted' })
        expect(calls).toBe(limit)
        expect(state.counter.used).toBe(limit)
    })
})

it.each([1, 2])('counts SAM status retries against the shared attempt cap %i', async (limit) => {
    const state = await setup()
    state.counter = new ModelCallCounter(limit)
    let calls = 0
    const samProvider = createSamProvider({
        apiKey: 'synthetic',
        fetchImpl: guardModelFetch(async (_url, init) => {
            expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'sam-3.1', stream: true })
            calls++
            if (calls === 1) return new Response('private upstream error', { status: 429 })
            return new Response(
                'data: {"type":"response.output_text.done","item_id":"m","output_index":0,"content_index":0,"text":""}\n\ndata: {"type":"response.completed"}\n\n',
                { headers: { 'content-type': 'text/event-stream' } },
            )
        }),
    })
    const handlers = createModelHandlers({ ...state, provider: null, samProvider })
    const body = new FormData()
    body.set(
        'metadata',
        JSON.stringify({
            mode: 'model',
            requestId: 'sam-budget',
            binding: state.metadata.binding,
            capturedAt: '2026-01-01T00:00:00Z',
            prompt: 'side panel',
            media: { kind: 'image', mimeType: 'image/png', width: 20, height: 16 },
        }),
    )
    body.set('media', new Blob([new Uint8Array(state.bytes)], { type: 'image/png' }), 'synthetic.png')
    const response = await handlers.segment(
        new Request('http://localhost/api/segments', {
            method: 'POST',
            headers: { 'x-truebuild-key': state.key },
            body,
        }),
    )
    const wire = await response.text()
    expect(wire).toContain(limit === 1 ? '"code":"budget_exhausted"' : '"type":"completed"')
    expect(wire).not.toContain('private upstream')
    expect(calls).toBe(limit)
    expect(state.counter.used).toBe(limit)
})

const uncertain: CheckResult = {
    ...checked,
    model: 'muse-spark-1.3',
    decision: 'cannot_verify',
    orientationAssessment: 'uncertain',
    missingEvidence: ['Need a clearer view'],
}
function secondaryRequest(
    state: Awaited<ReturnType<typeof setup>>,
    token: string,
    mutate?: (form: FormData) => void,
): Request {
    return request(state, (form) => {
        form.set('metadata', JSON.stringify({ ...state.metadata, secondOpinionToken: token }))
        mutate?.(form)
    })
}

describe('separate authenticated second opinion', () => {
    it('does not offer or dispatch when disabled or when the primary decides', async () => {
        const state = await setup()
        const secondOpinion = vi.fn(async () => checked)
        for (const decision of ['pass', 'refuse', 'cannot_verify'] as const) {
            const handlers = createModelHandlers({
                ...state,
                counter: new ModelCallCounter(5),
                provider: {
                    ...provider(async () => ({
                        ...uncertain,
                        decision,
                        orientationAssessment: decision === 'cannot_verify' ? 'uncertain' : 'correct',
                        missingEvidence: [],
                    })),
                    secondOpinion,
                },
                samProvider: null,
                ...(decision === 'cannot_verify' ? {} : { secondOpinionModel: 'muse-wonder-1.0' as const }),
            })
            const result = await (await handlers.check(request(state))).json()
            expect(result.value.secondOpinion).toBeUndefined()
        }
        expect(secondOpinion).not.toHaveBeenCalled()
    })
    it('consumes concurrent/replayed tokens exactly once and preserves the primary on secondary pass', async () => {
        const state = await setup()
        const secondOpinion = vi.fn(async () => ({ ...checked, model: 'muse-wonder-1.0' as const }))
        const counter = new ModelCallCounter(4)
        const handlers = createModelHandlers({
            ...state,
            counter,
            provider: { ...provider(async () => uncertain), secondOpinion },
            samProvider: null,
            secondOpinionModel: 'muse-wonder-1.0',
        })
        const primary = await (await handlers.check(request(state))).json()
        expect(secondOpinion).not.toHaveBeenCalled()
        const token = primary.value.secondOpinion.token
        const replies = await Promise.all([
            handlers.secondOpinion(secondaryRequest(state, token)),
            handlers.secondOpinion(secondaryRequest(state, token)),
        ])
        expect(replies.map((r) => r.status).sort()).toEqual([200, 409])
        const result = await replies.find((r) => r.status === 200)!.json()
        expect(result).toMatchObject({
            requestId: state.metadata.requestId,
            binding: state.metadata.binding,
            value: {
                decision: 'cannot_verify',
                model: 'muse-spark-1.3',
                secondOpinion: { model: 'muse-wonder-1.0', status: 'completed' },
            },
        })
        expect(result.value.modelNotes.length).toBeGreaterThan(0)
        expect(secondOpinion).toHaveBeenCalledTimes(1)
        expect(counter.used).toBe(2)
    })
    it('rejects wrong authentication, CORS, altered intent and bytes before any secondary dispatch', async () => {
        const state = await setup()
        const secondOpinion = vi.fn(async () => checked)
        const handlers = createModelHandlers({
            ...state,
            counter: new ModelCallCounter(20),
            provider: { ...provider(async () => uncertain), secondOpinion },
            samProvider: null,
            secondOpinionModel: 'muse-wonder-1.0',
        })
        for (const mutation of ['key', 'origin', 'capture', 'session', 'source', 'observation']) {
            const primary = await (await handlers.check(request(state))).json()
            const token = primary.value.secondOpinion.token
            const req = secondaryRequest(state, token, (form) => {
                if (mutation === 'capture')
                    form.set(
                        'metadata',
                        JSON.stringify({
                            ...state.metadata,
                            binding: { ...state.metadata.binding, captureId: 'changed' },
                            secondOpinionToken: token,
                        }),
                    )
                if (mutation === 'session')
                    form.set(
                        'metadata',
                        JSON.stringify({
                            ...state.metadata,
                            session: { ...state.metadata.session, title: 'changed' },
                            secondOpinionToken: token,
                        }),
                    )
                if (mutation === 'source' || mutation === 'observation')
                    form.set(
                        mutation === 'source' ? 'source-0' : 'observation',
                        new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
                        'changed.png',
                    )
            })
            if (mutation === 'key') req.headers.set('x-truebuild-key', 'wrong')
            if (mutation === 'origin') req.headers.set('origin', 'https://invalid.example')
            expect((await handlers.secondOpinion(req)).status).toBe(
                mutation === 'key' || mutation === 'origin' ? 401 : 409,
            )
        }
        expect(secondOpinion).not.toHaveBeenCalled()
    })
    it('retains the original with an unavailable note after secondary failure or budget exhaustion', async () => {
        const state = await setup()
        for (const limit of [1, 2]) {
            const secondOpinion = vi.fn(async (): Promise<CheckResult> => {
                throw new Error('private upstream message')
            })
            const handlers = createModelHandlers({
                ...state,
                counter: new ModelCallCounter(limit),
                provider: { ...provider(async () => uncertain), secondOpinion },
                samProvider: null,
                secondOpinionModel: 'muse-wonder-1.0',
            })
            const primary = await (await handlers.check(request(state))).json()
            const response = await handlers.secondOpinion(secondaryRequest(state, primary.value.secondOpinion.token))
            const body = await response.json()
            expect(body).toMatchObject({
                status: 'ok',
                value: { decision: 'cannot_verify', model: 'muse-spark-1.3', secondOpinion: { status: 'unavailable' } },
            })
            expect(body.value.modelNotes.length).toBeGreaterThan(0)
            expect(JSON.stringify(body)).not.toContain('private upstream')
            expect(secondOpinion).toHaveBeenCalledTimes(limit - 1)
        }
    })
    it('has a separate 60s deadline and never publishes a ticket from cancelled primary completion', async () => {
        const state = await setup()
        let now = performance.now()
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
        try {
            const secondOpinion = vi.fn(async () => {
                now += 8_100
                return { ...checked, model: 'muse-wonder-1.0' as const }
            })
            const handlers = createModelHandlers({
                ...state,
                counter: new ModelCallCounter(10),
                provider: { ...provider(async () => uncertain), secondOpinion },
                samProvider: null,
                secondOpinionModel: 'muse-wonder-1.0',
            })
            const primary = await (await handlers.check(request(state))).json()
            expect(
                (await handlers.secondOpinion(secondaryRequest(state, primary.value.secondOpinion.token))).status,
            ).toBe(200)
            const abort = new AbortController()
            const cancelled = createModelHandlers({
                ...state,
                counter: new ModelCallCounter(10),
                provider: {
                    ...provider(async () => {
                        abort.abort()
                        return uncertain
                    }),
                    secondOpinion,
                },
                samProvider: null,
                secondOpinionModel: 'muse-wonder-1.0',
            })
            const response = await cancelled.check(new Request(request(state), { signal: abort.signal }))
            expect(response.status).toBe(502)
            expect(JSON.stringify(await response.json())).not.toContain('secondOpinion')
        } finally {
            clock.mockRestore()
        }
    })
    it('burns a cancelled follow-up and refuses its late result', async () => {
        const state = await setup()
        const abort = new AbortController()
        const secondOpinion = vi.fn(async () => {
            abort.abort()
            return { ...checked, model: 'muse-wonder-1.0' as const }
        })
        const handlers = createModelHandlers({
            ...state,
            counter: new ModelCallCounter(10),
            provider: { ...provider(async () => uncertain), secondOpinion },
            samProvider: null,
            secondOpinionModel: 'muse-wonder-1.0',
        })
        const primary = await (await handlers.check(request(state))).json()
        const token = primary.value.secondOpinion.token
        const response = await handlers.secondOpinion(
            new Request(secondaryRequest(state, token), { signal: abort.signal }),
        )
        expect(response.status).toBe(502)
        expect((await handlers.secondOpinion(secondaryRequest(state, token))).status).toBe(409)
        expect(secondOpinion).toHaveBeenCalledTimes(1)
    })
    it('guard forbids a second upstream attempt even for a retryable secondary response', async () => {
        const state = await setup()
        const outbound = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }))
        const guarded = guardModelFetch(outbound)
        const secondOpinion = vi.fn(async (): Promise<CheckResult> => {
            for (let attempt = 0; attempt < 2; attempt++)
                await guarded('https://api.meta.ai/v1/responses', { method: 'POST', body: 'same' })
            return uncertain
        })
        const handlers = createModelHandlers({
            ...state,
            counter: new ModelCallCounter(10),
            provider: { ...provider(async () => uncertain), secondOpinion },
            samProvider: null,
            secondOpinionModel: 'muse-wonder-1.0',
        })
        const primary = await (await handlers.check(request(state))).json()
        const result = await (
            await handlers.secondOpinion(secondaryRequest(state, primary.value.secondOpinion.token))
        ).json()
        expect(result.value.secondOpinion.status).toBe('unavailable')
        expect(outbound).toHaveBeenCalledTimes(1)
    })
})

it('binds tickets to their runtime and retains primary uncertainty after absolute secondary expiry', async () => {
    const state = await setup()
    let now = performance.now()
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
        const secondOpinion = vi.fn(async () => {
            now += 60_001
            return { ...checked, model: 'muse-wonder-1.0' as const }
        })
        const options = {
            ...state,
            counter: new ModelCallCounter(10),
            provider: { ...provider(async () => uncertain), secondOpinion },
            samProvider: null,
            secondOpinionModel: 'muse-wonder-1.0' as const,
        }
        const first = createModelHandlers(options)
        const replacement = createModelHandlers(options)
        const primary = await (await first.check(request(state))).json()
        const token = primary.value.secondOpinion.token
        expect((await replacement.secondOpinion(secondaryRequest(state, token))).status).toBe(409)
        expect(secondOpinion).not.toHaveBeenCalled()
        const result = await (await first.secondOpinion(secondaryRequest(state, token))).json()
        expect(result).toMatchObject({
            status: 'ok',
            value: { decision: 'cannot_verify', model: 'muse-spark-1.3', secondOpinion: { status: 'unavailable' } },
        })
        expect(secondOpinion).toHaveBeenCalledTimes(1)
        expect((await first.secondOpinion(secondaryRequest(state, token))).status).toBe(409)
    } finally {
        clock.mockRestore()
    }
})
