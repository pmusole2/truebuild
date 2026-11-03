import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import {
    pieceBatchResultSchema,
    parsedManualSchema,
    type ManualPieceInput,
    type PieceBatchRequest,
} from '@truebuild/contracts'
import { createPieceHandler } from './pieces'
import { createBackgroundWork, guardModelFetch } from './model-service'
import { ConcurrencyGate, ModelCallCounter } from './budget'
import { SharedKeyAuth } from './auth'
import { createMetaProvider } from '../providers/meta-provider'

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

function wonderResponse(pieces: readonly object[]): Response {
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
}

function pieceRequest(value: PieceBatchRequest, page: Buffer<ArrayBuffer>, authenticated = true): Request {
    const form = new FormData()
    form.set('metadata', JSON.stringify(value))
    for (const pageEntry of value.pages)
        form.set(`page:${pageEntry.pageId}`, new File([page], 'page.png', { type: 'image/png' }))
    return new Request('http://localhost/api/pieces', {
        method: 'POST',
        headers: authenticated ? { 'x-truebuild-key': 'pieces-test-key' } : {},
        body: form,
    })
}

const placement = { position: [0, 0, 0], rotation: [0, 0, 0] }
const boxPart = (width = 1): object => ({ type: 'box', dimensions: { width, height: 1, depth: 1 }, ...placement })
const placeholder = {
    type: 'lathe',
    profile: [
        [0, 0],
        [0, 0],
        [0, 0],
    ],
    segments: 8,
    ...placement,
}
const rawPiece = (id: string, parts: readonly object[]): object => ({ id, name: id, color: '#4a7fb0', parts })

async function composePiece(id: string, candidate: object): Promise<ReturnType<typeof pieceBatchResultSchema.parse>> {
    const provider = createMetaProvider({
        apiKey: 'synthetic-pieces-provider-key',
        fetchImpl: guardModelFetch(async (): Promise<Response> => wonderResponse([candidate])),
    })
    const handler = createPieceHandler({
        auth: new SharedKeyAuth({ sharedSecret: 'pieces-test-key' }),
        runtimeMode: 'meta',
        provider,
        work: createBackgroundWork(new ModelCallCounter(), new ConcurrencyGate(8)),
        deadlineMs: 45_000,
    })
    const response = await handler(
        pieceRequest(
            {
                requestId: 'salvage-test',
                contentHash: 'c'.repeat(64),
                parts: [{ ...part(id), pageId: null }],
                pages: [],
            },
            Buffer.alloc(0),
        ),
    )
    expect(response.status).toBe(200)
    return pieceBatchResultSchema.parse(await response.json())
}

