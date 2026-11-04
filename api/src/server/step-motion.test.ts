import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { paddedStepFigureBox, STEP_MOTION_PROMPT_VERSION, type StepMotionRequest } from '@truebuild/contracts'
import { createMetaProvider, stepMotionTextBytes } from '../providers/meta-provider'
import { aiPolicyFromEnvironment, STEP_MOTION_POLICY } from './ai-policy'
import * as media from './media'
import { MetaTransport } from '../providers/meta-transport'
import { SharedKeyAuth } from './auth'
import { BudgetError, ConcurrencyGate, ModelCallCounter } from './budget'
import { createBackgroundWork, guardModelFetch } from './model-service'
import {
    createStepMotionHandler,
    estimatedStepMotionCostUsd,
    figureWindow,
    modelFrameSize,
    stepMotionCacheKey,
    stepMotionContentKey,
} from './step-motion'

const metadata: StepMotionRequest = {
    requestId: 'recorded-motion',
    manualHash: 'a'.repeat(64),
    stepId: 'step-1',
    readingLanguage: 'en',
    instructionText: '  1. Turn the part upward.\nThen turn the fastener.  ',
    sourceRefs: [{ pageId: 'page-1', region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }],
    parts: [{ id: 'part-1', name: 'Part', quantity: 1 }],
    actions: ['Raise the part.', 'Turn the fastener.'],
    orientation: 'Upright.',
    connection: 'At the joint.',
    // The claimed hash is replaced by the hash of the uploaded bytes in request(); this placeholder is only a shape.
    page: { pageId: 'page-1', width: 1024, height: 1024, mimeType: 'image/png', contentHash: '0'.repeat(64) },
    figureBox: paddedStepFigureBox([0.25, 0.25, 0.5, 0.5]),
}
const shape = {
    type: 'box',
    dimensions: { width: 1, height: 1, depth: 1 },
    position: [0, 0, 0],
    rotation: [0, 0, 0],
}
const scene = {
    version: 1,
    stepId: 'step-1',
    still: [shape],
    movers: [
        {
            label: 'Part',
            shapes: [shape],
            motion: { kind: 'rotate', pivot: [0, 0, 0], axis: [0, 0, 1], fromDeg: -90, toDeg: 0 },
            actionIndex: 0,
        },
    ],
    caption: 'Raise the part.',
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function solidPng(width: number, height: number, background: string): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background } })
        .png()
        .toBuffer()
}

interface Upload {
    /** The page hash the device claims. Defaults to the hash of the uploaded bytes, which is what a truthful device sends. */
    claimedHash?: string
    /** The original uploaded as the page. Defaults to a solid page of the metadata's size. */
    bytes?: Buffer
}

async function request(
    overrides: Partial<StepMotionRequest> = {},
    key = 'motion-fixture-key',
    upload: Upload = {},
): Promise<Request> {
    const form = new FormData()
    const value = { ...metadata, ...overrides }
    const bytes = upload.bytes ?? (await solidPng(value.page.width, value.page.height, '#456789'))
    value.page = { ...value.page, contentHash: upload.claimedHash ?? sha256Hex(bytes) }
    form.set('metadata', JSON.stringify(value))
    if (!value.cacheOnly)
        form.set(`page:${value.page.pageId}`, new File([new Uint8Array(bytes)], 'page.png', { type: 'image/png' }))
    return new Request('http://localhost/api/step-motion', {
        method: 'POST',
        headers: { 'x-truebuild-key': key },
        body: form,
    })
}

function response(value: unknown): Response {
    return Response.json({
        status: 'completed',
        model: 'muse-wonder-1.0',
        usage: { input_tokens: 731, output_tokens: 248 },
        output: [
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: JSON.stringify(value) }],
            },
        ],
    })
}

