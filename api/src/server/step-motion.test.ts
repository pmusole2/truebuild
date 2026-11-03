import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { STEP_MOTION_PROMPT_VERSION, type StepMotionRequest } from '@truebuild/contracts'
import { createMetaProvider } from '../providers/meta-provider'
import { aiPolicyFromEnvironment } from './ai-policy'
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
    figureBox: [0.25, 0.25, 0.5, 0.5],
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
    const page = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#456789' } })
        .png()
        .toBuffer()
    form.set('metadata', JSON.stringify(value))
    form.set(`page:${value.page.pageId}`, new File([page], 'page.png', { type: 'image/png' }))
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
    expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineMs: 90_000, signal: expect.any(AbortSignal) }),
        expect.any(Function),
    )
    const body = bodies[0]!
    expect(body).toMatchObject({
        model: 'muse-wonder-1.0',
        reasoning: { effort: 'high' },
        max_output_tokens: 4096,
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
    expect(await sharp(image).metadata()).toMatchObject({ width: 32, height: 32 })
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

it('does not cache a pre-claim budget rejection and accepts schema-valid metadata above 64KiB', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handler, counter, fetchImpl } = setup({ scene: null })
    vi.spyOn(counter, 'claim').mockImplementationOnce(() => {
        throw new BudgetError()
    })
    const refused = await handler(await request())
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ notDispatched: true })
    const large = { actions: Array.from({ length: 32 }, () => 'a'.repeat(2000)), instructionText: 'b'.repeat(16000) }
    expect((await handler(await request(large))).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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