it('keeps valid piece parts only when the count or every largest-part check preserves the piece', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
        const invalidLarge = { ...boxPart(10), rotation: [0, 0, 99] }
        const invalidTied = { ...boxPart(), rotation: [0, 0, 99] }
        const placedExtrude = {
            type: 'extrude',
            outline: [
                [0, 0],
                [2, 0],
                [2, 2],
                [0, 2],
            ],
            depth: 2,
            position: [900, -800, 600],
            rotation: [0.5, -0.25, 1],
        }
        const placedLathe = {
            type: 'lathe',
            profile: [
                [0, -1],
                [0.75, -1],
                [0.75, 1],
                [0, 1],
            ],
            segments: 16,
            position: [900, -800, 600],
            rotation: [0.5, -0.25, 1],
        }
        const rows: { id: string; candidate: object; kept: number }[] = [
            { id: 'count', candidate: rawPiece('count', [boxPart(), placeholder, boxPart(2)]), kept: 2 },
            {
                id: 'count-boundary',
                candidate: rawPiece('count-boundary', [boxPart(), boxPart(), invalidLarge, placeholder]),
                kept: 2,
            },
            { id: 'largest', candidate: rawPiece('largest', [boxPart(), placeholder, placeholder]), kept: 1 },
            {
                id: 'extrude-largest',
                candidate: rawPiece('extrude-largest', [placedExtrude, invalidTied, placeholder]),
                kept: 1,
            },
            {
                id: 'lathe-largest',
                candidate: rawPiece('lathe-largest', [placedLathe, invalidTied, placeholder]),
                kept: 1,
            },
            {
                id: 'extrude-not-largest',
                candidate: rawPiece('extrude-not-largest', [placedExtrude, invalidLarge, invalidLarge]),
                kept: 0,
            },
            {
                id: 'lathe-not-largest',
                candidate: rawPiece('lathe-not-largest', [placedLathe, invalidLarge, invalidLarge]),
                kept: 0,
            },
            { id: 'too-little', candidate: rawPiece('too-little', [boxPart(), invalidLarge, invalidLarge]), kept: 0 },
            {
                id: 'unknown-size',
                candidate: rawPiece('unknown-size', [boxPart(), { type: 'unknown' }, placeholder]),
                kept: 0,
            },
            { id: 'tied-largest', candidate: rawPiece('tied-largest', [boxPart(), invalidTied, invalidTied]), kept: 0 },
            { id: 'all-invalid', candidate: rawPiece('all-invalid', [placeholder]), kept: 0 },
            {
                id: 'bad-metadata',
                candidate: { ...rawPiece('bad-metadata', [boxPart(), placeholder]), extra: true },
                kept: 0,
            },
            {
                id: 'too-many',
                candidate: rawPiece(
                    'too-many',
                    Array.from({ length: 41 }, () => boxPart()),
                ),
                kept: 0,
            },
        ]
        for (const row of rows) {
            const original = structuredClone(row.candidate)
            const result = (await composePiece(row.id, row.candidate)).results[0]!
            expect(result.piece?.parts.length ?? 0, row.id).toBe(row.kept)
            expect(result.status, row.id).toBe(row.kept === 0 ? 'invalid' : 'passed')
            if (row.kept > 0) expect(result.issueCodes, row.id).toEqual([])
            expect(row.candidate, row.id).toEqual(original)
        }
        const logs: unknown[] = info.mock.calls.flatMap(([value]) =>
            typeof value === 'string' ? [JSON.parse(value) as unknown] : [],
        )
        expect(logs).toContainEqual(
            expect.objectContaining({
                pieceId: 'count',
                salvaged: true,
                retention: 'count',
                droppedParts: [{ index: 1, issueCodes: expect.any(Array) }],
            }),
        )
        expect(logs).toContainEqual(
            expect.objectContaining({ pieceId: 'largest', salvaged: true, retention: 'largest' }),
        )
    } finally {
        info.mockRestore()
    }
})

it('preserves a valid detached thin structural member without guessing whether it belongs to the piece', async () => {
    const parts = [
        boxPart(8),
        { type: 'cylinder', dimensions: { radius: 0.025, height: 2 }, position: [0, 3, 0], rotation: [0, 0, 0] },
    ]
    const result = await composePiece('frame', rawPiece('frame', parts))
    expect(result.results[0]).toMatchObject({ status: 'passed', piece: { parts }, issueCodes: [] })
})

it('preserves a thin concave extrude exactly and drops only its invalid outline sibling', async () => {
    const extrude = {
        type: 'extrude',
        outline: [
            [0, 0],
            [3, 0],
            [3, 0.4],
            [0.4, 0.4],
            [0.4, 2],
            [0, 2],
        ],
        depth: 0.04,
        bevel: 0,
        position: [1, -2, 0.5],
        rotation: [0.2, -0.3, 0.4],
    }
    const invalid = {
        ...extrude,
        outline: [
            [0, 0],
            [2, 2],
            [0, 2],
            [2, 0],
        ],
    }
    for (const parts of [[extrude], [extrude, invalid]]) {
        const candidate = rawPiece('thin-bracket', parts)
        const original = structuredClone(candidate)
        const result = (await composePiece('thin-bracket', candidate)).results[0]!
        expect(result).toMatchObject({ status: 'passed', issueCodes: [] })
        expect(result.piece?.parts).toEqual([extrude])
        expect(candidate).toEqual(original)
    }
})