function setup(
    value: unknown,
    limit = 8,
    transportResponse?: () => Response,
    cacheLimit?: number,
    motion: { enabled?: boolean; dailyLimit?: number; clock?: () => number } = {},
): {
    handler: ReturnType<typeof createStepMotionHandler>
    fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
    counter: ModelCallCounter
    bodies: Record<string, unknown>[]
    run: ReturnType<typeof vi.spyOn>
    provider: ReturnType<typeof createMetaProvider>
} {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return transportResponse?.() ?? response(value)
    })
    const policy = aiPolicyFromEnvironment(
        { AI_MAX_OUTPUT_STEP_PAGES: '4096' },
        {
            checkTimeoutMs: 12_000,
            parseModel: 'muse-spark-1.3',
            verdictModel: 'muse-spark-1.3',
            secondOpinionModel: 'muse-wonder-1.0',
        },
    )
    const provider = createMetaProvider({
        apiKey: 'synthetic-motion-provider-key',
        fetchImpl: guardModelFetch(fetchImpl),
        policy,
    })
    const counter = new ModelCallCounter(limit)
    const work = createBackgroundWork(counter, new ConcurrencyGate(3))
    const run = vi.spyOn(work, 'run')
    return {
        handler: createStepMotionHandler({
            auth: new SharedKeyAuth({ sharedSecret: 'motion-fixture-key' }),
            provider,
            runtimeMode: 'meta',
            work,
            cacheLimit,
            ...motion,
        }),
        fetchImpl,
        counter,
        bodies,
        run,
        provider,
    }
}

it('caches one call per step/language/version and sends verbatim manual text before the cited figure and extra context', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl, counter, bodies, run } = setup({ scene })
    const first = await handler(await request())
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ scene })
    expect(await (await handler(await request({ requestId: 'another-id' }))).json()).toEqual({ scene })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(counter.used).toBe(1)
    const unavailable = createStepMotionHandler({
        auth: new SharedKeyAuth({ sharedSecret: 'motion-fixture-key' }),
        provider: null,
        runtimeMode: 'meta',
        work: createBackgroundWork(new ModelCallCounter(1), new ConcurrencyGate(1)),
    })
    const refused = await unavailable(await request())
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ code: 'unconfigured', notDispatched: true })
    expect((await unavailable(await request({ cacheOnly: true }))).status).toBe(404)
    expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineMs: 90_000, signal: expect.any(AbortSignal) }),
        expect.any(Function),
    )
    const body = bodies[0]!
    const wireTextBytes = (candidate: Record<string, unknown>): number =>
        Buffer.byteLength(
            JSON.stringify({
                instructions: candidate.instructions,
                text: candidate.text,
                input: (candidate.input as { content: { type: string }[] }[])[0]!.content.filter(
                    (part) => part.type === 'input_text',
                ),
            }),
            'utf8',
        )
    expect(stepMotionTextBytes(metadata)).toBe(wireTextBytes(body))
    expect(body).toMatchObject({
        model: 'muse-wonder-1.0',
        reasoning: { effort: 'high' },
        max_output_tokens: 14_000,
        text: { format: { strict: true, schema: { required: ['scene'] } } },
    })
    const input = body.input as { content: { type: string; text?: string; image_url?: string }[] }[]
    const content = input[0]!.content
    expect(JSON.parse(content[0]!.text!)).toEqual({
        instructionText: metadata.instructionText,
        sourceRefs: metadata.sourceRefs,
    })
    expect(content[1]!.type).toBe('input_image')
    const image = Buffer.from(content[1]!.image_url!.split(',')[1]!, 'base64')
    // The cited box is 615 px on this 1024 px page, so it is neither too thin nor too small to crop.
    expect(await sharp(image).metadata()).toMatchObject({ width: 615, height: 615 })
    expect(JSON.parse(content[2]!.text!)).toMatchObject({
        parts: metadata.parts,
        actions: metadata.actions,
        orientation: metadata.orientation,
        connection: metadata.connection,
    })
    expect(stepMotionContentKey(metadata)).not.toBe(stepMotionContentKey(metadata, STEP_MOTION_PROMPT_VERSION + 1))
    expect(stepMotionContentKey(metadata)).not.toBe(stepMotionContentKey({ ...metadata, readingLanguage: 'es' }))
    expect(stepMotionContentKey(metadata)).not.toBe(stepMotionContentKey({ ...metadata, stepId: 'step-2' }))
    expect((await handler(await request({ readingLanguage: 'es' }))).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(stepMotionTextBytes({ ...metadata, readingLanguage: 'es' })).toBe(wireTextBytes(bodies[1]!))
})

