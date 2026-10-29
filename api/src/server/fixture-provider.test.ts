import { createHash } from 'node:crypto'

import {
    checkResultSchema,
    createDemoManual,
    FIXTURE_EVIDENCE,
    questionResultSchema,
    screensResultSchema,
    type CheckResult,
    type QuestionResult,
} from '@truebuild/contracts'
import { overlayResultSchema } from '@truebuild/contracts/model'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../app'
import { MetaProviderError, type MetaProvider, type OverlayGeneration } from '../providers/meta-provider'
import { createModelHandlers } from './model-service'
import { createRuntimeFromEnvironment } from './model-runtime'

// A trusted in-process fixture provider under `runtimeMode: 'fixture'`: no network, key or recorded model output.
const KEY = 'synthetic-local-test-value'
afterEach(() => vi.restoreAllMocks())

const observed = {
    stage: 'verdict' as const,
    model: 'muse-spark-1.3' as const,
    effort: 'low' as const,
    timing: {
        timeToProviderMs: 1,
        paceWaitMs: 0,
        networkMs: 1,
        bodyMs: 1,
        providerMs: 2,
        parseValidateMs: 1,
        totalMs: 4,
    },
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 },
}
const refs = [{ pageId: 'demo-page-1', region: null }]
const box = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }

interface Style {
    /** The fixture source keeps a private target identity and fabricated telemetry on its raw values. */
    claims: boolean
    overlay: 'fixture' | 'live-shaped' | 'fixture-with-telemetry'
    secondOpinionFails?: boolean
}

function stub(style: Style): MetaProvider {
    const claims = (model: 'muse-spark-1.3' | 'muse-wonder-1.0'): Partial<CheckResult> =>
        style.claims ? { model, telemetry: observed } : {}
    const overlay = async (): Promise<OverlayGeneration> => {
        const value = { observedRegion: box, layout: undefined, nextPartRegion: undefined, targetRegion: undefined }
        const call = {
            stage: 'overlay' as const,
            model: 'muse-wonder-1.0' as const,
            effort: 'max' as const,
            timeToProviderMs: 1,
            providerMs: 2,
            parseValidateMs: 1,
            totalMs: 4,
            usage: {},
        }
        return style.overlay === 'live-shaped'
            ? { value, telemetry: call }
            : style.overlay === 'fixture-with-telemetry'
              ? ({ value, evidence: FIXTURE_EVIDENCE, telemetry: call } as unknown as OverlayGeneration)
              : { value, evidence: FIXTURE_EVIDENCE }
    }
    return {
        async parseManual(): Promise<never> {
            throw new MetaProviderError('unconfigured')
        },
        async checkStep(): Promise<CheckResult> {
            return {
                ...claims('muse-spark-1.3'),
                decision: 'cannot_verify',
                orientationAssessment: 'uncertain',
                reason: 'A closer look is needed.',
                sourceRefs: refs,
                observedRegion: null,
                missingEvidence: ['The connection needs a closer look.'],
            }
        },
        async secondOpinion(): Promise<CheckResult> {
            if (style.secondOpinionFails === true) throw new MetaProviderError('provider_error')
            return {
                ...claims('muse-wonder-1.0'),
                decision: 'refuse',
                orientationAssessment: 'reversed',
                reason: 'Check the connection against the manual picture.',
                sourceRefs: refs,
                observedRegion: box,
                missingEvidence: [],
            }
        },
        async answerQuestion(): Promise<QuestionResult> {
            return {
                ...(style.claims ? { model: 'muse-spark-1.3' as const, telemetry: observed } : {}),
                answer: 'The groove faces inward.',
                sourceRefs: refs,
                missingEvidence: [],
            }
        },
        overlay,
    }
}

