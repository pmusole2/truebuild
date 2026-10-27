import type { ProviderMetrics } from '../providers/meta-transport'
import { ModelCallCounter } from '../server/budget'
import { createHash } from 'node:crypto'
import { createDemoManual } from '@truebuild/contracts'
import { MODEL_METADATA_MAX_BYTES } from '@truebuild/contracts/model'
import { ModelApiClient } from '../../../app/src/api/model-client'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { createRuntimeFromEnvironment } from '../server/model-runtime'
import { createSamProvider } from '../providers/sam'
import { uploadMetaFile } from '../providers/meta-files'
import { MOCK_PROVIDER_KEY, startMetaMock } from './meta-http-mock'

async function media(): Promise<{ session: ReturnType<typeof createDemoManual>; bytes: Uint8Array<ArrayBuffer> }> {
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
    return { session, bytes }
}

describe('documented loopback mock with real API composition', () => {
    it('parses twenty pages, checks and asks over authenticated multipart without a SAM still call', async () => {
        const mock = await startMetaMock({ scenario: 'reversed' })
        try {
            const runtime = createRuntimeFromEnvironment(
                { PROVIDER_MODE: 'meta', MODEL_API_KEY: '<synthetic>', API_SHARED_SECRET: 'synthetic' },
                mock.transport,
            )
            const app = createApp({ runtime, onDuration: () => {} })
            const { session, bytes } = await media()
            const binding = {
                kind: 'capture' as const,
                manualId: session.manualId,
                revision: 1,
                stepId: 'step-1',
                captureId: 'capture-test',
            }
            const client = new ModelApiClient({
                // Hono admission runs in-process; only the documented Meta provider mock uses loopback HTTP.
                baseUrl: 'http://127.0.0.1:3001',
                secret: 'synthetic',
                fetch: async (url, init): Promise<Response> => app.request(new URL(url).pathname, init),
            })
            const pages = [
                session.pages[0]!,
                ...Array.from({ length: 19 }, (_, i) => ({
                    ...session.pages[0]!,
                    pageId: `page-${i}`,
                    assetId: `asset-${i}`,
                })),
            ]
            const image = { bytes, mimeType: 'image/png' as const, width: 20, height: 16 }
            const images = pages.map(() => image)
            expect(
                await client.parse(
                    { kind: 'manual', manualId: session.manualId, revision: session.revision },
                    pages,
                    images,
                    { requestId: 'parse-many' },
                ),
            ).toMatchObject({ status: 'ok', mode: 'model' })
            session.pages = pages
            // Exercise the shared 512 KiB boundary with valid context larger than the retired 64 KiB cap.
            session.parts.push(
                ...Array.from({ length: 250 }, (_, i) => ({
                    partId: `extra-${i}`,
                    name: {
                        state: 'known' as const,
                        value: 'x'.repeat(200),
                        sourceRefs: [{ pageId: pages[0]!.pageId, region: null }],
                    },
                })),
            )
            const metadataBytes = Buffer.byteLength(JSON.stringify(session))
            expect(metadataBytes).toBeGreaterThan(65_536)
            expect(metadataBytes).toBeLessThan(MODEL_METADATA_MAX_BYTES)
            const pageIds = pages.map((page) => page.pageId)
            expect(
                await client.check(binding, session, pageIds, images, image, { requestId: 'check-test' }),
            ).toMatchObject({
                status: 'ok',
                mode: 'model',
                value: { decision: 'refuse', observedRegion: { x: 0.3, y: 0.2, width: 0.2, height: 0.65 } },
            })
            expect(
                await client.questions(
                    binding,
                    session,
                    pageIds,
                    images,
                    image,
                    'Which edge?',
                    { kind: 'point', x: 0.5, y: 0.5 },
                    { requestId: 'ask-test' },
                ),
            ).toMatchObject({
                status: 'ok',
                mode: 'model',
                value: { sourceRefs: [{ pageId: pages[0]!.pageId, region: null }] },
            })
            expect(
                mock.wireRequests.map(
                    (request) => request.input[0].content.filter((part) => part.type === 'input_image').length,
                ),
            ).toEqual([20, 21, 21])
            expect(runtime.counter.used).toBe(3)
            expect(mock.requests.map((request) => request.operation)).toEqual(['parse', 'check', 'question'])
            expect(mock.failures).toEqual([])
            const json = await app.request('/api/checks', {
                method: 'POST',
                headers: { 'x-truebuild-key': 'synthetic', 'content-type': 'application/json' },
                body: JSON.stringify({ mode: 'fixture' }),
            })
            expect(json.status).toBe(415)
        } finally {
            await mock.close()
        }
    })
    it.each(['omitted', 'null', 'timestamp'] as const)(
        'handles Files response expires_at %s over HTTP',
        async (fileExpiration) => {
            const mock = await startMetaMock({ fileExpiration })
            try {
                expect(
                    (
                        await uploadMetaFile(
                            {
                                apiKey: MOCK_PROVIDER_KEY,
                                counter: new ModelCallCounter(1),
                                file: new File(['synthetic'], 'image.png'),
                                expiresAfterSeconds: 3600,
                                fetchImpl: mock.transport,
                            },
                            new AbortController().signal,
                        )
                    ).id,
                ).toBe('file-842549258569145')
                expect(mock.failures).toEqual([])
            } finally {
                await mock.close()
            }
        },
    )
    it.each(['correct', 'failed', 'incomplete', 'zero', 'truncated'] as const)(
        'consumes documented SAM %s terminal through official parser over HTTP',
        async (scenario) => {
            const mock = await startMetaMock({ scenario })
            try {
                const { bytes } = await media()
                const metrics: ProviderMetrics[] = []
                const provider = createSamProvider({
                    apiKey: MOCK_PROVIDER_KEY,
                    fetchImpl: mock.transport,
                    onMetrics: (metric) => metrics.push(metric),
                })
                const events = []
                for await (const event of provider.segment(
                    {
                        requestId: 'sam-test',
                        binding: {
                            kind: 'capture',
                            manualId: 'manual-test',
                            revision: 1,
                            stepId: 'step-test',
                            captureId: 'capture-test',
                        },
                        capturedAt: '2026-01-01T00:00:00Z',
                        prompt: 'red panel',
                        media: { kind: 'image', image: { bytes, width: 20, height: 16, mimeType: 'image/png' } },
                    },
                    new AbortController().signal,
                ))
                    events.push(event)
                expect(events.at(-1)?.type).toBe(
                    scenario === 'correct' || scenario === 'zero' ? 'completed' : 'unavailable',
                )
                if (scenario === 'correct') expect(events[0]?.type).toBe('snapshot')
                if (scenario === 'zero') expect(events).toEqual([{ type: 'completed' }])
                if (scenario !== 'truncated') expect(metrics.some((metric) => metric.imagesProcessed === 1)).toBe(true)
                expect(JSON.stringify(metrics)).not.toContain('Synthetic provider failure')
                expect(mock.failures).toEqual([])
            } finally {
                await mock.close()
            }
        },
    )
    it('refuses real credentials before forwarding anything to loopback', async () => {
        const mock = await startMetaMock()
        try {
            await expect(
                mock.transport('https://api.meta.ai/v1/responses', { headers: { authorization: 'Bearer other' } }),
            ).rejects.toThrow()
            expect(mock.requests).toEqual([])
        } finally {
            await mock.close()
        }
    })
})

