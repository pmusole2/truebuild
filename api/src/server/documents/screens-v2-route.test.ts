import { createHash } from 'node:crypto'

import {
    SCREEN_KINDS_V2,
    buildFallbackProposalV2,
    type ScreenContextInputsV2,
    type ScreenKindV2,
} from '@truebuild/contracts'
import {
    modelScreensV2MetadataSchema,
    screensV2GenerateRequest,
    screensV2ResultSchema,
    type ModelScreensV2Metadata,
    type ScreensV2Result,
} from '@truebuild/contracts/model'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { encodeWireProposal } from '../../providers/document-wire'
import { REPAIR_ONCE_MANUAL } from '../../providers/document-fixtures'
import { demoSession, documentInputs, fullUi } from '../../test-support/document-inputs'
import { startMetaMock } from '../../test-support/meta-http-mock'
import { createRuntimeFromEnvironment } from '../model-runtime'
import { buildDocumentContext } from './context'

const KEY = 'synthetic-local-test-value'
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
afterEach(() => vi.restoreAllMocks())

function fixtureApp(env: Record<string, string> = {}): ReturnType<typeof createApp> {
    vi.spyOn(console, 'info').mockImplementation((): void => {})
    const runtime = createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: KEY, ...env })
    return createApp({ runtime, onDuration: () => {} })
}

function send(
    app: ReturnType<typeof createApp>,
    metadata: unknown,
    options: { key?: string | null; files?: boolean; query?: string } = {},
): Promise<Response> {
    // An unauthenticated request is refused before its body is read, so it carries a plain (non-streaming) body.
    if (options.key === null) {
        return Promise.resolve(app.request('/api/screens/v2', { method: 'POST', body: JSON.stringify(metadata) }))
    }
    const body = new FormData()
    body.set('metadata', JSON.stringify(metadata))
    if (options.files) body.set('extra', new Blob(['x'], { type: 'image/png' }), 'x.png')
    return Promise.resolve(
        app.request(`/api/screens/v2${options.query ?? '?guideRepair=1&stepActions=1'}`, {
            method: 'POST',
            headers: { 'x-truebuild-key': options.key ?? KEY },
            body,
        }),
    )
}

const generate = (inputs: ScreenContextInputsV2, requestId = 'r1'): ModelScreensV2Metadata =>
    screensV2GenerateRequest(requestId, inputs, sha256Hex)

