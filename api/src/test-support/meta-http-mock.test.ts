import type { ProviderMetrics } from '../providers/meta-transport'
import { ModelCallCounter } from '../server/budget'
import { createHash } from 'node:crypto'
import { createDemoManual } from '@truebuild/contracts'
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
                kind: 'capture',
                manualId: session.manualId,
                revision: 1,
                stepId: 'step-1',
                captureId: 'capture-test',
            }
            const send = async (
                route: string,
                metadata: unknown,
                names: string[],
            ): Promise<Record<string, unknown>> => {
                const form = new FormData()
                form.set('metadata', JSON.stringify(metadata))
                names.forEach((name) => form.set(name, new Blob([bytes], { type: 'image/png' }), 'image.png'))
                const response = await app.request(route, {
                    method: 'POST',
                    headers: { 'x-truebuild-key': 'synthetic' },
                    body: form,
                })
                expect(response.status).toBe(200)
                return (await response.json()) as Record<string, unknown>
            }
            const pages = [
                session.pages[0]!,
                ...Array.from({ length: 19 }, (_, i) => ({
                    ...session.pages[0]!,
                    pageId: `page-${i}`,
                    assetId: `asset-${i}`,
                })),
            ]
            expect(
                await send(
                    '/api/manuals/parse',
                    {
                        mode: 'model',
                        requestId: 'parse-many',
                        binding: { ...binding, kind: 'manual', stepId: undefined, captureId: undefined },
                        pages,
                    },
                    pages.map((_, i) => `source-${i}`),
                ),
            ).toMatchObject({ status: 'ok', mode: 'model' })
            const metadata = {
                mode: 'model',
                requestId: 'check-test',
                binding,
                session,
                sourcePageIds: [session.pages[0]!.pageId],
                observation: { mimeType: 'image/png', width: 20, height: 16 },
            }
            expect(await send('/api/checks', metadata, ['source-0', 'observation'])).toMatchObject({
                value: { decision: 'refuse', observedRegion: { x: 0.3, y: 0.2, width: 0.2, height: 0.65 } },
            })
            expect(
                await send(
                    '/api/questions',
                    {
                        ...metadata,
                        requestId: 'ask-test',
                        question: 'Which edge?',
                        target: { kind: 'point', x: 0.5, y: 0.5 },
                    },
                    ['source-0', 'observation'],
                ),
            ).toMatchObject({ value: { sourceRefs: [{ pageId: session.pages[0]!.pageId, region: null }] } })
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
                    usage: kind === 'video' ? { video_frames_processed: 2 } : { images_processed: 1 },
                },
            })
            expect(mock.failures).toEqual([])
        } finally {
            await mock.close()
        }
    },
)