// These exercise actual multipart admission, source custody, normalization and provider request construction.
it.each([3, 20])(
    'sends %i full sources plus observation and keeps the prefix stable across steps and ask',
    async (count) => {
        const mock = await startMetaMock({ scenario: 'correct' })
        try {
            const { session, bytes } = await media()
            for (let i = 1; i < count; i++)
                session.pages.push({ ...session.pages[0]!, pageId: `page-${i}`, assetId: `asset-${i}` })
            session.reviewedSteps[0]!.sourceRefs.push({ pageId: 'page-2', region: null })
            const runtime = createRuntimeFromEnvironment(
                { MODEL_API_KEY: '<synthetic>', API_SHARED_SECRET: 'synthetic' },
                mock.transport,
            )
            const app = createApp({ runtime, onDuration: () => {} })
            for (const [index, route] of ['/api/checks', '/api/checks', '/api/questions'].entries()) {
                const stepId = index === 0 ? 'step-1' : 'step-2'
                const form = new FormData()
                form.set(
                    'metadata',
                    JSON.stringify({
                        mode: 'model',
                        requestId: `full-${index}`,
                        session,
                        binding: {
                            kind: 'capture',
                            manualId: session.manualId,
                            revision: 1,
                            stepId,
                            captureId: `capture-${index}`,
                        },
                        sourcePageIds: session.pages.map((page) => page.pageId),
                        observation: { mimeType: 'image/png', width: 20, height: 16 },
                        ...(index === 2 ? { question: 'Which edge?', target: { kind: 'point', x: 0.5, y: 0.5 } } : {}),
                    }),
                )
                session.pages.forEach((_, i) =>
                    form.set(`source-${i}`, new Blob([bytes], { type: 'image/png' }), 'source.png'),
                )
                const observation = new Uint8Array(
                    await sharp({
                        create: { width: 20, height: 16, channels: 3, background: ['red', 'blue', 'green'][index]! },
                    })
                        .png()
                        .toBuffer(),
                )
                form.set('observation', new Blob([observation], { type: 'image/png' }), 'observation.png')
                const response = await app.request(route, {
                    method: 'POST',
                    headers: { 'x-truebuild-key': 'synthetic' },
                    body: form,
                })
                expect(response.status).toBe(200)
                expect(await response.json()).toMatchObject({ status: 'ok' })
            }
            expect(mock.failures).toEqual([])
            expect(mock.wireRequests).toHaveLength(3)
            const first = mock.wireRequests[0]!
            const prefix = first.input[0].content.slice(0, count + 1)
            const stable = JSON.parse((prefix[0] as { text: string }).text).manualContext
            expect(stable.plan.steps).toEqual(session.reviewedSteps)
            expect(stable.parts).toEqual(session.parts)
            expect(stable.sourcePages).toEqual(session.pages)
            for (const request of mock.wireRequests) {
                expect(request.instructions).toBe(first.instructions)
                expect(request.input[0].content.slice(0, count + 1)).toEqual(prefix)
                expect(request.input[0].content.filter((part) => part.type === 'input_image')).toHaveLength(count + 1)
            }
            expect(runtime.counter.used).toBe(3)
        } finally {
            await mock.close()
        }
    },
)