async function boot(
    provider: MetaProvider,
    mode: 'fixture' | 'meta',
    extra: Partial<Parameters<typeof createModelHandlers>[0]> = {},
): Promise<{
    app: ReturnType<typeof createApp>
    form: (fields?: Record<string, unknown>) => FormData
    send: (path: string, body: FormData) => Promise<Response>
    session: ReturnType<typeof createDemoManual>
}> {
    vi.spyOn(console, 'info').mockImplementation((): void => {})
    const base = createRuntimeFromEnvironment({
        PROVIDER_MODE: 'fixture',
        API_SHARED_SECRET: KEY,
        GENERATIVE_UI: 'full',
        MODEL_SECOND_OPINION: 'muse-wonder-1.0',
        MODEL_LAYOUT_WONDER: '1',
        MODEL_SEGMENTS: '0',
    })
    const model = createModelHandlers({
        provider,
        samProvider: null,
        auth: base.auth,
        counter: base.counter,
        allowedOrigins: base.allowedOrigins,
        policy: base.policy,
        runtimeMode: mode,
        secondOpinionModel: 'muse-wonder-1.0',
        followUps: { overlay: true, segments: false },
        ...extra,
    })
    const app = createApp({ runtime: { ...base, model }, onDuration: () => {} })
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
    const binding = {
        kind: 'capture' as const,
        manualId: session.manualId,
        revision: session.revision,
        stepId: 'step-1',
        captureId: 'capture-1',
    }
    const form = (fields: Record<string, unknown> = {}): FormData => {
        const body = new FormData()
        body.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'fixture-provider',
                binding,
                session,
                sourcePageIds: ['demo-page-1'],
                observation: { mimeType: 'image/png', width: 20, height: 16 },
                ...fields,
            }),
        )
        body.set('source-0', new Blob([bytes], { type: 'image/png' }), 'source.png')
        body.set('observation', new Blob([bytes], { type: 'image/png' }), 'observation.png')
        return body
    }
    const send = async (path: string, body: FormData): Promise<Response> =>
        app.request(path, { method: 'POST', headers: { 'x-truebuild-key': KEY }, body })
    return { app, form, send, session }
}

interface Published {
    [key: string]: unknown
    secondOpinion?: { token: string }
    followUps?: { overlay: { token: string } }
    modelNotes?: string[]
}
const valueOf = async (response: Response): Promise<Published> =>
    ((await response.json()) as { value: Published }).value

describe('a trusted fixture provider under the fixture runtime', (): void => {
    it.each([
        ['keeps a private target identity and fabricated telemetry', true],
        ['states no identity at all', false],
    ])('publishes an uncertain verdict with the second-pass offer when the source %s', async (_name, claims) => {
        const { send, form } = await boot(stub({ claims, overlay: 'fixture' }), 'fixture')
        const response = await send('/api/checks', form())
        expect(response.status).toBe(200)
        const value = await valueOf(response)
        // The public value validates exactly as a client validates it, and claims nothing was observed.
        expect(checkResultSchema.safeParse(value).success).toBe(true)
        expect(value).toMatchObject({
            decision: 'cannot_verify',
            evidence: FIXTURE_EVIDENCE,
            secondOpinion: { model: 'muse-wonder-1.0', status: 'available' },
            followUps: { overlay: { status: 'available', model: 'muse-wonder-1.0' } },
        })
        expect(value).not.toHaveProperty('model')
        expect(value).not.toHaveProperty('telemetry')
    })

    it('completes the second pass without naming a contributor, a model or telemetry', async () => {
        const { send, form } = await boot(stub({ claims: true, overlay: 'fixture' }), 'fixture')
        const first = await valueOf(await send('/api/checks', form()))
        const response = await send(
            '/api/checks/second-opinion',
            form({ secondOpinionToken: first.secondOpinion!.token }),
        )
        expect(response.status).toBe(200)
        const value = await valueOf(response)
        expect(checkResultSchema.safeParse(value).success).toBe(true)
        expect(value).toMatchObject({
            decision: 'refuse',
            evidence: FIXTURE_EVIDENCE,
            secondOpinion: { status: 'completed' },
        })
        expect(value).not.toHaveProperty('model')
        expect(value).not.toHaveProperty('telemetry')
        expect((value.modelNotes ?? []).join(' ')).not.toMatch(/spark|wonder/iu)
    })

    it('keeps the original uncertainty, neutrally worded, when the second pass fails', async () => {
        const { send, form } = await boot(
            stub({ claims: false, overlay: 'fixture', secondOpinionFails: true }),
            'fixture',
        )
        const first = await valueOf(await send('/api/checks', form()))
        const value = await valueOf(
            await send('/api/checks/second-opinion', form({ secondOpinionToken: first.secondOpinion!.token })),
        )
        expect(checkResultSchema.safeParse(value).success).toBe(true)
        expect(value).toMatchObject({ decision: 'cannot_verify', secondOpinion: { status: 'unavailable' } })
        expect((value.modelNotes ?? []).join(' ')).not.toMatch(/spark|wonder/iu)
    })

    it.each(['fixture', 'fixture-with-telemetry'] as const)(
        'publishes a %s overlay with its regions and no effort, model or provider clock',
        async (overlay) => {
            const { send, form } = await boot(stub({ claims: true, overlay }), 'fixture')
            const first = await valueOf(await send('/api/checks', form()))
            const response = await send('/api/checks/overlay', form({ overlayToken: first.followUps!.overlay.token }))
            expect(response.status).toBe(200)
            const value = await valueOf(response)
            expect(overlayResultSchema.safeParse(value).success).toBe(true)
            expect(value).toMatchObject({ evidence: FIXTURE_EVIDENCE, observedRegion: box })
            for (const claim of ['model', 'effort', 'telemetry']) expect(value).not.toHaveProperty(claim)
        },
    )

    it('strips the claims of a question answer as well', async () => {
        const { send, form } = await boot(stub({ claims: true, overlay: 'fixture' }), 'fixture')
        const response = await send(
            '/api/questions',
            form({ question: 'Which way?', target: { kind: 'point', x: 0.5, y: 0.5 } }),
        )
        const value = await valueOf(response)
        expect(questionResultSchema.safeParse(value).success).toBe(true)
        expect(value).toMatchObject({ answer: 'The groove faces inward.' })
        expect(value).not.toHaveProperty('model')
        expect(value).not.toHaveProperty('telemetry')
    })
})

