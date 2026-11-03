import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { paddedStepFigureBox, STEP_MOTION_PROMPT_VERSION, type StepMotionRequest } from '@truebuild/contracts'
import { createMetaProvider, stepMotionTextBytes } from '../providers/meta-provider'
import { aiPolicyFromEnvironment, STEP_MOTION_POLICY } from './ai-policy'
import { SharedKeyAuth } from './auth'
import { BudgetError, ConcurrencyGate, ModelCallCounter } from './budget'
import { createBackgroundWork, guardModelFetch } from './model-service'
import { createStepMotionHandler, estimatedStepMotionCostUsd, stepMotionCacheKey } from './step-motion'

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
    page: { pageId: 'page-1', width: 64, height: 64, mimeType: 'image/png' },
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

async function request(overrides: Partial<StepMotionRequest> = {}, key = 'motion-fixture-key'): Promise<Request> {
    const form = new FormData()
    const value = { ...metadata, ...overrides }
    const page = await sharp({
        create: { width: value.page.width, height: value.page.height, channels: 3, background: '#456789' },
    })
        .png()
        .toBuffer()
    form.set('metadata', JSON.stringify(value))
    if (!value.cacheOnly) form.set(`page:${value.page.pageId}`, new File([page], 'page.png', { type: 'image/png' }))
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
): {
    handler: ReturnType<typeof createStepMotionHandler>
    fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
    counter: ModelCallCounter
    bodies: Record<string, unknown>[]
    run: ReturnType<typeof vi.spyOn>
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
        }),
        fetchImpl,
        counter,
        bodies,
        run,
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
    expect(await sharp(image).metadata()).toMatchObject({ width: 39, height: 39 })
    expect(JSON.parse(content[2]!.text!)).toMatchObject({
        parts: metadata.parts,
        actions: metadata.actions,
        orientation: metadata.orientation,
        connection: metadata.connection,
    })
    expect(stepMotionCacheKey(metadata)).not.toBe(stepMotionCacheKey(metadata, STEP_MOTION_PROMPT_VERSION + 1))
    expect(stepMotionCacheKey(metadata)).not.toBe(stepMotionCacheKey({ ...metadata, readingLanguage: 'es' }))
    expect(stepMotionCacheKey(metadata)).not.toBe(stepMotionCacheKey({ ...metadata, stepId: 'step-2' }))
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
    const busy = await handler(await request({ stepId: 'step-3' }))
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