it.each([2, 3])('compact mode covers %i cited pages or refuses without provider dispatch', async (required) => {
    const mock = await startMetaMock({ scenario: 'correct' })
    try {
        const { session, bytes } = await media()
        for (let i = 1; i < 4; i++)
            session.pages.push({ ...session.pages[0]!, pageId: `page-${i}`, assetId: `asset-${i}` })
        // Used-part names are evidence too, not just the step's diagram.
        const part = session.parts[0]!
        if (part.name.state === 'known') part.name.sourceRefs.push({ pageId: 'page-1', region: null })
        if (required === 3) session.reviewedSteps[0]!.sourceRefs.push({ pageId: 'page-2', region: null })
        const runtime = createRuntimeFromEnvironment(
            { MODEL_API_KEY: '<synthetic>', API_SHARED_SECRET: 'synthetic', MODEL_CHECK_CONTEXT: 'compact' },
            mock.transport,
        )
        const app = createApp({ runtime, onDuration: () => {} })
        const form = new FormData()
        form.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'compact',
                session,
                binding: {
                    kind: 'capture',
                    manualId: session.manualId,
                    revision: 1,
                    stepId: 'step-1',
                    captureId: 'capture',
                },
                sourcePageIds: session.pages.map((page) => page.pageId),
                observation: { mimeType: 'image/png', width: 20, height: 16 },
            }),
        )
        session.pages.forEach((_, i) => form.set(`source-${i}`, new Blob([bytes], { type: 'image/png' }), 'source.png'))
        form.set('observation', new Blob([bytes], { type: 'image/png' }), 'observation.png')
        const response = await app.request('/api/checks', {
            method: 'POST',
            headers: { 'x-truebuild-key': 'synthetic' },
            body: form,
        })
        expect(response.status).toBe(200)
        const result = await response.json()
        if (required === 3) {
            expect(result.value).toMatchObject({ decision: 'cannot_verify' })
            expect(result.value.reason).toMatch(/compact.*cit.*two/i)
            expect(mock.requests).toEqual([])
        } else {
            expect(result.value.decision).toBe('pass')
            const wire = mock.wireRequests[0]!
            const first = wire.input[0].content[0] as { text: string }
            expect(
                JSON.parse(first.text).manualContext.sourcePages.map((page: { pageId: string }) => page.pageId),
            ).toEqual(['demo-page-1', 'page-1'])
            expect(wire.input[0].content.filter((part) => part.type === 'input_image')).toHaveLength(3)
        }
        expect(mock.failures).toEqual([])
    } finally {
        await mock.close()
    }
})