it('misses a cached scene after its instruction content changes under the same page hash', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl } = setup({ scene })
    expect((await handler(await request())).status).toBe(200)
    expect((await handler(await request({ requestId: 'another-reader' }))).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((await handler(await request({ instructionText: 'Press the part.' }))).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it('misses a cached scene when the same step arrives with a different verified page', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl } = setup({ scene })
    expect((await handler(await request())).status).toBe(200)
    const other = await solidPng(1024, 1024, '#abcdef')
    expect((await handler(await request({}, 'motion-fixture-key', { bytes: other }))).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it('verifies the uploaded original before serving a cached scene for the page it claims', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl } = setup({ scene })
    const original = await solidPng(1024, 1024, '#456789')
    expect((await handler(await request())).status).toBe(200)
    const swapped = await handler(
        await request({ requestId: 'swapped' }, 'motion-fixture-key', {
            claimedHash: sha256Hex(original),
            bytes: await solidPng(1024, 1024, '#abcdef'),
        }),
    )
    expect(swapped.status).toBe(400)
    expect(await swapped.json()).toMatchObject({ code: 'invalid_input', notDispatched: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('keeps a post-dispatch failure terminal so revisits and cache reads never pay again', async () => {
    const { handler, fetchImpl, counter } = setup(null, 8, () =>
        Response.json({ error: 'unavailable' }, { status: 503 }),
    )
    for (const overrides of [{}, { cacheOnly: true }, { requestId: 'revisit' }]) {
        const result = await handler(await request(overrides))
        expect(result.status).toBe(200)
        expect(await result.json()).toEqual({ scene: null })
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(counter.used).toBe(1)
})

it.each([
    null,
    { ...scene, movers: [{ ...scene.movers[0], motion: { kind: 'screw', axis: [0, 0, 2], travel: 0.1, turns: 1 } }] },
])('caches a null or invalid outcome without repair or retry', async (candidate) => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl } = setup({ scene: candidate })
    for (let index = 0; index < 2; index++)
        expect(await (await handler(await request())).json()).toEqual({ scene: null })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('applies authentication, input bounds, cited-crop validation and the shared call ceiling', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl, counter } = setup({ scene }, 1)
    expect((await handler(await request({}, 'wrong-fixture-key'))).status).toBe(401)
    expect((await handler(await request({ instructionText: 'x'.repeat(16_001) }))).status).toBe(400)
    expect((await handler(await request({ figureBox: [0, 0, 0.25, 0.25] }))).status).toBe(400)
    expect(
        (
            await handler(
                await request({
                    sourceRefs: [{ pageId: 'page-1', region: null }],
                    figureBox: [0, 0, 0.25, 0.25],
                }),
            )
        ).status,
    ).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
    await handler(await request())
    expect((await handler(await request({ readingLanguage: 'es' }))).status).toBe(429)
    expect(counter.used).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('does not retry a rate-limited provider even when Retry-After permits other operations to retry', async () => {
    const { handler, fetchImpl } = setup(
        null,
        8,
        () => new Response(null, { status: 429, headers: { 'retry-after': '0' } }),
    )
    expect(await (await handler(await request())).json()).toEqual({ scene: null })
    expect(await (await handler(await request())).json()).toEqual({ scene: null })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('accounts for observed token usage with standard rates and leaves unknown usage unknown', () => {
    expect(estimatedStepMotionCostUsd({ inputTokens: 731, outputTokens: 248 })).toBeCloseTo(0.007884)
    expect(estimatedStepMotionCostUsd({ inputTokens: 1000, cachedTokens: 500, outputTokens: 100 })).toBeCloseTo(0.0041)
    expect(estimatedStepMotionCostUsd({ inputTokens: 1000 })).toBeNull()
    expect(estimatedStepMotionCostUsd({ inputTokens: 1000, cachedTokens: 1001, outputTokens: 100 })).toBeNull()
})

it('does not cache a pre-claim budget rejection and refuses context above its independent input budget', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, counter, fetchImpl } = setup({ scene: null })
    vi.spyOn(counter, 'claim').mockImplementationOnce(() => {
        throw new BudgetError()
    })
    const refused = await handler(await request())
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ notDispatched: true })
    const large = { actions: Array.from({ length: 32 }, () => 'a'.repeat(2000)), instructionText: 'b'.repeat(16000) }
    expect((await handler(await request(large))).status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await handler(await request())).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('rejects escaped text above the full text budget before admission and leaves the same key eligible', async () => {
    const oversized = { ...metadata, instructionText: '"'.repeat(3500) }
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeLessThanOrEqual(STEP_MOTION_POLICY.maxContextBytes)
    expect(stepMotionTextBytes(oversized)).toBeGreaterThan(STEP_MOTION_POLICY.maxTextBytes)
    const { handler, fetchImpl, counter, run } = setup({ scene: null })
    const rejected = await handler(await request({ instructionText: oversized.instructionText }))
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ notDispatched: true })
    expect(counter.used).toBe(0)
    expect(run).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await handler(await request())).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('looks up cached results without files or provider dispatch, including a 404 cache miss', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl, counter } = setup({ scene })
    expect((await handler(await request({ cacheOnly: true }))).status).toBe(404)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(counter.used).toBe(0)
    expect((await handler(await request())).status).toBe(200)
    expect(await (await handler(await request({ cacheOnly: true }))).json()).toEqual({ scene })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(counter.used).toBe(1)
})

it.each([null, [0, 0, 1, 1]] as const)(
    'accepts an uncropped citation with figureBox=%s within the independent image input budget',
    async (figureBox) => {
        vi.spyOn(console, 'info').mockImplementation(() => {})
        const { handler, bodies } = setup({ scene: null })
        expect(
            (
                await handler(
                    await request({
                        page: { ...metadata.page, width: 2048, height: 1536 },
                        sourceRefs: [{ pageId: 'page-1', region: null }],
                        figureBox: figureBox === null ? null : [...figureBox],
                    }),
                )
            ).status,
        ).toBe(200)
        const input = bodies[0]!.input as { content: { type: string; image_url?: string }[] }[]
        const picture = input[0]!.content.find((part) => part.type === 'input_image')!
        const bytes = Buffer.from(picture.image_url!.split(',')[1]!, 'base64')
        expect(await sharp(bytes).metadata()).toMatchObject({ width: 1024, height: 768 })
    },
)

it.each([
    [
        'keeps the width and grows a thin region about its centre to the minimum edge',
        [0.25, 0.5, 0.5, 0.0625],
        1000,
        2000,
        { left: 250, top: 935, width: 500, height: 256 },
    ],
    [
        'grows both sides in proportion when the region is under four percent of the page',
        [0.5, 0.5, 0.125, 0.125],
        2048,
        2048,
        { left: 947, top: 947, width: 410, height: 410 },
    ],
    [
        'shifts inside the page instead of shrinking when the grown window meets the edge',
        [0.75, 0.5, 0.25, 0.0625],
        1000,
        2000,
        { left: 717, top: 921, width: 283, height: 283 },
    ],
    [
        'sends a page under the minimum edge whole',
        [0.25, 0.25, 0.1, 0.1],
        200,
        2000,
        { left: 0, top: 0, width: 200, height: 2000 },
    ],
] as const)('%s', (_name, box, width, height, expected) => {
    expect(figureWindow([...box], { width, height })).toEqual(expected)
})

it('sends a thin cited figure grown to the minimum window with its pixels in place', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const region = { x: 0.25, y: 0.5, width: 0.5, height: 93 / 4096 }
    const red = await sharp({ create: { width: 837, height: 93, channels: 3, background: '#ff0000' } })
        .png()
        .toBuffer()
    const original = await sharp({ create: { width: 1674, height: 4096, channels: 3, background: '#ffffff' } })
        .composite([{ input: red, left: 418, top: 2048 }])
        .png()
        .toBuffer()
    const { handler, bodies } = setup({ scene: null })
    const page = { ...metadata.page, width: 1674, height: 4096 }
    const figureBox = paddedStepFigureBox([region.x, region.y, region.width, region.height])
    const sourceRefs = [{ pageId: 'page-1', region }]
    expect(
        (await handler(await request({ page, sourceRefs, figureBox }, 'motion-fixture-key', { bytes: original })))
            .status,
    ).toBe(200)
    const input = bodies[0]!.input as { content: { type: string; image_url?: string }[] }[]
    const picture = input[0]!.content.find((part) => part.type === 'input_image')!
    const sent = await sharp(Buffer.from(picture.image_url!.split(',')[1]!, 'base64'))
        .raw()
        .toBuffer({ resolveWithObject: true })
    const { data, info } = sent
    expect(info.width).toBeGreaterThanOrEqual(256)
    expect(info.height).toBeGreaterThanOrEqual(256)
    const pixel = (x: number, y: number): number[] => {
        const offset = (y * info.width + x) * info.channels
        return [...data.subarray(offset, offset + 3)]
    }
    const [red1, green1, blue1] = pixel(Math.floor(info.width / 2), Math.floor(info.height / 2))
    expect(red1!).toBeGreaterThan(200)
    expect(green1!).toBeLessThan(60)
    expect(blue1!).toBeLessThan(60)
    // The top row lies above the 93 px band, so the window reaches past the region rather than clipping to it.
    expect(pixel(Math.floor(info.width / 2), 0).every((channel) => channel > 200)).toBe(true)
})

it('evicts the oldest completed result while retaining an in-flight result and admitting a new step', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl } = setup({ scene: null }, 8, undefined, 1)
    let finish: (response: Response) => void = () => {}
    let finishSibling: (response: Response) => void = () => {}
    fetchImpl.mockImplementationOnce(
        async () =>
            new Promise<Response>((resolve) => {
                finish = resolve
            }),
    )
    fetchImpl.mockImplementationOnce(
        async () =>
            new Promise<Response>((resolve) => {
                finishSibling = resolve
            }),
    )
    const pending = handler(await request())
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const sibling = handler(await request({ stepId: 'step-2' }))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    const imageWork = vi.spyOn(media, 'validateAndNormalizeImages')
    const busy = await handler(await request({ stepId: 'step-3' }))
    expect(imageWork).not.toHaveBeenCalled()
    expect(busy.status).toBe(503)
    expect(await busy.json()).toMatchObject({ code: 'busy', notDispatched: true })
    finishSibling(response({ scene: null }))
    expect((await sibling).status).toBe(200)
    expect((await handler(await request({ stepId: 'step-3' }))).status).toBe(200)
    expect((await handler(await request({ stepId: 'step-2', cacheOnly: true }))).status).toBe(404)
    expect((await handler(await request({ stepId: 'step-3', cacheOnly: true }))).status).toBe(200)
    finish(response({ scene: null }))
    expect((await pending).status).toBe(200)
    expect((await handler(await request({ cacheOnly: true }))).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
})

it('finishes and caches paid work after the first caller disconnects, then recovers it with a cache-only request', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl, counter } = setup({ scene })
    let finish: (response: Response) => void = () => {}
    let providerSignal: AbortSignal | undefined
    fetchImpl.mockImplementationOnce(async (_input, init) => {
        providerSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => {
            finish = resolve
        })
    })
    const caller = new AbortController()
    const first = handler(new Request(await request(), { signal: caller.signal }))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    caller.abort()
    expect((await first).status).toBe(503)
    expect(providerSignal?.aborted).toBe(false)
    const recovered = handler(await request({ cacheOnly: true }))
    finish(response({ scene }))
    expect(await (await recovered).json()).toEqual({ scene })
    expect(counter.used).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(STEP_MOTION_POLICY.maxOutputTokens).toBe(14_000)
})

