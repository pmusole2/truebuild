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
                ).toBe('file-mock')
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
                const provider = createSamProvider({ apiKey: MOCK_PROVIDER_KEY, fetchImpl: mock.transport })
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