describe('the live runtime stays strict', (): void => {
    it('publishes the observed model and telemetry unchanged and never stamps fixture evidence', async () => {
        const { send, form } = await boot(stub({ claims: true, overlay: 'live-shaped' }), 'meta')
        const value = await valueOf(await send('/api/checks', form()))
        expect(value).toMatchObject({ model: 'muse-spark-1.3', telemetry: { stage: 'verdict' } })
        expect(value).not.toHaveProperty('evidence')
        expect(value.secondOpinion).toMatchObject({ status: 'available' })
        const overlay = await valueOf(
            await send('/api/checks/overlay', form({ overlayToken: value.followUps!.overlay.token })),
        )
        expect(overlay).toMatchObject({ model: 'muse-wonder-1.0', effort: 'max' })
        expect(overlay).not.toHaveProperty('evidence')
    })

    it('offers no second pass for a verdict that names no Spark model', async () => {
        const { send, form } = await boot(stub({ claims: false, overlay: 'live-shaped' }), 'meta')
        const value = await valueOf(await send('/api/checks', form()))
        expect(value).not.toHaveProperty('secondOpinion')
        expect(value).not.toHaveProperty('evidence')
    })

    it('rejects a provider result that claims fixture evidence', async () => {
        const provider = stub({ claims: true, overlay: 'live-shaped' })
        provider.checkStep = async (): Promise<CheckResult> =>
            ({
                model: 'muse-spark-1.3',
                evidence: FIXTURE_EVIDENCE,
                decision: 'pass',
                reason: 'Looks right.',
                sourceRefs: refs,
                observedRegion: null,
                missingEvidence: [],
            }) as unknown as CheckResult
        const { send, form } = await boot(provider, 'meta')
        expect((await send('/api/checks', form())).status).toBe(502)
    })

    it.each(['fixture', 'fixture-with-telemetry'] as const)(
        'rejects an overlay generation without observations (%s) instead of publishing it',
        async (overlay) => {
            const { send, form } = await boot(stub({ claims: true, overlay }), 'meta')
            const first = await valueOf(await send('/api/checks', form()))
            const response = await send('/api/checks/overlay', form({ overlayToken: first.followUps!.overlay.token }))
            expect(response.status).toBe(502)
            expect(await response.json()).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
        },
    )

    it('never lets a request choose simulation', async () => {
        const { send, form } = await boot(stub({ claims: true, overlay: 'live-shaped' }), 'meta')
        const response = await send('/api/checks', form({ evidence: FIXTURE_EVIDENCE }))
        expect(response.status).toBe(400)
    })

    it('ignores an injected synthetic screen source outside the fixture runtime', async () => {
        const generator = vi.fn(async () => {
            throw new Error('a synthetic source must not run in a live runtime')
        })
        const { send } = await boot(stub({ claims: true, overlay: 'live-shaped' }), 'meta', {
            screenFixtures: generator,
        })
        const body = new FormData()
        body.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'screens-live',
                op: 'generate',
                kind: 'home',
                binding: null,
                session: null,
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                focusStepId: null,
                want: [],
            }),
        )
        const response = await send('/api/screens', body)
        expect(response.status).toBe(200)
        const parsed = screensResultSchema.parse(await response.json())
        expect(generator).not.toHaveBeenCalled()
        if (parsed.status !== 'ok') throw new Error('unavailable')
        expect(parsed.value.document?.metadata.source).not.toBe('generated')
    })
})