it('coalesces simultaneous callers while a provider attempt is still in flight', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl, counter } = setup({ scene: null })
    let finish: (response: Response) => void = () => {}
    fetchImpl.mockImplementationOnce(
        async () =>
            new Promise<Response>((resolve) => {
                finish = resolve
            }),
    )
    const first = await request()
    const sibling = await request({ requestId: 'sibling' })
    const pending = Promise.all([handler(first), handler(sibling)])
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    finish(response({ scene: null }))
    expect((await pending).map((result) => result.status)).toEqual([200, 200])
    expect(counter.used).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('keys the full result by the exact JPEG bytes the model receives, separately from the content identity', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const pixels = Uint8Array.from({ length: 768 * 768 * 3 }, (_, i) => (i * 17 + Math.floor(i / 7) * 29) % 256)
    const bytes = await sharp(pixels, { raw: { width: 768, height: 768, channels: 3 } })
        .png()
        .toBuffer()
    const { handler, bodies, provider } = setup({ scene: null })
    const generation = vi.spyOn(provider, 'generateStepMotion')
    const uploaded = await request({ page: { ...metadata.page, width: 768, height: 768 } }, 'motion-fixture-key', {
        bytes,
    })
    expect((await handler(uploaded)).status).toBe(200)
    const prepared = generation.mock.calls[0]![0]
    const sent = bodies[0]!.input as { content: { type: string; image_url?: string }[] }[]
    const image = sent[0]!.content.find((part) => part.type === 'input_image')!
    const actualBytes = Buffer.from(image.image_url!.split(',')[1]!, 'base64')
    expect(actualBytes).toEqual(Buffer.from(prepared.image.bytes))
    const full = stepMotionCacheKey(prepared.request, sha256Hex(actualBytes))
    expect(full).not.toBe(stepMotionContentKey(prepared.request))
    expect(stepMotionCacheKey(prepared.request, 'b'.repeat(64))).not.toBe(full)
    expect(stepMotionCacheKey(prepared.request, sha256Hex(actualBytes), STEP_MOTION_PROMPT_VERSION + 1)).not.toBe(full)
})

