import { modelCheckMetadataSchema, modelQuestionMetadataSchema } from '@truebuild/contracts/model'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkInputFor, stepFixtures, type StepFixture } from '../test-support/step-fixtures'
import { createRuntimeFromEnvironment } from './model-runtime'

// MOCKED: the runtime below is the real server + real Meta provider, but its only transport is a local fetch stub that
// returns hand-written synthetic replies. No Meta request, key, recorded output, port or process is involved.
const secret = 'synthetic-local-test-value'
const grid = { x1: 100, y1: 200, x2: 400, y2: 600 }
const normalized = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
const verdict = {
    decision: 'cannot_verify',
    orientationAssessment: 'uncertain',
    reason: 'Synthetic mocked result',
    sourceRefs: [],
    observedRegion: null,
    missingEvidence: ['Need a clearer view'],
    partsAssessment: 'unobservable',
    connectionAssessment: 'unobservable',
    checks: [],
}
const answer = {
    answer: 'Synthetic mocked answer',
    sourceRefs: [],
    missingEvidence: ['Need a clearer view'],
    observedRegion: null,
}

afterEach((): void => {
    vi.restoreAllMocks()
})

async function multipart(fixture: StepFixture, extra: Record<string, unknown> = {}): Promise<Request> {
    const input = await checkInputFor(fixture)
    const metadata = ('question' in extra ? modelQuestionMetadataSchema : modelCheckMetadataSchema).parse({
        mode: 'model',
        requestId: 'request-guidance',
        session: input.session,
        binding: input.binding,
        sourcePageIds: input.sourceImages.map((source) => source.page.pageId),
        observation: { mimeType: 'image/png', width: 8, height: 4 },
        ...extra,
    })
    const form = new FormData()
    form.set('metadata', JSON.stringify(metadata))
    for (const [index, source] of input.sourceImages.entries()) {
        form.set(`source-${index}`, new Blob([new Uint8Array(source.bytes)], { type: 'image/png' }), 's.png')
    }
    form.set('observation', new Blob([new Uint8Array(input.observation.bytes)], { type: 'image/png' }), 'o.png')

    return new Request('http://127.0.0.1:3001/api/checks', {
        method: 'POST',
        headers: { 'x-truebuild-key': secret, origin: 'http://localhost:8081' },
        body: form,
    })
}

function runtime(
    reply: unknown,
    layout: boolean,
): { run: ReturnType<typeof createRuntimeFromEnvironment>; outbound: ReturnType<typeof vi.fn<typeof fetch>> } {
    const outbound = vi.fn<typeof fetch>(async (): Promise<Response> =>
        Response.json({
            status: 'completed',
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: JSON.stringify(reply) }],
                },
            ],
        }),
    )
    vi.spyOn(console, 'info').mockImplementation((): void => {})
    const run = createRuntimeFromEnvironment(
        {
            PROVIDER_MODE: 'meta',
            MODEL_API_KEY: '<synthetic>',
            API_SHARED_SECRET: secret,
            MODEL_CALL_LIMIT: '3',
            ...(layout ? { MODEL_LAYOUT: '1' } : {}),
        },
        outbound,
    )

    return { run, outbound }
}

describe.each(stepFixtures())('MOCKED public check/ask regions on the $name manual', (fixture: StepFixture): void => {
    const proposal = { components: [{ type: 'part_grid', partIds: [fixture.partId] }] }

    it('publishes real-part regions in normalized units from one single dispatch', async (): Promise<void> => {
        const reply = {
            ...verdict,
            layout: proposal,
            nextPartRegion: { partId: fixture.partId, region: grid },
            targetRegion: { partId: fixture.partId, region: { x1: 500, y1: 500, x2: 900, y2: 900 } },
        }
        const { run, outbound } = runtime(reply, true)
        const response = await run.model.check(await multipart(fixture))
        expect(response.status).toBe(200)
        const { value } = await response.json()
        expect(value).toMatchObject({
            decision: 'cannot_verify',
            layout: { source: 'model', ...proposal },
            nextPartRegion: { partId: fixture.partId, region: normalized },
            targetRegion: { partId: fixture.partId, region: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 } },
        })
        expect(outbound).toHaveBeenCalledTimes(1)
        expect(run.counter.used).toBe(1)
    })

    it('rejects a region of a part outside the current step while keeping verdict and valid sibling', async (): Promise<void> => {
        const reply = {
            ...verdict,
            nextPartRegion: { partId: fixture.partId, region: grid },
            targetRegion: { partId: fixture.otherPartId, region: grid },
        }
        const { run } = runtime(reply, true)
        const { value } = await (await run.model.check(await multipart(fixture))).json()
        expect(value).toMatchObject({ decision: 'cannot_verify', nextPartRegion: { partId: fixture.partId } })
        expect(value).not.toHaveProperty('targetRegion')
    })

    it('rejects an invented part id and an inverted grid box without failing the result', async (): Promise<void> => {
        const reply = {
            ...verdict,
            nextPartRegion: { partId: 'invented-part', region: grid },
            targetRegion: { partId: fixture.partId, region: { x1: 900, y1: 900, x2: 100, y2: 100 } },
        }
        const { run } = runtime(reply, true)
        const response = await run.model.check(await multipart(fixture))
        expect(response.status).toBe(200)
        const { value } = await response.json()
        expect(value.decision).toBe('cannot_verify')
        expect(value).not.toHaveProperty('nextPartRegion')
        expect(value).not.toHaveProperty('targetRegion')
    })

    it('keeps absence absent and uses the deterministic fallback layout', async (): Promise<void> => {
        const { run } = runtime(verdict, true)
        const { value } = await (await run.model.check(await multipart(fixture))).json()
        expect(value).not.toHaveProperty('nextPartRegion')
        expect(value).not.toHaveProperty('targetRegion')
        expect(value.layout.source).toBe('fallback')
    })

    it('with the flag off omits layout and regions: the response keeps the pre-change shape and request schema', async (): Promise<void> => {
        const stray = {
            ...verdict,
            layout: proposal,
            nextPartRegion: { partId: fixture.partId, region: grid },
        }
        const { run, outbound } = runtime(stray, false)
        const { value } = await (await run.model.check(await multipart(fixture))).json()
        expect(Object.keys(value).sort()).toEqual(
            [
                'decision',
                'missingEvidence',
                'model',
                'observedRegion',
                'orientationAssessment',
                'reason',
                'sourceRefs',
            ].sort(),
        )
        const sent = JSON.parse(String(outbound.mock.calls[0]?.[1]?.body))
        expect(sent.text.format.schema.properties).not.toHaveProperty('nextPartRegion')
        expect(sent.max_output_tokens).toBe(1500)
    })

    it('resolves the ask response with the same flag, real part identity and one dispatch', async (): Promise<void> => {
        const reply = {
            ...answer,
            layout: proposal,
            nextPartRegion: { partId: fixture.partId, region: grid },
            targetRegion: { partId: fixture.otherPartId, region: grid },
        }
        const { run, outbound } = runtime(reply, true)
        const ask = { question: 'Where does this go?', target: { kind: 'part', partId: fixture.partId } }
        const { value } = await (await run.model.question(await multipart(fixture, ask))).json()
        expect(value).toMatchObject({
            answer: answer.answer,
            layout: { source: 'model', ...proposal },
            nextPartRegion: { partId: fixture.partId, region: normalized },
        })
        expect(value).not.toHaveProperty('targetRegion')
        expect(outbound).toHaveBeenCalledTimes(1)
    })
})
