import { createHash } from 'node:crypto'

import { createDemoManual, type CheckResult, type QuestionResult } from '@truebuild/contracts'
import { modelCheckMetadataSchema, type ModelCheckMetadata } from '@truebuild/contracts/model'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import type { MetaProvider } from '../providers/meta-provider'
import { SharedKeyAuth } from './auth'
import { ModelCallCounter } from './budget'
import { createModelHandlers } from './model-service'
import { createRuntimeFromEnvironment } from './model-runtime'

// Everything below is synthetic unit data with local mock providers: no network, recording or live model output.
const key = 'synthetic-local-test-value'
const valid = { components: [{ type: 'part_grid', partIds: ['side-panel'] }] }
const verdict: CheckResult = {
    decision: 'cannot_verify',
    orientationAssessment: 'uncertain',
    reason: 'Synthetic check',
    sourceRefs: [],
    observedRegion: null,
    missingEvidence: ['Need a clearer view'],
    model: 'muse-spark-1.3',
}
const answer: QuestionResult = { answer: 'Synthetic answer', sourceRefs: [], missingEvidence: [] }
const proposing = (layout: unknown): CheckResult => ({ ...verdict, layout }) as CheckResult

async function setup(): Promise<{ metadata: ModelCheckMetadata; bytes: Uint8Array }> {
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
    const metadata = modelCheckMetadataSchema.parse({
        mode: 'model',
        requestId: 'request-1',
        session,
        binding: { kind: 'capture', manualId: session.manualId, revision: 1, stepId: 'step-1', captureId: 'capture-1' },
        sourcePageIds: ['demo-page-1'],
        observation: { mimeType: 'image/png', width: 20, height: 16 },
    })

    return { metadata, bytes }
}

function request(state: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}): Request {
    const form = new FormData()
    form.set('metadata', JSON.stringify({ ...state.metadata, ...extra }))
    form.set('source-0', new Blob([new Uint8Array(state.bytes)], { type: 'image/png' }), 'source.png')
    form.set('observation', new Blob([new Uint8Array(state.bytes)], { type: 'image/png' }), 'observation.png')

    return new Request('http://127.0.0.1:3001/api/checks', {
        method: 'POST',
        headers: { 'x-truebuild-key': key, origin: 'http://localhost:8081' },
        body: form,
    })
}

function harness(
    state: Awaited<ReturnType<typeof setup>>,
    options: { layout?: boolean; check?: CheckResult; question?: QuestionResult; secondary?: CheckResult },
): { handlers: ReturnType<typeof createModelHandlers>; calls: ReturnType<typeof vi.fn>; counter: ModelCallCounter } {
    const calls = vi.fn()
    const counter = new ModelCallCounter(10)
    const provider: MetaProvider = {
        parseManual: async (): Promise<never> => {
            throw new Error('unexpected_parse')
        },
        checkStep: async (): Promise<CheckResult> => {
            calls('check')

            return options.check ?? verdict
        },
        answerQuestion: async (): Promise<QuestionResult> => {
            calls('question')

            return options.question ?? answer
        },
        secondOpinion: async (): Promise<CheckResult> => {
            calls('secondary')

            return options.secondary ?? verdict
        },
    }
    const handlers = createModelHandlers({
        auth: new SharedKeyAuth({ sharedSecret: key }),
        counter,
        provider,
        samProvider: null,
        ...(options.layout === undefined ? {} : { layout: options.layout }),
        secondOpinionModel: 'muse-wonder-1.0',
    })

    return { handlers, calls, counter }
}