it('reserves the UTC-day cap after transport pacing, immediately before the send', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
        let now = Date.UTC(2026, 10, 3, 23, 59, 50)
        const { handler, fetchImpl } = setup({ scene: null }, 8, undefined, undefined, {
            dailyLimit: 2,
            clock: () => now,
        })
        fetchImpl.mockImplementationOnce(async () => {
            const result = response({ scene: null })
            result.headers.set('x-ratelimit-remaining-requests', '0')
            return result
        })
        expect((await handler(await request())).status).toBe(200)
        const sending = vi.spyOn(MetaTransport.prototype, 'send')
        const paced = handler(await request({ stepId: 'step-2' }))
        await vi.waitFor(() => expect(sending).toHaveBeenCalledTimes(1))
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        now += 60_000
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await paced).status).toBe(200)
        expect((await handler(await request({ stepId: 'step-3' }))).status).toBe(200)
        expect((await handler(await request({ stepId: 'step-4' }))).status).toBe(429)
        expect(fetchImpl).toHaveBeenCalledTimes(3)
    } finally {
        vi.useRealTimers()
    }
})

it('does not consume the feature cap when preparation fails before any transport send', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl } = setup({ scene: null }, 8, undefined, undefined, { dailyLimit: 1 })
    vi.spyOn(MetaTransport.prototype, 'send').mockRejectedValueOnce(new Error('pre-send failure'))
    const failure = await handler(await request())
    expect(failure.status).toBe(503)
    expect(await failure.json()).toMatchObject({ notDispatched: true })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await handler(await request())).status).toBe(200)
    expect((await handler(await request({ stepId: 'step-2' }))).status).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('answers 404 before authentication, body reads, quota or provider work when disabled', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl, counter, run } = setup({ scene }, 8, undefined, undefined, { enabled: false })
    expect((await handler(await request({}, 'wrong-fixture-key'))).status).toBe(404)
    expect((await handler(await request())).status).toBe(404)
    expect((await handler(await request({ cacheOnly: true }))).status).toBe(404)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(counter.used).toBe(0)
    expect(run).not.toHaveBeenCalled()
})