it.each(['image', 'video'] as const)(
    'accepts documented SAM %s examples with optional metadata and full terminal usage',
    async (kind) => {
        const mock = await startMetaMock({ scenario: 'correct' })
        try {
            const response = await mock.transport('https://api.meta.ai/v1/responses', {
                method: 'POST',
                headers: { authorization: `Bearer ${MOCK_PROVIDER_KEY}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: 'sam-3.1',
                    stream: true,
                    metadata: { mask_encoding: 'one_bit' },
                    input: [
                        {
                            type: 'message',
                            role: 'user',
                            content: [
                                { type: 'input_text', text: 'glasses' },
                                kind === 'image'
                                    ? { type: 'input_image', image_url: 'https://example.com/photo.png' }
                                    : { type: 'input_video', file_id: 'file-842549258569145' },
                            ],
                        },
                    ],
                }),
            })
            expect(response.status).toBe(200)
            const events = (await response.text())
                .trim()
                .split('\n\n')
                .map((line) => JSON.parse(line.replace(/^data: /, '')))
            expect(events.filter((event) => event.type === 'response.output_text.delta')).toHaveLength(
                kind === 'video' ? 2 : 1,
            )
            expect(events.at(-1)).toMatchObject({
                type: 'response.completed',
                sequence_number: kind === 'video' ? 3 : 2,
                response: {
                    object: 'response',
                    status: 'completed',
                    model: 'sam-3.1',
                    error: null,
                    usage: kind === 'video' ? { video_frames_processed: 50 } : { images_processed: 1 },
                },
            })
            expect(mock.failures).toEqual([])
        } finally {
            await mock.close()
        }
    },
)

it.each(['correct', 'reversed', 'uncertain', 'failed'] as const)(
    'runs separate %s follow-up through real Hono admission and loopback Meta transport',
    async (scenario) => {
        const mock = await startMetaMock({ scenario: 'uncertain', secondOpinion: { scenario } })
        try {
            const runtime = createRuntimeFromEnvironment(
                {
                    MODEL_API_KEY: '<synthetic>',
                    API_SHARED_SECRET: 'synthetic',
                    MODEL_SECOND_OPINION: 'muse-wonder-1.0',
                },
                mock.transport,
            )
            const app = createApp({ runtime, onDuration: () => {} })
            const { session, bytes } = await media()
            const metadata = {
                mode: 'model',
                requestId: 'secondary-mock',
                session,
                sourcePageIds: ['demo-page-1'],
                binding: {
                    kind: 'capture',
                    manualId: session.manualId,
                    revision: session.revision,
                    stepId: 'step-1',
                    captureId: 'capture-1',
                },
                observation: { mimeType: 'image/png', width: 20, height: 16 },
            }
            const send = async (
                token?: string,
                key = 'synthetic',
                origin = 'http://localhost:8081',
            ): Promise<Response> => {
                const form = new FormData()
                form.set('metadata', JSON.stringify({ ...metadata, ...(token ? { secondOpinionToken: token } : {}) }))
                for (const name of ['source-0', 'observation'])
                    form.set(name, new Blob([bytes], { type: 'image/png' }), 'test.png')
                // Serialize the client wire body first: Node 24's lazy FormData encoder throws when
                // cancelled before its first pull, unlike an inbound HTTP request byte stream.
                const encoded = new Request('http://localhost/', { method: 'POST', body: form })
                const wireBytes = await encoded.arrayBuffer()
                return app.request(token ? '/api/checks/second-opinion' : '/api/checks', {
                    method: 'POST',
                    headers: { 'x-truebuild-key': key, origin, 'content-type': encoded.headers.get('content-type')! },
                    body: wireBytes,
                })
            }
            const primary = await (await send()).json()
            expect(primary).toMatchObject({
                status: 'ok',
                value: {
                    model: 'muse-spark-1.3',
                    decision: 'cannot_verify',
                    secondOpinion: { model: 'muse-wonder-1.0', status: 'available' },
                },
            })
            expect(mock.requests.map((r) => r.operation)).toEqual(['check'])
            const token = primary.value.secondOpinion.token
            expect((await send(token, 'wrong')).status).toBe(401)
            expect((await send(token, 'synthetic', 'https://bad.example')).status).toBe(403)
            const preflight = await app.request('/api/checks/second-opinion', {
                method: 'OPTIONS',
                headers: {
                    origin: 'http://localhost:8081',
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'x-truebuild-key',
                },
            })
            expect(preflight.status).toBe(204)
            const response = await send(token)
            expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:8081')
            const secondary = await response.json()
            expect(secondary).toMatchObject({
                status: 'ok',
                requestId: metadata.requestId,
                binding: metadata.binding,
                value: {
                    decision: scenario === 'reversed' ? 'refuse' : 'cannot_verify',
                    model: scenario === 'reversed' ? 'muse-wonder-1.0' : 'muse-spark-1.3',
                    secondOpinion: {
                        model: 'muse-wonder-1.0',
                        status: scenario === 'failed' ? 'unavailable' : 'completed',
                    },
                },
            })
            expect(secondary.value.modelNotes.length).toBeGreaterThan(0)
            expect((await send(token)).status).toBe(409)
            expect(mock.requests.map((r) => r.operation)).toEqual(['check', 'second_opinion'])
            expect(mock.wireRequests.map((r) => [r.model, r.reasoning?.effort])).toEqual([
                ['muse-spark-1.3', 'low'],
                ['muse-wonder-1.0', 'high'],
            ])
            expect(mock.failures).toEqual([])
            expect(runtime.counter.used).toBe(2)
        } finally {
            await mock.close()
        }
    },
)
