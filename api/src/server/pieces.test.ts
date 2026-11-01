import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import {
    pieceBatchResultSchema,
    type ManualPieceInput,
    type PieceBatchRequest,
    type SegmentEvent,
} from '@truebuild/contracts'
import { createPieceHandler } from './pieces'
import { createBackgroundWork, guardModelFetch } from './model-service'
import { ConcurrencyGate, ModelCallCounter } from './budget'
import { SharedKeyAuth } from './auth'
import { createMetaProvider } from '../providers/meta-provider'

it('retains valid siblings and SAM cutouts, rejects invalid geometry, and repairs only the next requested batch', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4a7fb0' } })
        .png()
        .toBuffer()
    const part = (id: string): ManualPieceInput => ({
        id,
        name: id,
        quantity: 1,
        label: null,
        dimensions: null,
        pageId: 'page-1',
    })
    const spec = (id: string, width = 1): object => ({
        id,
        name: id,
        color: '#4a7fb0',
        parts: [{ type: 'box', dimensions: { width, height: 1, depth: 1 }, position: [0, 0, 0], rotation: [0, 0, 0] }],
    })
    const bodies: unknown[] = []
    const provider = createMetaProvider({
        apiKey: 'synthetic-pieces-provider-key',
        fetchImpl: guardModelFetch(async (_url, init): Promise<Response> => {
            bodies.push(JSON.parse(String(init?.body)) as unknown)
            const pieces = bodies.length === 1 ? [spec('bracket'), spec('pin', -1)] : [spec('pin')]
            return Response.json({
                status: 'completed',
                model: 'muse-wonder-1.0',
                usage: { input_tokens: 100, output_tokens: 100 },
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: JSON.stringify({ pieces }) }],
                    },
                ],
            })
        }),
    })
    const generatePieces = vi.spyOn(provider, 'generatePieces')
    let segmentCalls = 0
    const counter = new ModelCallCounter()
    const handler = createPieceHandler({
        auth: new SharedKeyAuth({ sharedSecret: 'pieces-test-key' }),
        runtimeMode: 'meta',
        provider,
        samProvider: {
            async *segment(input): AsyncIterable<SegmentEvent> {
                segmentCalls++
                yield {
                    type: 'snapshot',
                    snapshot: {
                        binding: input.binding,
                        streamId: 'sam-stream',
                        frameIndex: 0,
                        capturedAt: input.capturedAt,
                        complete: true,
                        records: [
                            {
                                objectId: 'object-1',
                                label: input.prompt,
                                box: { x: 0, y: 0, width: 1, height: 1 },
                                mask: { width: 8, height: 8, path: 'M0 0 L8 0 L0 8 Z' },
                            },
                        ],
                    },
                }
                yield { type: 'completed' }
            },
        },
        work: createBackgroundWork(counter, new ConcurrencyGate(8)),
        deadlineMs: 45_000,
    })
    const metadata: PieceBatchRequest = {
        requestId: 'pieces-test',
        contentHash: 'a'.repeat(64),
        parts: [part('bracket'), part('pin')],
        pages: [{ pageId: 'page-1', width: 8, height: 8, mimeType: 'image/png' }],
    }
    const request = (value: PieceBatchRequest, authenticated = true): Request => {
        const form = new FormData()
        form.set('metadata', JSON.stringify(value))
        for (const page of value.pages)
            form.set(`page:${page.pageId}`, new File([png], 'page.png', { type: 'image/png' }))
        return new Request('http://localhost/api/pieces', {
            method: 'POST',
            headers: authenticated ? { 'x-truebuild-key': 'pieces-test-key' } : {},
            body: form,
        })
    }
    const unauthorized = await handler(request(metadata, false))
    expect(unauthorized.status).toBe(401)
    expect(generatePieces).not.toHaveBeenCalled()
    const response = await handler(request(metadata))
    expect(response.status).toBe(200)
    const first = pieceBatchResultSchema.parse(await response.json())
    expect(first.results.map((value) => value.status)).toEqual(['passed', 'invalid'])
    expect(first.results[0]!.piece?.id).toBe('bracket')
    expect(first.results[1]!.piece).toBeNull()
    expect(first.results[1]!.issueCodes).toContain('parts.0.dimensions.width:too_small')
    expect(first.results.every((value) => value.cutoutUri?.startsWith('data:image/png;base64,'))).toBe(true)
    const cutoutBytes = Buffer.from(first.results[0]!.cutoutUri!.split(',')[1]!, 'base64')
    expect((await sharp(cutoutBytes).stats()).isOpaque).toBe(false)
    expect(segmentCalls).toBe(2)
    expect(generatePieces).toHaveBeenCalledTimes(1)
    expect(bodies[0]).toMatchObject({
        model: 'muse-wonder-1.0',
        reasoning: { effort: 'medium' },
        max_output_tokens: 48_000,
        text: { format: { name: 'truebuild_pieces' } },
    })
    const failed = first.results[1]!
    const repaired = await handler(
        request({
            ...metadata,
            requestId: 'pieces-repair',
            pages: [],
            parts: [
                {
                    ...part('pin'),
                    pageId: null,
                    cutoutUri: failed.cutoutUri,
                    repair: { issueCodes: failed.issueCodes },
                },
            ],
        }),
    )
    const second = pieceBatchResultSchema.parse(await repaired.json())
    expect(second.results[0]).toMatchObject({
        status: 'repaired',
        piece: { id: 'pin' },
        cutoutUri: failed.cutoutUri,
        issueCodes: [],
    })
    expect(second).toMatchObject({ model: 'muse-wonder-1.0', effort: 'medium', contentHash: metadata.contentHash })
    expect(segmentCalls).toBe(2)
    expect(counter.used).toBe(4)
    const repairedInput: unknown = generatePieces.mock.calls[1]?.[0]
    expect(repairedInput).toMatchObject({
        imagePieceIds: ['pin'],
        parts: [{ repair: { issueCodes: failed.issueCodes } }],
    })
})