it('removes consecutive outline and profile duplicates before strict validation without closing or repairing invalid paths', async () => {
    const lathe = {
        type: 'lathe',
        profile: [
            [0, -1],
            [0, -1],
            [0.5, -1],
            [0.5, 1],
            [0, 1],
        ],
        segments: 16,
        ...placement,
    }
    const extrude = {
        type: 'extrude',
        outline: [
            [0, 0],
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ],
        depth: 0.2,
        ...placement,
    }
    const candidate = rawPiece('duplicate-points', [lathe, extrude])
    const original = structuredClone(candidate)
    const result = (await composePiece('duplicate-points', candidate)).results[0]!
    expect(result.status).toBe('passed')
    expect(result.piece?.parts).toMatchObject([
        {
            type: 'lathe',
            profile: [
                [0, -1],
                [0.5, -1],
                [0.5, 1],
                [0, 1],
            ],
        },
        {
            type: 'extrude',
            outline: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
            ],
        },
    ])
    expect(candidate).toEqual(original)
    for (const outline of [
        [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
            [0, 1],
        ],
        [
            [0, 0],
            [1, 1],
            [0, 1],
            [1, 0],
        ],
        [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
        ],
    ]) {
        const invalid = (await composePiece('bad-path', rawPiece('bad-path', [{ ...extrude, outline }]))).results[0]!
        expect(invalid.status).toBe('invalid')
        expect(invalid.piece).toBeNull()
    }
})