it('caps paid dispatches per UTC day, serves cache hits when full, and resets on the next day', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    let now = Date.UTC(2026, 10, 3, 23)
    const { handler, fetchImpl, counter } = setup({ scene: null }, 8, undefined, undefined, {
        dailyLimit: 1,
        clock: () => now,
    })
    expect((await handler(await request())).status).toBe(200)
    const refused = await handler(await request({ stepId: 'step-2' }))
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ status: 'unavailable', code: 'budget_exhausted', notDispatched: true })
    expect((await handler(await request())).status).toBe(200)
    expect((await handler(await request({ stepId: 'step-2', cacheOnly: true }))).status).toBe(404)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // The refused attempt never reached the shared public claim, so only the dispatched call is counted.
    expect(counter.used).toBe(1)
    now += 60 * 60_000
    expect((await handler(await request({ stepId: 'step-2' }))).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it('accepts a scene with an out-of-range extrude bevel by clamping that bevel to its limit', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const extrude = {
        type: 'extrude',
        outline: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ],
        depth: 0.2,
        bevel: 0.5,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
    }
    const { handler } = setup({ scene: { ...scene, still: [extrude] } })
    const body = (await (await handler(await request())).json()) as { scene: { still: { bevel?: number }[] } | null }
    expect(body.scene?.still[0]?.bevel).toBeCloseTo(0.2 * 0.25)
})