describe('MODEL_LAYOUT service boundary (same single model dispatch)', (): void => {
    it.each([
        ['unset', undefined],
        ['off', false],
    ])(
        '%s ignores a proposed layout and returns the unchanged response shape',
        async (_name, layout): Promise<void> => {
            const state = await setup()
            const { handlers, calls, counter } = harness(state, { layout, check: proposing(valid) })
            const body = await (await handlers.check(request(state))).json()
            expect(body.value).not.toHaveProperty('layout')
            expect(body.value).toMatchObject({ decision: 'cannot_verify', model: 'muse-spark-1.3' })
            expect(calls.mock.calls).toEqual([['check']])
            expect(counter.used).toBe(1)
        },
    )

    it('keeps a valid proposal as model-sourced with exactly one dispatch', async (): Promise<void> => {
        const state = await setup()
        const { handlers, calls, counter } = harness(state, { layout: true, check: proposing(valid) })
        const response = await handlers.check(request(state))
        expect(response.status).toBe(200)
        expect((await response.json()).value).toMatchObject({ ...verdict, layout: { source: 'model', ...valid } })
        expect(calls.mock.calls).toEqual([['check']])
        expect(counter.used).toBe(1)
    })

    it.each([
        ['missing', undefined],
        ['unknown component', { components: [{ type: 'banner' }] }],
        ['extra keys', { ...valid, style: 'x' }],
        ['forged provenance', { source: 'model', components: [{ type: 'banner' }] }],
        ['another step', { components: [{ type: 'part_grid', partIds: ['divider'] }] }],
        ['oversized', { components: Array.from({ length: 9 }, () => valid.components[0]) }],
    ])('%s layout falls back while preserving the verdict', async (_name, layout): Promise<void> => {
        const state = await setup()
        const { handlers, calls } = harness(state, { layout: true, check: proposing(layout) })
        const response = await handlers.check(request(state))
        expect(response.status).toBe(200)
        const { value } = await response.json()
        expect(value).toMatchObject({ ...verdict })
        expect(value.layout.source).toBe('fallback')
        expect(value.layout.components[0]).toEqual({ type: 'part_grid', partIds: ['side-panel'] })
        expect(calls).toHaveBeenCalledTimes(1)
    })

    it('offers recovery only from the reviewed correction of a refusal', async (): Promise<void> => {
        const state = await setup()
        const refusal: CheckResult = {
            ...verdict,
            decision: 'refuse',
            orientationAssessment: 'reversed',
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            missingEvidence: [],
        }
        const recovery = { components: [{ type: 'recovery', actionIds: ['turn-panel'] }] }
        const refused = await (
            await harness(state, {
                layout: true,
                check: { ...refusal, layout: recovery } as CheckResult,
            }).handlers.check(request(state))
        ).json()
        expect(refused.value.layout).toEqual({ source: 'model', ...recovery })
        const passed = await (
            await harness(state, {
                layout: true,
                check: proposing(recovery),
            }).handlers.check(request(state))
        ).json()
        expect(passed.value.layout.source).toBe('fallback')
        expect(passed.value.layout.components.map((c: { type: string }) => c.type)).not.toContain('recovery')
    })

    it('resolves the ask response with the same flag and single dispatch', async (): Promise<void> => {
        const state = await setup()
        const ask = { question: 'Which way?', target: { kind: 'part', partId: 'side-panel' } }
        const on = harness(state, { layout: true, question: { ...answer, layout: valid } as QuestionResult })
        const enabled = await (await on.handlers.question(request(state, { ...ask, requestId: 'ask-1' }))).json()
        expect(enabled.value).toEqual({ ...answer, layout: { source: 'model', ...valid } })
        expect(on.calls.mock.calls).toEqual([['question']])
        const off = harness(state, { question: { ...answer, layout: valid } as QuestionResult })
        const disabled = await (await off.handlers.question(request(state, { ...ask, requestId: 'ask-2' }))).json()
        expect(disabled.value).toEqual(answer)
        const recovery = { components: [{ type: 'recovery', actionIds: ['turn-panel'] }] }
        const none = harness(state, { layout: true, question: { ...answer, layout: recovery } as QuestionResult })
        const asked = await (await none.handlers.question(request(state, { ...ask, requestId: 'ask-3' }))).json()
        expect(asked.value.layout.source).toBe('fallback')
    })

    it('applies the flag to a second opinion without adding dispatches beyond that one follow-up', async (): Promise<void> => {
        const state = await setup()
        const refusal = {
            ...verdict,
            model: 'muse-wonder-1.0',
            decision: 'refuse',
            orientationAssessment: 'reversed',
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            observedRegion: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            missingEvidence: [],
            layout: valid,
        } as CheckResult
        for (const layout of [true, false]) {
            const { handlers, calls } = harness(state, { layout, secondary: refusal })
            const first = await (await handlers.check(request(state))).json()
            const token = first.value.secondOpinion.token
            const second = await (await handlers.secondOpinion(request(state, { secondOpinionToken: token }))).json()
            expect(second.value).toMatchObject({ decision: 'refuse', secondOpinion: { status: 'completed' } })
            if (layout) expect(second.value.layout).toEqual({ source: 'model', ...valid })
            else expect(second.value).not.toHaveProperty('layout')
            expect(calls.mock.calls).toEqual([['check'], ['secondary']])
        }
    })
})