it('retains valid siblings and plain crops through Wonder, rejects invalid geometry, and repairs only the next requested batch', async () => {
    // Printed ink inside the drawing box; a uniform page has no ink for the crop gate to find.
    const png = await sharp(
        Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="white"/><path d="M10 10 H30 V30 H10 Z M10 20 H30" stroke="black" stroke-width="2" fill="none"/></svg>',
        ),
    )
        .png()
        .toBuffer()
    const parsePart = parsedManualSchema.shape.parts.element
    const namedPart = { partId: 'knob', name: { state: 'unknown', reason: 'No readable label' } }
    expect(parsePart.parse({ ...namedPart, drawingBox: [0.1, 0.2, 0.3, 0.4] }).drawingBox).toEqual([0.1, 0.2, 0.3, 0.4])
    for (const drawingBox of [[-0.1, 0, 1, 1], [0, 0, 0, 1], [0.9, 0, 0.2, 1], [0, 0, 1], 'invalid'])
        expect(parsePart.parse({ ...namedPart, drawingBox }).drawingBox).toBeUndefined()
    expect(parsePart.safeParse({ ...namedPart, unexpected: true }).success).toBe(false)
    const bodies: unknown[] = []
    const provider = createMetaProvider({
        apiKey: 'synthetic-pieces-provider-key',
        fetchImpl: guardModelFetch(async (_url, init): Promise<Response> => {
            bodies.push(JSON.parse(String(init?.body)) as unknown)
            return wonderResponse(
                bodies.length === 1 ? [spec('bracket'), spec('pin', -1), spec('washer')] : [spec('pin')],
            )
        }),
    })
    const generatePieces = vi.spyOn(provider, 'generatePieces')
    const counter = new ModelCallCounter()
    const handler = createPieceHandler({
        auth: new SharedKeyAuth({ sharedSecret: 'pieces-test-key' }),
        runtimeMode: 'meta',
        provider,
        work: createBackgroundWork(counter, new ConcurrencyGate(8)),
        deadlineMs: 45_000,
    })
    const metadata: PieceBatchRequest = {
        requestId: 'pieces-test',
        contentHash: 'a'.repeat(64),
        parts: [
            { ...part('bracket'), notPartOfThisPiece: ['pin', 'washer'] },
            { ...part('pin'), drawingBox: [-0.1, 0, 0.5, 0.5] },
            { ...part('washer'), drawingBox: [0.2, 0.2, 0.6, 0.6] },
        ],
        pages: [{ pageId: 'page-1', width: 40, height: 40, mimeType: 'image/png' }],
    }
    const unauthorized = await handler(pieceRequest(metadata, png, false))
    expect(unauthorized.status).toBe(401)
    expect(generatePieces).not.toHaveBeenCalled()
    const response = await handler(pieceRequest(metadata, png))
    expect(response.status).toBe(200)
    const first = pieceBatchResultSchema.parse(await response.json())
    expect(first.results.map((value) => value.status)).toEqual(['passed', 'invalid', 'passed'])
    expect(first.results[0]!.piece?.id).toBe('bracket')
    expect(first.results[1]!.piece).toBeNull()
    expect(first.results[1]!.issueCodes).toContain('parts.0.dimensions.width:too_small')
    const plain = first.results[0]!.cutoutUri!
    expect(plain.startsWith('data:image/png;base64,')).toBe(true)
    expect(first.results[1]!.cutoutUri).toBeNull()
    expect(first.results[2]!.cutoutUri!.startsWith('data:image/png;base64,')).toBe(true)
    const cutoutBytes = Buffer.from(plain.split(',')[1]!, 'base64')
    expect((await sharp(cutoutBytes).stats()).isOpaque).toBe(true)
    const firstInput = generatePieces.mock.calls[0]![0]
    expect(firstInput.parts[0]).toMatchObject({ notPartOfThisPiece: ['pin', 'washer'] })
    expect(firstInput.imagePieceIds).toEqual(['bracket', 'pin', 'washer'])
    const cutoutInfo = await sharp(cutoutBytes).metadata()
    expect(Buffer.from(firstInput.images[0]!.bytes)).toEqual(cutoutBytes)
    expect(firstInput.images[0]).toMatchObject({
        width: cutoutInfo.width,
        height: cutoutInfo.height,
        mimeType: 'image/png',
    })
    expect(generatePieces).toHaveBeenCalledTimes(1)
    expect(bodies[0]).toMatchObject({
        model: 'muse-wonder-1.0',
        reasoning: { effort: 'high' },
        max_output_tokens: 48_000,
        text: { format: { name: 'truebuild_pieces' } },
    })
    expect(bodies[0]).toHaveProperty(
        'input.0.content.0.text',
        expect.stringContaining('"notPartOfThisPiece":["pin","washer"]'),
    )
    expect(bodies[0]).toHaveProperty(
        'instructions',
        expect.stringContaining(
            'Preserve integral shafts, stems, pegs and other connected functional structural members',
        ),
    )
    expect(bodies[0]).toHaveProperty('instructions', expect.stringContaining('Use extrude for flat outlines'))
    expect(bodies[0]).toHaveProperty('instructions', expect.stringContaining('Use round primitives for round members'))
    expect(bodies[0]).toHaveProperty(
        'instructions',
        expect.stringContaining('Use volumetric primitives for thick housings'),
    )
    expect(bodies[0]).toHaveProperty('instructions', expect.stringContaining('Never add a schema placeholder'))
    expect(bodies[0]).toHaveProperty('instructions', expect.stringContaining('Fold small surface lobes'))
    const failed = first.results[1]!
    const repaired = await handler(
        pieceRequest(
            {
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
            },
            png,
        ),
    )
    const second = pieceBatchResultSchema.parse(await repaired.json())
    expect(second.results[0]).toMatchObject({
        status: 'repaired',
        piece: { id: 'pin' },
        cutoutUri: plain,
        issueCodes: [],
    })
    expect(second).toMatchObject({ model: 'muse-wonder-1.0', effort: 'high', contentHash: metadata.contentHash })
    expect(counter.used).toBe(2)
    expect(firstInput.parts[1]?.drawingBox).toBeUndefined()
    const repairedInput: unknown = generatePieces.mock.calls[1]?.[0]
    expect(repairedInput).toMatchObject({
        imagePieceIds: ['pin'],
        parts: [{ repair: { issueCodes: failed.issueCodes } }],
    })
})

