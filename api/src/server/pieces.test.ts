import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import {
    pieceBatchResultSchema,
    parsedManualSchema,
    type ManualPieceInput,
    type PieceBatchRequest,
    type SegmentEvent,
} from '@truebuild/contracts'
import { createPieceHandler } from './pieces'
import { createBackgroundWork, guardModelFetch } from './model-service'
import { ConcurrencyGate, ModelCallCounter } from './budget'
import { SharedKeyAuth } from './auth'
import { createMetaProvider } from '../providers/meta-provider'

it('retains valid siblings and boxed crops through empty SAM, rejects invalid geometry, and repairs only the next requested batch', async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#4a7fb0' } })
        .png()
        .toBuffer()
    const parsePart = parsedManualSchema.shape.parts.element
    const namedPart = { partId: 'knob', name: { state: 'unknown', reason: 'No readable label' } }
    expect(parsePart.parse({ ...namedPart, drawingBox: [0.1, 0.2, 0.3, 0.4] }).drawingBox).toEqual([0.1, 0.2, 0.3, 0.4])
    for (const drawingBox of [[-0.1, 0, 1, 1], [0, 0, 0, 1], [0.9, 0, 0.2, 1], [0, 0, 1], 'invalid'])
        expect(parsePart.parse({ ...namedPart, drawingBox }).drawingBox).toBeUndefined()
    expect(parsePart.safeParse({ ...namedPart, unexpected: true }).success).toBe(false)
    const part = (id: string): ManualPieceInput => ({
        id,
        name: id,
        quantity: 1,
        label: null,
        dimensions: null,
        pageId: 'page-1',
        drawingBox: [0.25, 0.25, 0.5, 0.5],
    })
    const spec = (id: string, width = 1): object => ({
        id,
        name: id,
        color: '#4a7fb0',
        parts: [{ type: 'box', dimensions: { width, height: 1, depth: 1 }, position: [0, 0, 0], rotation: [0, 0, 0] }],
    })
    const bodies: unknown[] = []
    let finishSam: (() => void) | undefined
    const samWait = new Promise<void>((resolve) => {
        finishSam = resolve
    })
    let samFinished = false
    const samWidths: number[] = []
    let finishedSamWork = 0
    let allSamWorkDone: (() => void) | undefined
    const samWorkDone = new Promise<void>((resolve) => {
        allSamWorkDone = resolve
    })
    const provider = createMetaProvider({
        apiKey: 'synthetic-pieces-provider-key',
        fetchImpl: guardModelFetch(async (_url, init): Promise<Response> => {
            bodies.push(JSON.parse(String(init?.body)) as unknown)
            expect(samFinished).toBe(false)
            finishSam?.()
            if (bodies.length === 1) await samWorkDone
            const pieces = bodies.length === 1 ? [spec('bracket'), spec('pin', -1), spec('washer')] : [spec('pin')]
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
    const baseWork = createBackgroundWork(counter, new ConcurrencyGate(8))
    const handler = createPieceHandler({
        auth: new SharedKeyAuth({ sharedSecret: 'pieces-test-key' }),
        runtimeMode: 'meta',
        provider,
        samProvider: {
            async *segment(input): AsyncIterable<SegmentEvent> {
                segmentCalls++
                samWidths.push(input.media.kind === 'image' ? input.media.image.width : 0)
                await samWait
                samFinished = true
                if (input.prompt === 'bracket') {
                    yield { type: 'completed' }
                    return
                }
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
        work: {
            ...baseWork,
            async run(options, work) {
                const result = await baseWork.run(options, work)
                if (options.deadlineMs === 12_000 && ++finishedSamWork === 2) allSamWorkDone?.()
                return result
            },
        },
        deadlineMs: 45_000,
    })
    const metadata: PieceBatchRequest = {
        requestId: 'pieces-test',
        contentHash: 'a'.repeat(64),
        parts: [part('bracket'), { ...part('pin'), drawingBox: [-0.1, 0, 0.5, 0.5] }, part('washer')],
        pages: [{ pageId: 'page-1', width: 40, height: 40, mimeType: 'image/png' }],
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
    expect(first.results.map((value) => value.status)).toEqual(['passed', 'invalid', 'passed'])
    expect(first.results[0]!.piece?.id).toBe('bracket')
    expect(first.results[1]!.piece).toBeNull()
    expect(first.results[1]!.issueCodes).toContain('parts.0.dimensions.width:too_small')
    const plain = first.results[0]!.cutoutUri!
    expect(plain.startsWith('data:image/png;base64,')).toBe(true)
    expect(first.results[1]!.cutoutUri).toBeNull()
    const cutoutBytes = Buffer.from(plain.split(',')[1]!, 'base64')
    expect((await sharp(cutoutBytes).metadata()).width).toBe(22)
    expect((await sharp(cutoutBytes).stats()).isOpaque).toBe(true)
    const refined = Buffer.from(first.results[2]!.cutoutUri!.split(',')[1]!, 'base64')
    expect((await sharp(refined).stats()).isOpaque).toBe(false)
    const firstInput = generatePieces.mock.calls[0]![0]
    expect(firstInput.imagePieceIds).toEqual(['bracket', 'washer'])
    expect(Buffer.from(firstInput.images[0]!.bytes)).toEqual(cutoutBytes)
    expect(segmentCalls).toBe(2)
    expect(samWidths).toEqual([22, 22])
    expect(generatePieces).toHaveBeenCalledTimes(1)
    expect(bodies[0]).toMatchObject({
        model: 'muse-wonder-1.0',
        reasoning: { effort: 'high' },
        max_output_tokens: 48_000,
        text: { format: { name: 'truebuild_pieces' } },
    })
    const failed = first.results[1]!
    samFinished = false
    const repaired = await handler(
        request({
            ...metadata,
            requestId: 'pieces-repair',
            pages: [],
            parts: [
                {
                    ...part('pin'),
                    pageId: null,
                    cutoutUri: plain,
                    repair: { issueCodes: failed.issueCodes },
                },
            ],
        }),
    )
    const second = pieceBatchResultSchema.parse(await repaired.json())
    expect(second.results[0]).toMatchObject({
        status: 'repaired',
        piece: { id: 'pin' },
        cutoutUri: plain,
        issueCodes: [],
    })
    expect(second).toMatchObject({ model: 'muse-wonder-1.0', effort: 'high', contentHash: metadata.contentHash })
    expect(segmentCalls).toBe(2)
    expect(counter.used).toBe(4)
    expect(firstInput.parts[1]?.drawingBox).toBeUndefined()
    const repairedInput: unknown = generatePieces.mock.calls[1]?.[0]
    expect(repairedInput).toMatchObject({
        imagePieceIds: ['pin'],
        parts: [{ repair: { issueCodes: failed.issueCodes } }],
    })
    let optionalSignal: AbortSignal | undefined
    let finishHungSam: (() => void) | undefined
    const hungSam = new Promise<void>((resolve) => {
        finishHungSam = resolve
    })
    const hangingHandler = createPieceHandler({
        auth: new SharedKeyAuth({ sharedSecret: 'pieces-test-key' }),
        runtimeMode: 'meta',
        provider,
        samProvider: {
            async *segment(_input, signal): AsyncIterable<SegmentEvent> {
                optionalSignal = signal
                await hungSam
                yield { type: 'completed' }
            },
        },
        work: createBackgroundWork(new ModelCallCounter(), new ConcurrencyGate(8)),
        deadlineMs: 45_000,
    })
    let failedReturnTimer: ReturnType<typeof setTimeout> | undefined
    try {
        const quick = await Promise.race([
            hangingHandler(request({ ...metadata, requestId: 'pieces-hung-sam', parts: [part('pin')] })),
            new Promise<never>((_resolve, reject) => {
                failedReturnTimer = setTimeout(() => reject(new Error('SAM blocked completed geometry')), 500)
            }),
        ])
        const withoutRefinement = pieceBatchResultSchema.parse(await quick.json())
        expect(withoutRefinement.results[0]).toMatchObject({ status: 'passed', cutoutUri: plain })
        expect(optionalSignal?.aborted).toBe(true)
    } finally {
        clearTimeout(failedReturnTimer)
        finishHungSam?.()
    }
})