describe('POST /api/screens/v2 (fixture runtime)', () => {
    it.each(SCREEN_KINDS_V2)(
        'generates a %s document that is valid, synthetic and unobserved',
        async (kind: ScreenKindV2) => {
            const app = fixtureApp()
            const response = await send(app, generate(documentInputs(kind)))
            expect(response.status).toBe(200)
            const body = screensV2ResultSchema.parse(await response.json())
            expect(body.status).toBe('ok')
            if (body.status !== 'ok') return
            expect(body.mode).toBe('fixture')
            expect(body.value.document).toMatchObject({
                version: 2,
                kind,
                metadata: { source: 'generated', evidence: 'synthetic-fixture', model: null, effort: null },
            })
            expect(body.value.document!.metadata.timing.totalMs).toBeNull()
        },
    )

    it.each(['', '?guideRepair=1', '?guideRepair=1&stepActions=1', '?stepActions=1&stepActions=1'])(
        'keeps strict installed-client document material isolated for capability %s',
        async (query) => {
            const app = fixtureApp({ GENERATIVE_UI: 'off' })
            const inputs = documentInputs('guide', demoSession({ safety: false }))
            const response = await send(app, generate(inputs), { query })
            const result = screensV2ResultSchema.parse(await response.json())
            if (result.status !== 'ok') throw new Error('expected ok')
            const capable = query === '?guideRepair=1&stepActions=1'
            const expected = buildDocumentContext(inputs, !capable).material
            expect(result.value.document!.facts).toEqual(expected.facts)
            expect(result.value.document!.requirements).toEqual(expected.requirements)
            expect(result.value.document!.sources).toEqual(expected.sources)
        },
    )

    it('binds the request to the full state: a wrong manual hash or context key is refused', async () => {
        const app = fixtureApp()
        const request = generate(documentInputs('guide'))
        const tamperedSession = structuredClone(request.session!)
        tamperedSession.title = 'A different title'
        const staleHash = await send(app, { ...request, session: tamperedSession })
        expect(staleHash.status).toBe(400)
        expect(await staleHash.json()).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        const wrongKey = await send(app, { ...request, contextKey: 'a'.repeat(64) })
        expect(wrongKey.status).toBe(400)
        const otherState = await send(app, generate({ ...documentInputs('camera'), uiState: fullUi }))
        expect(otherState.status).toBe(200)
        // The same screen with different used state has a different key; the stale key is refused.
        const camera = generate({
            ...documentInputs('camera'),
            uiState: { ...fullUi, camera: { mode: 'build-photo', permission: 'denied' } },
        })
        const reused = await send(app, { ...camera, contextKey: generate(documentInputs('camera')).contextKey })
        expect(reused.status).toBe(400)
    })

    it('requires explicit version 2 input, zero files, the key and POST', async () => {
        const app = fixtureApp()
        const request = generate(documentInputs('home'))
        // A version 1 style body (focusStepId, no manualHash/contextKey) is not silently accepted.
        const legacy = {
            mode: 'model',
            requestId: 'r',
            op: 'generate',
            kind: 'home',
            binding: null,
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            focusStepId: null,
            want: [],
        }
        expect((await send(app, legacy)).status).toBe(400)
        expect((await send(app, { ...request, extra: true })).status).toBe(400)
        expect((await send(app, request, { files: true })).status).toBe(400)
        expect((await send(app, request, { key: null })).status).toBe(401)
        expect((await send(app, { ...request, kind: null })).status).toBe(400)
        const get = await app.request('/api/screens/v2', { method: 'GET', headers: { 'x-truebuild-key': KEY } })
        expect(get.status).toBe(405)
        expect(get.headers.get('allow')).toContain('POST')
        expect(modelScreensV2MetadataSchema.safeParse(request).success).toBe(true)
    })

    it('isolates Guide precompute, progress and cancel by the client capability', async () => {
        const app = fixtureApp()
        const session = { ...demoSession(), manualId: REPAIR_ONCE_MANUAL }
        const base = generate(documentInputs('guide', session))
        const common = {
            ...base,
            op: 'precompute',
            kind: null,
            stepId: null,
            contextKey: null,
            focusKey: 'guide:step-1',
            requestedKinds: ['guide'],
            want: [],
        }
        expect((await send(app, common)).status).toBe(200)
        const read = async (query: string): Promise<Extract<ScreensV2Result, { status: 'ok' }>['value']> => {
            const response = await send(
                app,
                { ...common, op: 'progress', focusKey: null, want: ['guide:step-1'] },
                { query },
            )
            const result = screensV2ResultSchema.parse(await response.json())
            if (result.status !== 'ok') throw new Error('expected ok')
            return result.value
        }
        expect(await read('')).toEqual({ document: null, documents: [], progress: null })
        const cancelled = screensV2ResultSchema.parse(
            await (await send(app, { ...common, op: 'cancel', focusKey: null }, { query: '' })).json(),
        )
        if (cancelled.status !== 'ok') throw new Error('expected ok')
        expect(cancelled.value.progress).toBeNull()
        expect((await send(app, { ...common, requestId: 'old-job' }, { query: '' })).status).toBe(200)
        await vi.waitFor(async () => {
            const capable = await read('?guideRepair=1&stepActions=1')
            const legacy = await read('')
            expect(capable.documents[0]?.metadata).toMatchObject({ source: 'generated', repaired: true })
            expect(legacy.documents[0]?.metadata).toMatchObject({ source: 'fallback', repaired: false })
        })
    })

    it('precomputes, reports progress with first pages early, and cancels', async () => {
        const app = fixtureApp()
        const session = demoSession()
        const base = generate(documentInputs('guide', session))
        const common = {
            mode: 'model',
            requestId: 'job-1',
            binding: base.binding,
            session,
            manualHash: base.manualHash,
            kind: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            contextKey: null,
            focusKey: 'guide:step-1',
            want: [] as string[],
            uiState: fullUi,
        }
        const started = await (await send(app, { ...common, op: 'precompute' })).json()
        expect(started.status).toBe('ok')
        expect(started.value.progress.items.map((item: { key: string }) => item.key)).toContain('guide:step-1')
        await vi.waitFor(async () => {
            const read = await (await send(app, { ...common, op: 'progress', want: ['guide:step-1'] })).json()
            expect(read.value.documents).toHaveLength(1)
            expect(read.value.documents[0].bound.stepId).toBe('step-1')
        })
        const cancelled = await (await send(app, { ...common, op: 'cancel' })).json()
        expect(cancelled.status).toBe('ok')
        // A precompute needs a session; a progress read needs a binding.
        expect((await send(app, { ...common, op: 'precompute', session: null, manualHash: null })).status).toBe(400)
        expect((await send(app, { ...common, op: 'progress', binding: null })).status).toBe(400)
    })
})