describe('MODEL_LAYOUT runtime configuration', (): void => {
    it.each([undefined, '', '0'])('is off for %j', (value): void => {
        expect(createRuntimeFromEnvironment({ MODEL_LAYOUT: value }).layout).toBe(false)
    })

    it('is on only for the explicit value 1', (): void => {
        expect(createRuntimeFromEnvironment({ MODEL_LAYOUT: '1' }).layout).toBe(true)
    })

    it.each(['true', 'yes', 'on', 'off', '2', ' 1', '01', '-1', 'TRUE'])('rejects invalid value %j', (value): void => {
        expect(() => createRuntimeFromEnvironment({ MODEL_LAYOUT: value })).toThrow('invalid_model_layout')
    })

    it.each([undefined, '', '0'])('keeps the separate Wonder layout flag off for %j', (value): void => {
        expect(createRuntimeFromEnvironment({ MODEL_LAYOUT: '1', MODEL_LAYOUT_WONDER: value }).layoutWonder).toBe(false)
        expect(createRuntimeFromEnvironment({ MODEL_LAYOUT_WONDER: value }).layoutWonder).toBe(false)
    })

    it('turns the Wonder layout flag on only for 1 and only with MODEL_LAYOUT=1', (): void => {
        expect(createRuntimeFromEnvironment({ MODEL_LAYOUT: '1', MODEL_LAYOUT_WONDER: '1' }).layoutWonder).toBe(true)
        expect(() => createRuntimeFromEnvironment({ MODEL_LAYOUT_WONDER: '1' })).toThrow('invalid_model_layout_wonder')
    })

    it.each(['true', 'yes', '2', ' 1', 'TRUE'])('rejects invalid Wonder layout value %j', (value): void => {
        expect(() => createRuntimeFromEnvironment({ MODEL_LAYOUT: '1', MODEL_LAYOUT_WONDER: value })).toThrow(
            'invalid_model_layout_wonder',
        )
    })

    it.each([
        ['unset', undefined, false],
        ['1', '1', true],
    ])(
        'wires MODEL_LAYOUT=%s through the real provider with one outbound request',
        async (_n, flag, shown): Promise<void> => {
            const state = await setup()
            const modelOutput = {
                ...verdict,
                partsAssessment: 'unobservable',
                connectionAssessment: 'unobservable',
                checks: [],
                model: undefined,
                layout: valid,
            }
            const outbound = vi.fn<typeof fetch>(async (): Promise<Response> =>
                Response.json({
                    status: 'completed',
                    output: [
                        {
                            type: 'message',
                            role: 'assistant',
                            status: 'completed',
                            content: [{ type: 'output_text', text: JSON.stringify(modelOutput) }],
                        },
                    ],
                }),
            )
            vi.spyOn(console, 'info').mockImplementation((): void => {})
            const runtime = createRuntimeFromEnvironment(
                {
                    PROVIDER_MODE: 'meta',
                    MODEL_API_KEY: '<synthetic>',
                    API_SHARED_SECRET: key,
                    MODEL_CALL_LIMIT: '3',
                    ...(flag === undefined ? {} : { MODEL_LAYOUT: flag }),
                },
                outbound,
            )
            const response = await runtime.model.check(request(state))
            expect(response.status).toBe(200)
            const { value } = await response.json()
            expect(value.decision).toBe('cannot_verify')
            if (shown) expect(value.layout).toEqual({ source: 'model', ...valid })
            else expect(value).not.toHaveProperty('layout')
            expect(outbound).toHaveBeenCalledTimes(1)
            const sent = JSON.parse(String(outbound.mock.calls[0]?.[1]?.body))
            // Flag off keeps the legacy wire schema; flag on asks for layout and regions in this same request.
            for (const key of ['layout', 'nextPartRegion', 'targetRegion']) {
                if (shown) {
                    expect(sent.text.format.schema.properties).toHaveProperty(key)
                    expect(sent.text.format.schema.required).toContain(key)
                } else {
                    expect(sent.text.format.schema.properties).not.toHaveProperty(key)
                    expect(sent.text.format.schema.required).not.toContain(key)
                }
            }
            expect(sent.max_output_tokens).toBe(1500)
            expect(runtime.counter.used).toBe(1)
        },
    )
})