it('logs a short reason code for a refused scene, never the model text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler } = setup({ scene: { ...scene, stepId: 'step-9' } })
    expect(await (await handler(await request())).json()).toEqual({ scene: null })
    const logged = info.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('step_motion_generation'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ accepted: false, reason: 'step_id' })
    expect(JSON.stringify(logged)).not.toContain(scene.caption)
})

it('sends a narrow whole page with a 512px shorter side, and the cache keys the exact JPEG bytes sent', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const bytes = await solidPng(214, 1280, '#456789')
    const { handler, bodies, provider } = setup({ scene: null })
    const generation = vi.spyOn(provider, 'generateStepMotion')
    const narrow = await request(
        { page: { ...metadata.page, width: 214, height: 1280 }, sourceRefs: [{ pageId: 'page-1', region: null }], figureBox: null },
        'motion-fixture-key',
        { bytes },
    )
    expect((await handler(narrow)).status).toBe(200)
    const sent = bodies[0]!.input as { content: { type: string; image_url?: string }[] }[]
    const image = sent[0]!.content.find((part) => part.type === 'input_image')!
    const sentBytes = Buffer.from(image.image_url!.split(',')[1]!, 'base64')
    const meta = await sharp(sentBytes).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(512)
    expect(meta.height).toBe(Math.round((1280 * 512) / 214))
    const prepared = generation.mock.calls[0]![0]
    expect(sentBytes).toEqual(Buffer.from(prepared.image.bytes))
    expect(stepMotionCacheKey(prepared.request, sha256Hex(sentBytes))).not.toBe(stepMotionContentKey(prepared.request))
})

it.each([
    [214, 1280, { width: 512, height: 3062 }],
    [2048, 1536, { width: 1024, height: 768 }],
    [1024, 1024, { width: 1024, height: 1024 }],
    [400, 60_000, null],
])('sizes a %ix%i frame to a 512px shorter side within the pixel budget, or refuses it: %j', (width, height, frame) => {
    expect(modelFrameSize(width, height)).toEqual(frame)
})

it('refuses a narrow page whose 512px shorter side would exceed the pixel budget, before any model call', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl } = setup({ scene: null })
    const extreme = await request({
        page: { ...metadata.page, width: 400, height: 60_000 },
        sourceRefs: [{ pageId: 'page-1', region: null }],
        figureBox: null,
    })
    const response = await handler(extreme)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ notDispatched: true })
    expect(fetchImpl).not.toHaveBeenCalled()
})

it('does not charge the daily cap when the shared public claim refuses before dispatch', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, fetchImpl, counter } = setup({ scene: null }, 8, undefined, undefined, { dailyLimit: 1 })
    vi.spyOn(counter, 'claim').mockImplementationOnce(() => {
        throw new BudgetError()
    })
    expect(await (await handler(await request())).json()).toMatchObject({
        code: 'budget_exhausted',
        notDispatched: true,
    })
    expect((await handler(await request())).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
})