it('sends no crop image for a blank drawing and still asks Wonder for the name-only geometry', async () => {
    const blankPage = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#eeeeee' } })
        .png()
        .toBuffer()
    const provider = createMetaProvider({
        apiKey: 'synthetic-pieces-provider-key',
        fetchImpl: guardModelFetch(async (): Promise<Response> => wonderResponse([spec('plate')])),
    })
    const generatePieces = vi.spyOn(provider, 'generatePieces')
    const handler = createPieceHandler({
        auth: new SharedKeyAuth({ sharedSecret: 'pieces-test-key' }),
        runtimeMode: 'meta',
        provider,
        work: createBackgroundWork(new ModelCallCounter(), new ConcurrencyGate(8)),
        deadlineMs: 45_000,
    })
    const plate = part('plate')
    const response = await handler(
        pieceRequest(
            {
                requestId: 'pieces-blank',
                contentHash: 'b'.repeat(64),
                parts: [plate],
                pages: [{ pageId: 'page-1', width: 40, height: 40, mimeType: 'image/png' }],
            },
            blankPage,
        ),
    )
    expect(response.status).toBe(200)
    const result = pieceBatchResultSchema.parse(await response.json())
    expect(result.results[0]).toMatchObject({ id: 'plate', status: 'passed', cutoutUri: null, issueCodes: [] })
    expect(generatePieces).toHaveBeenCalledTimes(1)
    expect(generatePieces.mock.calls[0]![0]).toMatchObject({ imagePieceIds: [], images: [], parts: [plate] })
})

it('drops shared own-box claims and reused cutouts while accepting explicit and legacy broader figure context', async () => {
    const drawing = await sharp(
        Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="white"/><path d="M10 10 H30 V30 H10 Z M10 20 H30" stroke="black" stroke-width="2" fill="none"/></svg>',
        ),
    )
        .png()
        .toBuffer()
    const provider = createMetaProvider({
        apiKey: 'synthetic-pieces-provider-key',
        fetchImpl: guardModelFetch(async (): Promise<Response> =>
            wonderResponse([spec('propeller-a'), spec('propeller-b'), spec('battery'), spec('legacy')]),
        ),
    })
    const generatePieces = vi.spyOn(provider, 'generatePieces')
    const handler = createPieceHandler({
        auth: new SharedKeyAuth({ sharedSecret: 'pieces-test-key' }),
        runtimeMode: 'meta',
        provider,
        work: createBackgroundWork(new ModelCallCounter(), new ConcurrencyGate(8)),
        deadlineMs: 45_000,
    })
    const response = await handler(
        pieceRequest(
            {
                requestId: 'pieces-grouped',
                contentHash: 'd'.repeat(64),
                parts: [
                    {
                        ...part('propeller-a'),
                        figureBox: [0, 0, 0.5, 1],
                        cutoutUri: `data:image/png;base64,${drawing.toString('base64')}`,
                    },
                    {
                        ...part('propeller-b'),
                        figureBox: [0, 0, 0.5, 1],
                        cutoutUri: `data:image/png;base64,${drawing.toString('base64')}`,
                    },
                    { ...part('battery'), drawingBox: undefined, figureBox: [0.2, 0.2, 0.6, 0.6] },
                    { ...part('legacy'), drawingBox: undefined },
                ],
                pages: [{ pageId: 'page-1', width: 40, height: 40, mimeType: 'image/png' }],
            },
            drawing,
        ),
    )
    expect(response.status).toBe(200)
    const result = pieceBatchResultSchema.parse(await response.json())
    expect(result.results.map((value) => [value.id, value.cutoutUri !== null])).toEqual([
        ['propeller-a', false],
        ['propeller-b', false],
        ['battery', false],
        ['legacy', false],
    ])
    expect(generatePieces).toHaveBeenCalledTimes(1)
    expect(generatePieces.mock.calls[0]![0]).toMatchObject({
        imagePieceIds: ['propeller-a', 'propeller-b', 'battery', 'legacy'],
    })
    const sentImages = generatePieces.mock.calls[0]![0].images
    expect(sentImages).toHaveLength(4)
    expect(Buffer.from(sentImages[0]!.bytes).equals(drawing)).toBe(false)
    expect(sentImages[0]!.bytes).toEqual(sentImages[1]!.bytes)
})