describe('POST /api/screens/v2 (live wire)', () => {
    function liveApp(
        output: (index: number) => unknown | Promise<unknown>,
        status = 'completed',
    ): { app: ReturnType<typeof createApp>; bodies: Record<string, unknown>[] } {
        vi.spyOn(console, 'info').mockImplementation((): void => {})
        const bodies: Record<string, unknown>[] = []
        const transport: typeof fetch = async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
            const request = bodies[bodies.length - 1]!
            return Response.json({
                id: 'resp_1',
                object: 'response',
                status,
                model: request.model,
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: JSON.stringify(await output(bodies.length - 1)) }],
                    },
                ],
                usage: {
                    input_tokens: 321,
                    input_tokens_details: { cached_tokens: 21 },
                    output_tokens: 123,
                    output_tokens_details: { reasoning_tokens: 23 },
                },
            })
        }
        const runtime = createRuntimeFromEnvironment(
            { PROVIDER_MODE: 'meta', MODEL_API_KEY: '<synthetic>', API_SHARED_SECRET: KEY },
            transport,
        )
        return { app: createApp({ runtime, onDuration: () => {} }), bodies }
    }

    it('sends only documented parameters, a text-only prompt and a finite schema, and records what came back', async () => {
        const inputs = documentInputs('guide')
        const wire = encodeWireProposal(buildFallbackProposalV2(buildDocumentContext(inputs).material))
        const { app, bodies } = liveApp(() => wire)
        const response = await send(app, generate(inputs))
        expect(response.status).toBe(200)
        const body = screensV2ResultSchema.parse(await response.json())
        if (body.status !== 'ok') throw new Error('expected ok')
        expect(body.value.document!.metadata).toMatchObject({
            source: 'generated',
            evidence: 'live',
            model: 'muse-wonder-1.0',
            effort: 'medium',
            stage: 'step-page',
            usage: { inputTokens: 321, cachedTokens: 21, outputTokens: 123, reasoningTokens: 23 },
        })
        expect(bodies).toHaveLength(1)
        const sent = bodies[0]!
        expect(Object.keys(sent).sort()).toEqual([
            'input',
            'instructions',
            'max_output_tokens',
            'model',
            'prompt_cache_key',
            'reasoning',
            'store',
            'stream',
            'text',
        ])
        expect(sent).toMatchObject({
            model: 'muse-wonder-1.0',
            store: false,
            stream: false,
            // Documents use their own cap; PIECES keeps the full step-page geometry cap.
            max_output_tokens: 8_000,
            reasoning: { effort: 'medium' },
            text: { format: { type: 'json_schema', name: 'truebuild_document', strict: true } },
        })
        const schema = (sent.text as { format: { schema: unknown } }).format.schema
        expect(JSON.stringify(schema)).not.toContain('$ref')
        const content = JSON.stringify(sent.input)
        expect(content).not.toContain('input_image')
        expect(content).toContain('safety:n1')
        expect(String(sent.instructions)).toContain('Whole-screen composition')
    })

    it('rejects an answer that omits the safety fact, repairs once with codes only, then publishes the complete fallback', async () => {
        const inputs = documentInputs('guide')
        const context = buildDocumentContext(inputs)
        const proposal = buildFallbackProposalV2(context.material)
        const omitting = encodeWireProposal({
            ...proposal,
            body: { type: 'Spacer', size: 'md' },
        })
        const { app, bodies } = liveApp(() => omitting)
        const response = await send(app, generate(inputs))
        const body = screensV2ResultSchema.parse(await response.json())
        if (body.status !== 'ok') throw new Error('expected ok')
        const metadata = body.value.document!.metadata
        expect(metadata).toMatchObject({
            source: 'fallback',
            fallbackReason: 'repair_failed',
            repaired: true,
            evidence: 'live',
        })
        expect(bodies).toHaveLength(2)
        expect(bodies.map((body) => body.max_output_tokens)).toEqual([8_000, 8_000])
        expect(String(bodies[1]!.instructions)).toContain('Repair:')
        // Both attempts' tokens are summed; nothing is credited to a model that did not produce the shown document.
        expect(metadata.usage.inputTokens).toBe(642)
        expect(body.value.document!.facts.map((fact) => fact.factId)).toContain('safety:n1')
    })

    it.each(['', '?guideRepair=0', '?guideRepair=true', '?guideRepair=1&guideRepair=1'])(
        'gives absent or invalid capability %s one primary and no repair',
        async (query) => {
            const { app, bodies } = liveApp(() => ({}))
            const response = await send(app, generate(documentInputs('guide')), { query })
            expect(response.status).toBe(200)
            const body = screensV2ResultSchema.parse(await response.json())
            if (body.status !== 'ok') throw new Error('expected ok')
            expect(body.value.document!.metadata).toMatchObject({
                source: 'fallback',
                fallbackReason: 'invalid_output',
                repaired: false,
            })
            expect(bodies).toHaveLength(1)
            expect(bodies[0]!.max_output_tokens).toBe(8_000)
        },
    )

    it('isolates capable in-flight work and its cache from an installed client', async () => {
        let release: (() => void) | undefined
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        const inputs = documentInputs('guide')
        const complete = encodeWireProposal(buildFallbackProposalV2(buildDocumentContext(inputs).material))
        const { app, bodies } = liveApp(async (index) => {
            if (index === 0) {
                await held
                return complete
            }
            return {}
        })
        const capable = send(app, generate(inputs, 'capable'))
        await vi.waitFor(() => expect(bodies).toHaveLength(1))
        const old = screensV2ResultSchema.parse(await (await send(app, generate(inputs, 'old'), { query: '' })).json())
        if (old.status !== 'ok') throw new Error('expected ok')
        expect(old.value.document!.metadata).toMatchObject({ source: 'fallback', repaired: false })
        expect(bodies).toHaveLength(2)
        release!()
        expect((await capable).status).toBe(200)
        const after = screensV2ResultSchema.parse(
            await (await send(app, generate(inputs, 'old-again'), { query: '' })).json(),
        )
        if (after.status !== 'ok') throw new Error('expected ok')
        expect(after.value.document!.metadata).toMatchObject({ source: 'fallback', cacheHit: false, repaired: false })
        expect(bodies).toHaveLength(3)
    })

    it('reports an incomplete response honestly: no repair, no claim, the complete fallback', async () => {
        const inputs = documentInputs('guide')
        const { app, bodies } = liveApp(() => ({}), 'incomplete')
        const body = screensV2ResultSchema.parse(await (await send(app, generate(inputs))).json())
        if (body.status !== 'ok') throw new Error('expected ok')
        expect(body.value.document!.metadata).toMatchObject({ source: 'fallback', repaired: false })
        expect(bodies).toHaveLength(1)
    })
})

describe('a verdict check that names a version 2 document', () => {
    it('resolves the issued identity and refuses a foreign key or an unknown page', async () => {
        vi.spyOn(console, 'info').mockImplementation((): void => {})
        const mock = await startMetaMock({ scenario: 'uncertain' })
        try {
            const bytes = new Uint8Array(
                await sharp({ create: { width: 20, height: 16, channels: 3, background: 'red' } })
                    .png()
                    .toBuffer(),
            )
            const session = demoSession()
            session.pages[0] = {
                ...session.pages[0]!,
                width: 20,
                height: 16,
                contentHash: createHash('sha256').update(bytes).digest('hex'),
            }
            const inputs = documentInputs('guide', session)
            const wire = encodeWireProposal(buildFallbackProposalV2(buildDocumentContext(inputs).material))
            const transport: typeof fetch = async (url, init) =>
                String(init?.body).includes('truebuild_document')
                    ? Response.json({
                          id: 'resp_1',
                          object: 'response',
                          status: 'completed',
                          model: 'muse-wonder-1.0',
                          output: [
                              {
                                  type: 'message',
                                  role: 'assistant',
                                  status: 'completed',
                                  content: [{ type: 'output_text', text: JSON.stringify(wire) }],
                              },
                          ],
                          usage: { input_tokens: 1, output_tokens: 1 },
                      })
                    : mock.transport(url, init)
            const runtime = createRuntimeFromEnvironment(
                { PROVIDER_MODE: 'meta', MODEL_API_KEY: '<synthetic>', API_SHARED_SECRET: KEY },
                transport,
            )
            const app = createApp({ runtime, onDuration: () => {} })
            const generated = screensV2ResultSchema.parse(await (await send(app, generate(inputs))).json())
            if (generated.status !== 'ok') throw new Error('expected ok')
            const document = generated.value.document!
            expect(document.metadata.source).toBe('generated')
            const check = (screen: unknown): Promise<Response> => {
                const body = new FormData()
                body.set(
                    'metadata',
                    JSON.stringify({
                        mode: 'model',
                        requestId: `check-${Math.random()}`,
                        binding: {
                            kind: 'capture',
                            manualId: session.manualId,
                            revision: session.revision,
                            stepId: 'step-1',
                            captureId: 'c1',
                        },
                        session,
                        sourcePageIds: ['demo-page-1'],
                        observation: { mimeType: 'image/png', width: 20, height: 16 },
                        screen,
                    }),
                )
                body.set('source-0', new Blob([bytes], { type: 'image/png' }), 'source.png')
                body.set('observation', new Blob([bytes], { type: 'image/png' }), 'observation.png')
                return Promise.resolve(
                    app.request('/api/checks', { method: 'POST', headers: { 'x-truebuild-key': KEY }, body }),
                )
            }
            const own = { screenId: document.screenId, contextKey: document.bound.contextKey }
            expect((await check(own)).status).toBe(200)
            expect((await check({ ...own, contextKey: 'b'.repeat(64) })).status).toBe(400)
            expect((await check({ screenId: 'c'.repeat(64), contextKey: own.contextKey })).status).toBe(400)
        } finally {
            await mock.close()
        }
    })
})
