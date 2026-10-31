import { createHash } from 'node:crypto'

import {
    createDemoManual,
    SCREEN_KINDS,
    screenComponentPaths,
    screenContextJson,
    screensResultSchema,
    type ScreenKind,
    type ScreenDocument,
    type ScreensResult,
} from '@truebuild/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { MOCK_PROVIDER_KEY, startMetaMock, type ScreenScenario } from '../../test-support/meta-http-mock'
import { stepFixtures } from '../../test-support/step-fixtures'
import { createRuntimeFromEnvironment } from '../model-runtime'

// The only provider is the documented loopback mock (startMetaMock): no Meta request, key or recorded output.
const KEY = 'synthetic-local-test-value'
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()))
    vi.restoreAllMocks()
})

async function boot(
    env: Record<string, string> = {},
    mock: Parameters<typeof startMetaMock>[0] = {},
): Promise<{ app: ReturnType<typeof createApp>; mock: Awaited<ReturnType<typeof startMetaMock>> }> {
    const started = await startMetaMock(mock)
    closers.push(() => started.close())
    const runtime = createRuntimeFromEnvironment(
        { PROVIDER_MODE: 'meta', MODEL_API_KEY: '<synthetic>', API_SHARED_SECRET: KEY, ...env },
        started.transport,
    )
    return { app: createApp({ runtime, onDuration: () => {} }), mock: started }
}

type Metadata = Record<string, unknown>
type OkValue = Extract<ScreensResult, { status: 'ok' }>['value']
const session = createDemoManual()
const binding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
const base = {
    mode: 'model',
    requestId: 'screens-test',
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
}
const guide = (stepId = 'step-1', revision = session.revision): Metadata => ({
    ...base,
    kind: 'guide',
    binding: { ...binding, revision },
    session: { ...session, revision },
    stepId,
})

async function post(
    app: ReturnType<typeof createApp>,
    metadata: Metadata,
    key: string | null = KEY,
): Promise<Response> {
    const form = new FormData()
    form.set('metadata', JSON.stringify(metadata))
    return app.request('/api/screens', {
        method: 'POST',
        headers: key === null ? {} : { 'x-truebuild-key': key },
        body: form,
    })
}

async function document(app: ReturnType<typeof createApp>, metadata: Metadata): Promise<ScreenDocument> {
    const response = await post(app, metadata)
    expect(response.status).toBe(200)
    const parsed = screensResultSchema.parse(await response.json())
    if (parsed.status !== 'ok' || parsed.value.document === null) throw new Error('missing_document')
    return parsed.value.document
}

describe('/api/screens admission', (): void => {
    it('requires the shared key and answers a preflight like the other model routes', async (): Promise<void> => {
        const { app, mock } = await boot()
        // Plain bodies: admission cancels an unauthenticated body, which a streaming FormData client mishandles.
        for (const headers of [{}, { 'x-truebuild-key': 'wrong' }] as Record<string, string>[]) {
            expect((await app.request('/api/screens', { method: 'POST', headers, body: 'x' })).status).toBe(401)
        }
        const options = await app.request('/api/screens', {
            method: 'OPTIONS',
            headers: { 'access-control-request-method': 'POST' },
        })
        expect(options.status).toBe(204)
        expect((await app.request('/api/screens', { method: 'GET', headers: { 'x-truebuild-key': KEY } })).status).toBe(
            405,
        )
        expect(mock.screenDispatches()).toBe(0)
    })

    it('rejects a request that carries a file or names a step that is not in the supplied session', async (): Promise<void> => {
        const { app } = await boot()
        const form = new FormData()
        form.set('metadata', JSON.stringify(base))
        form.set('photo', new Blob(['x'], { type: 'image/png' }), 'photo.png')
        const withFile = await app.request('/api/screens', {
            method: 'POST',
            headers: { 'x-truebuild-key': KEY },
            body: form,
        })
        expect(withFile.status).toBe(400)
        expect((await post(app, guide('missing-step'))).status).toBe(400)
    })
})

describe('GENERATIVE_UI modes', (): void => {
    it('off makes no provider call and publishes only a shell with the reason', async (): Promise<void> => {
        const { app, mock } = await boot({ GENERATIVE_UI: 'off' })
        const shell = await document(app, guide())
        expect(shell.metadata).toMatchObject({ source: 'shell', fallbackReason: 'disabled', model: null, effort: null })
        expect(shell.body).toEqual([])
        expect(mock.screenDispatches()).toBe(0)
    })

    it('steps generates step pages only; every other screen stays a shell', async (): Promise<void> => {
        const { app, mock } = await boot({ GENERATIVE_UI: 'steps' })
        expect((await document(app, base)).metadata.source).toBe('shell')
        expect((await document(app, guide())).metadata.source).toBe('generated')
        expect(mock.screenDispatches()).toBe(1)
    })

    it('a fixture runtime composes honest synthetic examples with nothing observed and no provider call', async (): Promise<void> => {
        const outbound = vi.fn<typeof fetch>()
        const runtime = createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: KEY }, outbound)
        const app = createApp({ runtime, onDuration: () => {} })
        const home = await document(app, base)
        // Generated by the explicit fixture composer, but never live and never claiming a model, timing or usage.
        expect(home.metadata).toMatchObject({
            source: 'generated',
            evidence: 'synthetic-fixture',
            fallbackReason: null,
            model: null,
            effort: null,
            timing: { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
            usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
        })
        expect(home.body.length).toBeGreaterThan(0)
        const response = await post(app, guide())
        expect(screensResultSchema.parse(await response.json())).toMatchObject({ status: 'ok', mode: 'fixture' })
        expect(outbound).not.toHaveBeenCalled()
    })

    it('a live runtime without a key never falls back to simulation, even when a fixture source exists', async (): Promise<void> => {
        const fixture = vi.fn(async (): Promise<unknown> => {
            throw new Error('fixture_must_not_run')
        })
        const runtime = createRuntimeFromEnvironment({ PROVIDER_MODE: 'meta', API_SHARED_SECRET: KEY }, undefined, {
            screenFixtures: fixture,
        })
        const app = createApp({ runtime, onDuration: () => {} })
        const page = await document(app, guide())
        expect(page.metadata).toMatchObject({ source: 'shell', fallbackReason: 'unconfigured' })
        expect(fixture).not.toHaveBeenCalled()
    })
})

describe('generation, validation, repair and fallback', (): void => {
    it('includes admitted body-read time in screen timing rather than starting after preparation', async (): Promise<void> => {
        const { app } = await boot()
        const form = new FormData()
        form.set('metadata', JSON.stringify(base))
        const seed = new Request('http://localhost/api/screens', {
            method: 'POST',
            headers: { 'x-truebuild-key': KEY },
            body: form,
        })
        const bytes = await seed.arrayBuffer()
        const body = new ReadableStream<Uint8Array>({
            async start(controller): Promise<void> {
                await new Promise<void>((resolve) => setTimeout(resolve, 80))
                controller.enqueue(new Uint8Array(bytes))
                controller.close()
            },
        })
        const init: RequestInit & { duplex: 'half' } = {
            method: 'POST',
            headers: seed.headers,
            body,
            duplex: 'half',
        }
        const response = await app.request(new Request(seed.url, init))
        const result = screensResultSchema.parse(await response.json())
        if (result.status !== 'ok' || result.value.document === null) throw new Error('missing_document')
        const timing = result.value.document.metadata.timing
        expect(timing.timeToProviderMs).toBeGreaterThanOrEqual(60)
        expect(timing.totalMs).toBeGreaterThanOrEqual(timing.timeToProviderMs ?? 0)
    })

    it('composes Home before any manual exists on the latency model, with the real request shape and observed metadata', async (): Promise<void> => {
        const info = vi.spyOn(console, 'info').mockImplementation((): void => {})
        const { app, mock } = await boot()
        const home = await document(app, base)
        expect(home.metadata).toMatchObject({
            source: 'generated',
            evidence: 'live',
            stage: 'screen',
            model: 'muse-spark-1.3',
            effort: 'low',
            repaired: false,
            cacheHit: false,
            fallbackReason: null,
            usage: { inputTokens: 400, cachedTokens: 0, outputTokens: 90, reasoningTokens: 30 },
        })
        for (const value of Object.values(home.metadata.timing)) expect(value).toEqual(expect.any(Number))
        expect(home.bound).toMatchObject({ manualId: null, revision: null, stepId: null, captureId: null })
        const wire = mock.wireRequests[0]!
        expect(wire).toMatchObject({
            model: 'muse-spark-1.3',
            store: false,
            stream: false,
            max_output_tokens: 32000,
            reasoning: { effort: 'low' },
            text: { format: { type: 'json_schema', name: 'truebuild_screen', strict: true } },
        })
        expect(wire.input[0].content.map((part) => part.type)).toEqual(['input_text', 'input_text'])
        // Metrics carry timings, ids and counts only: never the prompt, the generated text or a credential.
        const logged = info.mock.calls.map((call) => String(call[0])).join('\n')
        expect(logged).toContain('"timeToProviderMs"')
        expect(logged).toContain('"providerMs"')
        expect(logged).toContain('"parseValidateMs"')
        expect(logged).toContain('"totalMs"')
        expect(logged).toContain('"effort":"low"')
        expect(logged).not.toContain('Follow the diagram')
        expect(logged).not.toContain(MOCK_PROVIDER_KEY)
    })

    it('uses the Wonder step-page policy for noncritical step pages', async (): Promise<void> => {
        const { app, mock } = await boot()
        const page = await document(app, guide())
        expect(page.metadata).toMatchObject({
            source: 'generated',
            stage: 'step-page',
            model: 'muse-wonder-1.0',
            effort: 'medium',
        })
        expect(mock.wireRequests[0]).toMatchObject({ model: 'muse-wonder-1.0', reasoning: { effort: 'medium' } })
        expect(page.bound).toMatchObject({ manualId: session.manualId, revision: session.revision, stepId: 'step-1' })
    })

    it('repairs invalid completed output once with the same model and machine issue codes only', async (): Promise<void> => {
        const { app, mock } = await boot({}, { screen: { scenario: 'invalid-then-valid' } })
        const page = await document(app, guide())
        expect(page.metadata).toMatchObject({ source: 'generated', repaired: true })
        expect(mock.screenDispatches()).toBe(2)
        expect(mock.wireRequests[1]!.model).toBe(mock.wireRequests[0]!.model)
        const instructions = mock.wireRequests[1]!.instructions!
        expect(instructions).toContain('Repair: your previous completed answer was rejected')
        expect(instructions).not.toContain('Broken')
        expect(page.metadata.usage.outputTokens).toBe(180)
    })

    it.each<[ScreenScenario, number, string]>([
        ['invalid', 2, 'repair_failed'],
        ['not-json', 2, 'repair_failed'],
        ['incomplete', 1, 'invalid_output'],
        ['unsupported-fact', 2, 'unsupported_content'],
    ])(
        'falls back for %s output after %i provider call(s) with reason %s',
        async (scenario, dispatches, reason): Promise<void> => {
            const { app, mock } = await boot({}, { screen: { scenario } })
            const page = await document(app, guide())
            expect(page.metadata).toMatchObject({ source: 'shell', fallbackReason: reason, evidence: 'live' })
            // Version 1 composes no replacement body: the native screen is the screen, and the mandatory facts ride along.
            expect(page.body).toEqual([])
            expect(page.manualFacts!.length).toBeGreaterThan(0)
            expect(mock.screenDispatches()).toBe(dispatches)
        },
    )

    it('reports what an unusable answer observed instead of hiding its time and tokens', async (): Promise<void> => {
        const { app } = await boot({}, { screen: { scenario: 'incomplete' } })
        const page = await document(app, guide())
        expect(page.metadata).toMatchObject({
            source: 'shell',
            model: 'muse-wonder-1.0',
            effort: 'medium',
            usage: { outputTokens: 90, reasoningTokens: 30 },
        })
        expect(page.metadata.timing.providerMs).toEqual(expect.any(Number))
    })

    it('answers a slow provider with the shell, not an error status', async (): Promise<void> => {
        const { app, mock } = await boot(
            { AI_DEADLINE_STEP_PAGES_MS: '1000' },
            { screen: { scenario: 'valid', delayMs: 1_500 } },
        )
        const page = await document(app, guide())
        expect(page.metadata).toMatchObject({ source: 'shell', fallbackReason: 'timeout' })
        // An ambiguous dispatch is never repaired or retried.
        expect(mock.screenDispatches()).toBe(1)
    })

    it('cancels in-flight generation for an older revision when a newer one arrives', async (): Promise<void> => {
        const { app } = await boot({}, { screen: { scenario: 'valid', delayMs: 400 } })
        const older = document(app, guide('step-1', 1))
        await new Promise((resolve) => setTimeout(resolve, 80))
        await document(app, {
            ...base,
            kind: 'home',
            binding: { ...binding, revision: 2 },
            session: { ...session, revision: 2 },
        })
        expect((await older).metadata).toMatchObject({ source: 'shell', fallbackReason: 'stale' })
    })

    it('fails fast with the shell when too many provider calls are in flight', async (): Promise<void> => {
        const { app, mock } = await boot(
            { MODEL_MAX_CONCURRENCY: '1' },
            { screen: { scenario: 'valid', delayMs: 300 } },
        )
        const [first, second] = await Promise.all([document(app, base), document(app, { ...base, kind: 'add' })])
        expect([first.metadata.source, second.metadata.source].sort()).toEqual(['generated', 'shell'])
        const busy = first.metadata.source === 'shell' ? first : second
        expect(busy.metadata.fallbackReason).toBe('busy')
        expect(mock.screenDispatches()).toBe(1)
    })
})

describe('cache, single flight and identity', (): void => {
    const result = (decision: 'cannot_verify' | 'refuse'): unknown => ({
        kind: 'check',
        value: {
            decision,
            reason: decision === 'refuse' ? 'The groove faces the wrong way.' : 'Cannot tell yet.',
            sourceRefs: decision === 'refuse' ? [{ pageId: 'demo-page-1', region: null }] : [],
            observedRegion: decision === 'refuse' ? { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } : null,
            missingEvidence: decision === 'refuse' ? [] : ['A clearer view'],
        },
    })
    const resultScreen = (captureId: string, decision: 'cannot_verify' | 'refuse' = 'cannot_verify'): Metadata => ({
        ...guide(),
        kind: 'result',
        captureId,
        result: result(decision),
    })

    it('serves an identical screen from cache with no provider call and says so', async (): Promise<void> => {
        const { app, mock } = await boot()
        const first = await document(app, guide())
        const second = await document(app, guide())
        expect(mock.screenDispatches()).toBe(1)
        expect(second.metadata.cacheHit).toBe(true)
        expect(first.metadata.cacheHit).toBe(false)
        expect(second.screenId).toBe(first.screenId)
    })

    it('never reuses a result screen across captures, results, steps or revisions', async (): Promise<void> => {
        const { app, mock } = await boot()
        const a = await document(app, resultScreen('capture-a'))
        await document(app, resultScreen('capture-a'))
        expect(mock.screenDispatches()).toBe(1)
        const b = await document(app, resultScreen('capture-b'))
        expect(b.bound.captureId).toBe('capture-b')
        expect(b.bound.contextKey).not.toBe(a.bound.contextKey)
        await document(app, resultScreen('capture-a', 'refuse'))
        await document(app, { ...guide('step-2'), kind: 'guide' })
        expect(mock.screenDispatches()).toBe(4)
    })

    it('shares one provider call between concurrent identical requests', async (): Promise<void> => {
        const { app, mock } = await boot({}, { screen: { scenario: 'valid', delayMs: 150 } })
        const documents = await Promise.all([document(app, guide()), document(app, guide()), document(app, guide())])
        expect(mock.screenDispatches()).toBe(1)
        expect(new Set(documents.map((doc) => doc.screenId)).size).toBe(1)
    })

    it('does not cache a transient fallback, so the next request tries again', async (): Promise<void> => {
        const { app, mock } = await boot({}, { screen: { scenario: 'incomplete' } })
        await document(app, guide())
        await document(app, guide())
        expect(mock.screenDispatches()).toBe(2)
    })

    it('treats a request for an older revision of a manual as stale', async (): Promise<void> => {
        const { app, mock } = await boot()
        await document(app, guide('step-1', 2))
        const stale = await document(app, guide('step-1', 1))
        expect(stale.metadata).toMatchObject({ source: 'shell', fallbackReason: 'stale' })
        expect(mock.screenDispatches()).toBe(1)
    })
})

describe('per-step precompute with progress', (): void => {
    const read = async (app: ReturnType<typeof createApp>, want: string[] = []): Promise<OkValue> => {
        const response = await post(app, { ...base, op: 'progress', kind: null, binding, want })
        const parsed = screensResultSchema.parse(await response.json())
        if (parsed.status !== 'ok') throw new Error('unavailable')
        return parsed.value
    }

    it('generates every step in the background and lets progress read it without a new provider call', async (): Promise<void> => {
        const { app, mock } = await boot({}, { screen: { scenario: 'valid', delayMs: 10 } })
        const steps = session.reviewedSteps.map((step) => step.stepId)
        const started = await post(app, {
            ...base,
            op: 'precompute',
            kind: null,
            binding,
            session,
            focusStepId: steps[steps.length - 1]!,
        })
        const first = screensResultSchema.parse(await started.json())
        expect(first.status === 'ok' && first.value.progress?.steps.map((step) => step.stepId)).toEqual(steps)
        for (let attempt = 0; attempt < 100; attempt++) {
            const value = await read(app)
            if (value.progress?.steps.every((step) => step.state === 'ready')) break
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const done = await read(app, steps.slice(0, 2))
        expect(done.progress?.steps.every((step) => step.state === 'ready')).toBe(true)
        expect(done.documents.map((doc) => doc.bound.stepId)).toEqual(steps.slice(0, 2))
        expect(mock.screenDispatches()).toBe(steps.length)
        // The focused step was generated first.
        const callOrder = mock.wireRequests.map((request) => JSON.stringify(request.input))
        expect(callOrder[0]).toContain(JSON.stringify(session.reviewedSteps.at(-1)!.title).slice(1, -1))
        // Reading again, or asking for a step already built, never reaches the provider.
        await read(app, steps)
        expect((await document(app, guide(steps[0]!))).metadata.cacheHit).toBe(true)
        expect(mock.screenDispatches()).toBe(steps.length)
    })

    it('cancels the older revision when a newer precompute starts and reports unknown jobs as absent', async (): Promise<void> => {
        const { app } = await boot({}, { screen: { scenario: 'valid', delayMs: 200 } })
        expect((await read(app)).progress).toBeNull()
        await post(app, { ...base, op: 'precompute', kind: null, binding, session })
        await post(app, {
            ...base,
            op: 'precompute',
            kind: null,
            binding: { ...binding, revision: 2 },
            session: { ...session, revision: 2 },
        })
        expect((await read(app)).progress).toBeNull()
        const cancelled = await post(app, { ...base, op: 'cancel', kind: null, binding: { ...binding, revision: 2 } })
        const value = screensResultSchema.parse(await cancelled.json())
        expect(value.status === 'ok' && value.value.progress?.steps.every((step) => step.state === 'cancelled')).toBe(
            true,
        )
    })

    it('does not precompute at all when GENERATIVE_UI is off', async (): Promise<void> => {
        const { app, mock } = await boot({ GENERATIVE_UI: 'off' })
        const started = await post(app, { ...base, op: 'precompute', kind: null, binding, session })
        const value = screensResultSchema.parse(await started.json())
        expect(value.status === 'ok' && value.value.progress).toMatchObject({ mode: 'off', steps: [] })
        expect(mock.screenDispatches()).toBe(0)
    })
})

describe('what the provider is shown and what the document says about itself', (): void => {
    type Shown = {
        stable: { manual: { pages: Record<string, unknown>[]; parts: { partId: string }[] } }
        dynamic: { screen: { sources: unknown; figures: unknown; facts: unknown } }
    }
    const shown = (mock: Awaited<ReturnType<typeof startMetaMock>>, index = 0): Shown => {
        const content = mock.wireRequests[index]!.input[0].content
        return {
            stable: JSON.parse((content[0] as { text: string }).text).manualContext,
            dynamic: JSON.parse((content[1] as { text: string }).text),
        }
    }

    it('supplies the real page, source, figure and fact identities with their own sources, and nothing invented', async (): Promise<void> => {
        const { app, mock } = await boot()
        await document(app, guide())
        const { stable, dynamic } = shown(mock)
        expect(dynamic.screen.sources).toEqual([{ index: 0, pageId: 'demo-page-1', region: null }])
        expect(dynamic.screen.figures).toMatchObject({ pageIds: ['demo-page-1'], partIds: ['side-panel'] })
        expect(dynamic.screen.facts).toContainEqual(
            expect.objectContaining({ id: 'title', text: 'Stand the side panel upright', sources: [0] }),
        )
        // Page identity and the whole part registry are part of the supplied (and therefore hashed) context.
        expect(stable.manual.pages[0]).toMatchObject({ pageId: 'demo-page-1', contentHash: expect.any(String) })
        expect(stable.manual.parts.map((part: { partId: string }) => part.partId)).toEqual(['side-panel', 'divider'])
    })

    it('names the origin of every component and only counts what the model composed and the server kept', async (): Promise<void> => {
        const { app } = await boot()
        const page = await document(app, guide())
        expect(page.metadata.origins).toEqual(
            Object.fromEntries(screenComponentPaths(page).map((path) => [path, 'generated'])),
        )
        expect(page.metadata.grounding).toEqual({
            droppedBlocks: 0,
            droppedItems: 0,
            replacedComponents: 0,
            forcedRequired: 0,
        })
        // The actual result is written by the server: the simulated model never wrote this banner.
        const refused = await document(app, {
            ...guide(),
            kind: 'result',
            captureId: 'cap',
            result: {
                kind: 'check',
                value: {
                    decision: 'refuse',
                    reason: 'The groove faces the wrong way.',
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                    observedRegion: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
                    missingEvidence: [],
                },
            },
        })
        expect(refused.body[0]).toMatchObject({ type: 'ResultBanner', text: 'The groove faces the wrong way.' })
        expect(refused.metadata.origins!['body.0']).toBe('fallback')
        expect(refused.metadata.source).toBe('generated')
        expect(refused.metadata.grounding?.forcedRequired).toBe(1)
    })
})

describe('semantic rejection takes the single repair, then falls back', (): void => {
    it('repairs unsupported content once with machine issue codes only, then publishes the generated screen', async (): Promise<void> => {
        const { app, mock } = await boot({}, { screen: { scenario: 'unsupported-then-valid' } })
        const page = await document(app, guide())
        expect(page.metadata).toMatchObject({ source: 'generated', repaired: true, fallbackReason: null })
        expect(mock.screenDispatches()).toBe(2)
        const instructions = mock.wireRequests[1]!.instructions!
        expect(instructions).toContain('grounding:no_supported_block')
        expect(instructions).not.toContain('Insert 99')
    })

    it('reports an unknown total when any attempt did not report usage, never a partial sum', async (): Promise<void> => {
        const { app } = await boot({}, { screen: { scenario: 'no-usage' } })
        const page = await document(app, guide())
        expect(page.metadata.repaired).toBe(true)
        // The repair reported 400/90 tokens; the first attempt reported nothing, so no total is claimed.
        expect(page.metadata.usage).toEqual({
            inputTokens: null,
            cachedTokens: null,
            outputTokens: null,
            reasoningTokens: null,
        })
        expect(page.metadata.timing.providerMs).toEqual(expect.any(Number))
    })
})

describe('capacity, queueing and stale work', (): void => {
    it('shares a flight without a provider slot per waiter, even when only one slot exists', async (): Promise<void> => {
        const { app, mock } = await boot(
            { MODEL_MAX_CONCURRENCY: '1' },
            { screen: { scenario: 'valid', delayMs: 150 } },
        )
        const documents = await Promise.all([document(app, guide()), document(app, guide()), document(app, guide())])
        expect(documents.map((doc) => doc.metadata.source)).toEqual(['generated', 'generated', 'generated'])
        expect(mock.screenDispatches()).toBe(1)
    })

    it('cancels queued old-revision work when a newer revision is observed before it gets a slot', async (): Promise<void> => {
        // Two slots, one reserved for foreground: background work gets one, so the second step queues behind it.
        const { app, mock } = await boot(
            { MODEL_MAX_CONCURRENCY: '2' },
            { screen: { scenario: 'valid', delayMs: 500 } },
        )
        await post(app, { ...base, op: 'precompute', kind: null, binding, session })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(mock.screenDispatches()).toBe(1)
        // A newer revision is observed while the second step is still waiting for capacity.
        await document(app, {
            ...base,
            kind: 'home',
            binding: { ...binding, revision: 2 },
            session: { ...session, revision: 2 },
        })
        let states: string[] = []
        for (let attempt = 0; attempt < 60; attempt++) {
            const response = await post(app, { ...base, op: 'progress', kind: null, binding, want: [] })
            const parsed = screensResultSchema.parse(await response.json())
            states = parsed.status === 'ok' ? (parsed.value.progress?.steps.map((step) => step.state) ?? []) : []
            if (states.length > 0 && states.every((state) => state !== 'running' && state !== 'queued')) break
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(states).toHaveLength(2)
        // The waiting step was never dispatched: only the running old step and the new revision's Home reached the provider.
        expect(mock.screenDispatches()).toBe(2)
    })
})

describe('preparing step screens from a fresh parse', (): void => {
    const unreviewed = (): typeof session => {
        const value = structuredClone(session)
        for (const step of value.reviewedSteps) step.correction = null
        return {
            ...value,
            reviewStatus: 'unreviewed',
            rawExtraction: { parts: value.parts, steps: value.reviewedSteps, unknowns: [] },
            reviewedSteps: [],
            parts: [],
        }
    }

    it('generates from known raw facts without offering a build action, then serves the reviewed screen from it', async (): Promise<void> => {
        const { app, mock } = await boot({}, { screen: { scenario: 'valid', delayMs: 10 } })
        const read = unreviewed()
        const started = await post(app, { ...base, op: 'precompute', kind: null, binding, session: read })
        expect(started.status).toBe(200)
        let ready: OkValue | undefined
        for (let attempt = 0; attempt < 100; attempt++) {
            const response = await post(app, { ...base, op: 'progress', kind: null, binding, want: ['step-1'] })
            const parsed = screensResultSchema.parse(await response.json())
            if (parsed.status === 'ok' && parsed.value.progress?.steps.every((step) => step.state === 'ready')) {
                ready = parsed.value
                break
            }
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(ready?.documents[0]?.bar.primary.intent).toEqual({ intent: 'navigate', target: 'quick-check' })
        expect(mock.screenDispatches()).toBe(2)
        // After the person confirms what was read, the same facts need no new model call and get their real actions.
        const reviewed = structuredClone(session)
        for (const step of reviewed.reviewedSteps) step.correction = null
        const page = await document(app, {
            ...guide(),
            session: { ...reviewed, revision: 2 },
            binding: { ...binding, revision: 2 },
        })
        expect(page.metadata).toMatchObject({ source: 'generated', cacheHit: true })
        expect(page.bar.primary.intent).toEqual({ intent: 'capture', target: 'take-photo' })
        expect(mock.screenDispatches()).toBe(2)
    })
})

describe('mandatory manual facts survive any composition or document failure', (): void => {
    const NOTE = 'Keep children away from the moving mechanism.'
    const here = [{ pageId: 'demo-page-1', region: null }]
    const withNotes = (notes: string[]): typeof session => {
        const value = structuredClone(session)
        value.pages.push({ ...value.pages[0]!, pageId: 'demo-page-2', assetId: 'demo-asset-2' })
        value.reviewedSteps[0]!.safetyNotes = notes.map((text, index) => ({
            noteId: `n${index}`,
            note: {
                state: 'known' as const,
                value: text,
                sourceRefs: [{ pageId: index % 2 === 0 ? 'demo-page-1' : 'demo-page-2', region: null }],
            },
        }))
        return value
    }
    const request = (manual: typeof session): Metadata => ({
        ...guide(),
        binding: { ...binding, revision: manual.revision },
        session: manual,
    })
    const twentyFive = Array.from({ length: 25 }, (_unused, index) => `Warning ${index}: do not skip step ${index}.`)

    it('publishes all 25 relevant warnings with their own sources, and never turns them into a shell', async (): Promise<void> => {
        const { app } = await boot()
        const page = await document(app, request(withNotes(twentyFive)))
        expect(page.metadata.source).toBe('generated')
        expect(page.body.length).toBeLessThanOrEqual(14)
        const facts = page.manualFacts!.filter((fact) => fact.kind === 'safety')
        expect(facts.map((fact) => fact.text)).toEqual(twentyFive)
        expect(facts.map((fact) => fact.sourceRefs[0]!.pageId)).toEqual(
            twentyFive.map((_text, index) => (index % 2 === 0 ? 'demo-page-1' : 'demo-page-2')),
        )
        expect(screenComponentPaths(page)).toEqual(Object.keys(page.metadata.origins!))
    })

    it('keeps every note when the model output is invalid or unsupported, in the shell', async (): Promise<void> => {
        for (const scenario of ['invalid', 'unsupported-fact', 'not-json'] as const) {
            const { app } = await boot({}, { screen: { scenario } })
            const page = await document(app, request(withNotes(twentyFive)))
            expect(page.metadata.source, scenario).toBe('shell')
            expect(page.metadata.fallbackReason, scenario).not.toBe('unsupported_content_overflow')
            expect(
                page.manualFacts!.filter((fact) => fact.kind === 'safety').map((fact) => fact.text),
                scenario,
            ).toEqual(twentyFive)
        }
    })

    it('keeps them in a shell too: with the feature off the body is empty and the mandatory facts are not', async (): Promise<void> => {
        const { app, mock } = await boot({ GENERATIVE_UI: 'off' })
        const page = await document(app, request(withNotes(twentyFive)))
        expect(page.metadata).toMatchObject({ source: 'shell', fallbackReason: 'disabled' })
        expect(page.body).toEqual([])
        // The mandatory facts only: a classified step requires its typed notes; its other directions are optional.
        expect(page.manualFacts).toHaveLength(25)
        expect(page.manualFacts!.every((fact) => fact.placement === 'remainder')).toBe(true)
        expect(mock.screenDispatches()).toBe(0)
    })

    it('keeps a hazard worded as a plain instruction that no keyword list would classify, on an unclassified step', async (): Promise<void> => {
        const manual = structuredClone(session)
        manual.reviewedSteps[0]!.visibleChecks.push({
            checkId: 'kids',
            description: { state: 'known', value: NOTE, sourceRefs: here },
        })
        for (const scenario of ['valid', 'unsupported-fact'] as const) {
            const { app } = await boot({}, { screen: { scenario } })
            const page = await document(app, request(manual))
            expect(
                page.manualFacts?.find((fact) => fact.factId === 'check:kids'),
                scenario,
            ).toMatchObject({
                text: NOTE,
                basis: 'unclassified-step',
                sourceRefs: here,
            })
        }
    })

    it('publishes the facts the model did not name in the mandatory section, as fallback, and counts them', async (): Promise<void> => {
        const { app } = await boot({}, { screen: { scenario: 'no-directions' } })
        const page = await document(app, request(withNotes(['Wear gloves.', NOTE])))
        expect(page.metadata.source).toBe('generated')
        expect(page.body.some((node) => node.type === 'ManualDirections')).toBe(false)
        expect(
            page.manualFacts!.filter((fact) => fact.kind === 'safety').map((fact) => [fact.text, fact.placement]),
        ).toEqual([
            ['Wear gloves.', 'remainder'],
            [NOTE, 'remainder'],
        ])
        expect(page.metadata.forcedSafety).toBe(2)
        expect(page.manualFacts!.every((fact, index) => page.metadata.origins![`facts.${index}`] === 'fallback')).toBe(
            true,
        )
        // Named by the simulated model instead, the same facts are placed in the body and are its generated content.
        const { app: naming } = await boot()
        const named = await document(naming, request(withNotes(['Wear gloves.', NOTE])))
        expect(named.manualFacts!.filter((fact) => fact.kind === 'safety').map((fact) => fact.placement)).toEqual([
            'body',
            'body',
        ])
        expect(named.metadata.forcedSafety).toBe(0)
    })

    it('never shows an unreadable safety note as a fact, and refuses it as reviewed input', async (): Promise<void> => {
        const { app } = await boot()
        const reviewed = structuredClone(session)
        reviewed.reviewedSteps[0]!.safetyNotes = [{ noteId: 'u', note: { state: 'unknown', reason: 'Cut off.' } }]
        expect((await post(app, request(reviewed))).status).toBe(400)
        const raw = {
            ...structuredClone(session),
            reviewStatus: 'unreviewed',
            reviewedSteps: [],
            rawExtraction: {
                parts: session.parts,
                steps: [
                    {
                        ...structuredClone(session.reviewedSteps[0]!),
                        correction: null,
                        safetyNotes: [{ noteId: 'u', note: { state: 'unknown', reason: 'Cut off.' } }],
                    },
                ],
                unknowns: [],
            },
        }
        // An unreviewed read is only ever prepared in the background; the unreadable note is never among its facts.
        expect((await post(app, { ...base, op: 'precompute', kind: null, binding, session: raw })).status).toBe(200)
        let prepared: ScreenDocument | undefined
        for (let attempt = 0; attempt < 100 && prepared === undefined; attempt++) {
            const response = await post(app, { ...base, op: 'progress', kind: null, binding, want: ['step-1'] })
            const parsed = screensResultSchema.parse(await response.json())
            prepared = parsed.status === 'ok' ? parsed.value.documents[0] : undefined
            if (prepared === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(prepared).toBeDefined()
        expect(JSON.stringify(prepared)).not.toContain('Cut off.')
        expect(prepared!.manualFacts?.some((fact) => fact.kind === 'safety')).toBeFalsy()
    })
})

describe('shared context identity and live app state', (): void => {
    const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

    it('binds a document to the SHA-256 of the exact shared canonical JSON the app can compute', async (): Promise<void> => {
        const { app } = await boot()
        const capture = { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false }
        const request = { ...guide(), kind: 'questions', uiState: { capture } }
        const page = await document(app, request)
        const inputs = {
            kind: 'questions' as const,
            session,
            stepId: 'step-1',
            captureId: null,
            result: null,
            failure: null,
            uiState: { capture },
        }
        expect(page.bound.contextKey).toBe(sha(screenContextJson(inputs)))
        const withoutCapture = await document(app, { ...guide(), kind: 'questions' })
        expect(withoutCapture.bound.contextKey).not.toBe(page.bound.contextKey)
        // The guide is prepared before a photo and is not regenerated for one.
        const guided = await document(app, { ...guide(), uiState: { capture } })
        expect(guided.bound.contextKey).toBe(sha(screenContextJson({ ...inputs, kind: 'guide' })))
        expect(guided.bound.contextKey).toBe((await document(app, guide())).bound.contextKey)
    })

    it('rejects raw drafts and transport tickets in the live state', async (): Promise<void> => {
        const { app } = await boot()
        const capture = { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false }
        for (const extra of [{ draft: 'my question' }, { ticket: 'abc' }]) {
            expect(
                (await post(app, { ...guide(), kind: 'questions', uiState: { capture: { ...capture, ...extra } } }))
                    .status,
            ).toBe(400)
        }
    })

    it('shows the provider the live state of the kind and the complete manual facts by id', async (): Promise<void> => {
        const { app, mock } = await boot()
        await document(app, {
            ...base,
            kind: 'home',
            uiState: {
                library: {
                    entries: [
                        {
                            manualId: 'm1',
                            title: 'Shelf',
                            updatedAt: '2026-01-01T00:00:00.000Z',
                            stopStepId: null,
                            completed: 0,
                            total: 2,
                            firstPageId: null,
                        },
                    ],
                    soleManualId: 'm1',
                },
                capture: { captureId: 'not-for-home', reusable: true, target: null, questionDraftPresent: true },
            },
        })
        const dynamic = JSON.parse((mock.wireRequests.at(-1)!.input[0].content[1] as { text: string }).text).screen
        expect(dynamic.ui).toEqual({
            library: {
                soleManualId: 'm1',
                entries: [
                    { manualId: 'm1', title: 'Shelf', stopStepId: null, completed: 0, total: 2, firstPageId: null },
                ],
            },
        })
        await document(app, guide())
        const guideView = JSON.parse((mock.wireRequests.at(-1)!.input[0].content[1] as { text: string }).text).screen
        expect(guideView.manualFacts.map((fact: { id: string }) => fact.id)).toEqual([
            'title',
            'orientation',
            'connection',
            'check:groove-inward',
            'correction:turn-panel',
        ])
        expect(guideView.manualFacts.find((fact: { id: string }) => fact.id === 'orientation')).toMatchObject({
            basis: 'unclassified-step',
            text: 'Groove faces inward toward the divider.',
        })
    })
})

describe('completion wording', (): void => {
    it('states the build is finished only with a witness covering every reviewed step', async (): Promise<void> => {
        const { app } = await boot({ GENERATIVE_UI: 'full' }, { screen: { scenario: 'valid' } })
        const completion = { ...base, kind: 'completion', binding, session }
        const untouched = await document(app, completion)
        expect(untouched.header.title).toBe('Your build')
        expect(JSON.stringify(untouched.body)).not.toMatch(/finished/iu)
        const partial = await document(app, { ...completion, completedStepIds: ['step-1'] })
        expect(partial.header.title).toBe('Your build')
        const done = await document(app, {
            ...completion,
            completedStepIds: session.reviewedSteps.map((step) => step.stepId),
        })
        expect(done.header.title).toBe('All steps done')
        // The shell states the finished build in its header only when the witness covers every step; it has no body.
        expect(done.body).toEqual([])
        expect(new Set([untouched, partial, done].map((doc) => doc.bound.contextKey)).size).toBe(2)
    })
})

describe('the fixture runtime composes every screen kind for two different manuals', (): void => {
    const arm = stepFixtures()[1]!.session
    const fixtureApp = (): ReturnType<typeof createApp> =>
        createApp({
            runtime: createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: KEY }),
            onDuration: () => {},
        })
    const metadataFor = (kind: ScreenKind, manual: typeof session, stepId: string): Metadata => {
        const binding = { kind: 'manual', manualId: manual.manualId, revision: manual.revision }
        const stepKinds = ['guide', 'result', 'questions', 'answer', 'recovery']
        const sessionKinds = ['home', 'add', 'pages', 'more', 'error']
        const check = {
            decision: 'refuse',
            reason: 'The part faces the wrong way.',
            sourceRefs: [{ pageId: manual.pages[0]!.pageId, region: null }],
            observedRegion: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
            missingEvidence: [],
        }
        return {
            ...base,
            kind,
            binding: sessionKinds.includes(kind) ? null : binding,
            session: sessionKinds.includes(kind) ? null : manual,
            stepId: stepKinds.includes(kind) ? stepId : null,
            captureId: kind === 'result' || kind === 'answer' ? 'capture-1' : null,
            result:
                kind === 'result'
                    ? { kind: 'check', value: check }
                    : kind === 'answer'
                      ? {
                            kind: 'question',
                            question: 'Which way?',
                            value: { answer: 'Follow the diagram.', sourceRefs: check.sourceRefs, missingEvidence: [] },
                        }
                      : null,
            failure: kind === 'error' ? 'timeout' : null,
            completedStepIds: kind === 'completion' ? manual.reviewedSteps.map((step) => step.stepId) : undefined,
        }
    }

    it.each([
        ['divider shelf', createDemoManual(), 'step-1'],
        ['treadmill monitor arm', arm, 'arm-step-2'],
    ])(
        'publishes an honest synthetic example of every kind for the %s',
        async (_name, manual, stepId): Promise<void> => {
            const app = fixtureApp()
            for (const kind of SCREEN_KINDS) {
                const page = await document(app, metadataFor(kind, manual, stepId))
                const label = `${kind}/${manual.manualId}`
                // The monitor arm's question screen is the forced-invalid example: repaired once, then the shell.
                const forced = kind === 'questions' && manual.manualId === 'treadmill-monitor-arm'
                expect(page.metadata.evidence, label).toBe('synthetic-fixture')
                expect(page.metadata.source, label).toBe(forced ? 'shell' : 'generated')
                expect(page.metadata.fallbackReason, label).toBe(forced ? 'repair_failed' : null)
                // Nothing is observed, so nothing is claimed.
                expect(page.metadata.model, label).toBeNull()
                expect(page.metadata.effort, label).toBeNull()
                expect(
                    Object.values(page.metadata.timing).every((value) => value === null),
                    label,
                ).toBe(true)
                expect(
                    Object.values(page.metadata.usage).every((value) => value === null),
                    label,
                ).toBe(true)
                expect(page.metadata.repaired, label).toBe(forced)
                if (!forced) {
                    expect(page.metadata.droppedFacts, label).toBe(0)
                    expect(Object.values(page.metadata.origins ?? {}), label).toContain('generated')
                }
                expect(Object.keys(page.metadata.origins ?? {}), label).toEqual(screenComponentPaths(page))
            }
        },
    )

    it('shows the same catalog composed differently for the two manuals', async (): Promise<void> => {
        const app = fixtureApp()
        const first = await document(app, metadataFor('guide', createDemoManual(), 'step-1'))
        const second = await document(app, metadataFor('guide', arm, 'arm-step-2'))
        expect(first.body[0]!.type).toBe('StepProgress')
        expect(second.body[0]!.type).toBe('Instruction')
        expect(first.bar.primary.intent).toEqual({ intent: 'capture', target: 'take-photo' })
        expect(second.bar.primary.intent).toEqual({ intent: 'check', target: 'current-step' })
    })

    it('reports partial progress while later steps are still being composed, then every step', async (): Promise<void> => {
        const app = fixtureApp()
        const manual = createDemoManual()
        await post(app, { ...base, op: 'precompute', kind: null, binding, session: manual })
        const states = async (): Promise<string[]> => {
            const response = await post(app, { ...base, op: 'progress', kind: null, binding, want: [] })
            const parsed = screensResultSchema.parse(await response.json())
            return parsed.status === 'ok' ? (parsed.value.progress?.steps.map((step) => step.state) ?? []) : []
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
        const early = await states()
        expect(early[0]).toBe('ready')
        expect(early[1]).not.toBe('ready')
        let late = early
        for (let attempt = 0; attempt < 40 && !late.every((state) => state === 'ready'); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            late = await states()
        }
        expect(late).toEqual(['ready', 'ready'])
    })

    const uiState = {
        library: {
            entries: [
                {
                    manualId: 'demo-divider',
                    title: 'Divider',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    stopStepId: 'step-2',
                    completed: 1,
                    total: 2,
                    firstPageId: 'demo-page-1',
                },
                {
                    manualId: 'treadmill-monitor-arm',
                    title: 'Arm',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                    stopStepId: null,
                    completed: 0,
                    total: 2,
                    firstPageId: null,
                },
            ],
            soleManualId: null,
        },
        pages: {
            items: [{ pageId: 'demo-page-1', width: 1200, height: 900 }],
            maxPages: 8,
            canRead: true,
            languageOptions: ['en'],
        },
        review: {
            currentQuestion: {
                questionId: 'step-1:orientation',
                kind: 'orientation',
                stepId: 'step-1',
                stepOrder: 1,
                reason: 'The page does not show the groove.',
                parts: [{ partId: 'side-panel', label: 'Side panel' }],
            },
            blockers: 0,
            canConfirm: false,
        },
        capture: { captureId: 'capture-1', reusable: true, target: null, questionDraftPresent: false },
        sections: ['settings', 'about-this-check', 'tips'],
    }
    const types = (page: ScreenDocument): string[] =>
        page.body.flatMap((node) => [
            node.type,
            ...('children' in node ? node.children.map((child) => child.type) : []),
        ])

    it('exercises every full-screen block through the same grounding path, with live state bound by reference', async (): Promise<void> => {
        const app = fixtureApp()
        const seen = new Set<string>()
        for (const manual of [createDemoManual(), arm]) {
            const stepId = manual.manualId === 'treadmill-monitor-arm' ? 'arm-step-2' : 'step-1'
            for (const kind of SCREEN_KINDS) {
                const page = await document(app, { ...metadataFor(kind, manual, stepId), uiState })
                if (page.metadata.source !== 'generated') continue
                // Whatever the fixture composed was accepted unchanged: nothing dropped, nothing replaced.
                expect(page.metadata.droppedFacts, `${kind}/${manual.manualId}`).toBe(0)
                expect(page.metadata.grounding?.replacedComponents, `${kind}/${manual.manualId}`).toBe(0)
                for (const type of types(page)) seen.add(type)
            }
        }
        for (const type of [
            'ManualLibrary',
            'PageGallery',
            'FactPrompt',
            'FactEditor',
            'QuestionComposer',
            'SourceDetails',
            'ActionLink',
            'CameraGuidance',
            'ManualDirections',
        ]) {
            expect([...seen], type).toContain(type)
        }
    })

    it('composes the divider shelf and the monitor arm with different blocks and different library layouts', async (): Promise<void> => {
        const app = fixtureApp()
        // Home may carry the manual the person is building: that is what tells the two compositions apart.
        const home = (manual: typeof session): Promise<ScreenDocument> =>
            document(app, {
                ...metadataFor('home', manual, ''),
                binding: { kind: 'manual', manualId: manual.manualId, revision: manual.revision },
                session: manual,
                uiState,
            })
        const first = await home(createDemoManual())
        const second = await home(arm)
        expect(types(first)).toEqual(expect.arrayContaining(['ManualLibrary']))
        const library = (page: ScreenDocument): Record<string, unknown> =>
            page.body.find((node) => node.type === 'ManualLibrary') as never
        expect(library(first)).toMatchObject({ entries: 'recent', layout: 'cards', showProgress: true })
        expect(library(second)).toMatchObject({
            entries: { manualIds: ['demo-divider', 'treadmill-monitor-arm'] },
            layout: 'rows',
            showProgress: false,
        })
        expect(types(await document(app, { ...metadataFor('guide', createDemoManual(), 'step-1') }))).not.toEqual(
            types(await document(app, { ...metadataFor('guide', arm, 'arm-step-2') })),
        )
    })

    it('publishes the complete directions of each manual and shows them where the composition named them', async (): Promise<void> => {
        const app = fixtureApp()
        const demo = await document(app, metadataFor('guide', createDemoManual(), 'step-1'))
        expect(demo.manualFacts?.map((fact) => fact.factId)).toEqual([
            'title',
            'orientation',
            'connection',
            'check:groove-inward',
            'correction:turn-panel',
        ])
        expect(demo.manualFacts?.every((fact) => fact.placement === 'body' && fact.basis === 'unclassified-step')).toBe(
            true,
        )
        expect(demo.metadata.origins?.['facts.0']).toBe('generated')
        const other = await document(app, metadataFor('guide', arm, 'arm-step-2'))
        expect(other.manualFacts?.length).toBeGreaterThan(0)
        expect(other.manualFacts?.map((fact) => fact.text)).not.toEqual(demo.manualFacts?.map((fact) => fact.text))
        expect(other.body.find((node) => node.type === 'ManualDirections')).toBeDefined()
    })

    it('follows a verdict from uncertain, through a second pass to a pass, and onto its overlay regions', async (): Promise<void> => {
        const app = fixtureApp()
        const withResult = (
            decision: 'cannot_verify' | 'pass' | 'refuse',
            extra: Record<string, unknown> = {},
        ): Metadata => ({
            ...metadataFor('result', createDemoManual(), 'step-1'),
            result: {
                kind: 'check',
                value: {
                    decision,
                    reason: decision === 'pass' ? 'The groove faces inward.' : 'The view is too dark to tell.',
                    sourceRefs: decision === 'cannot_verify' ? [] : [{ pageId: 'demo-page-1', region: null }],
                    observedRegion: null,
                    missingEvidence:
                        decision === 'pass' ? [] : decision === 'cannot_verify' ? ['A brighter photo'] : [],
                    ...extra,
                },
            },
            ...(decision === 'refuse' ? {} : {}),
        })
        const uncertain = await document(app, withResult('cannot_verify'))
        const second = await document(app, withResult('pass'))
        expect(uncertain.bar.primary.intent).toEqual({ intent: 'capture', target: 'retake' })
        expect(second.bar.primary.intent).toEqual({ intent: 'confirm', target: 'step' })
        expect(second.bound.contextKey).not.toBe(uncertain.bound.contextKey)
        // The uncertain verdict never offers to advance, and its words are the actual result, not the composer's.
        expect(JSON.stringify(uncertain.body)).toContain('The view is too dark to tell.')
        // A verdict published without geometry has no photo block; the overlay's regions add one with the part regions.
        const plain = await document(app, withResult('refuse', { observedRegion: null }))
        expect(types(plain)).not.toContain('PhotoWithRegions')
        const overlaid = await document(
            app,
            withResult('refuse', {
                observedRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
                nextPartRegion: { partId: 'side-panel', region: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } },
            }),
        )
        expect(overlaid.body.find((node) => node.type === 'PhotoWithRegions')).toMatchObject({
            observed: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
            regions: [{ partId: 'side-panel', role: 'next' }],
        })
        expect(overlaid.bound.contextKey).not.toBe(plain.bound.contextKey)
    })

    it('composes the answer to a slow question from the collected answer, with its sources', async (): Promise<void> => {
        const app = fixtureApp()
        const answered = await document(app, metadataFor('answer', createDemoManual(), 'step-1'))
        expect(answered.body[0]).toMatchObject({ type: 'AnswerCard', text: 'Follow the diagram.' })
        expect(types(answered)).toContain('SourceDetails')
        expect(answered.metadata).toMatchObject({ evidence: 'synthetic-fixture', model: null })
    })

    it('labels a flaky or failed fixture honestly and cannot be turned into a live claim', async (): Promise<void> => {
        const app = createApp({
            runtime: createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: KEY }, undefined, {
                screenFixtures: async () => ({ header: { type: 'ScreenHeader', title: '' } }),
            }),
            onDuration: () => {},
        })
        const page = await document(app, guide())
        expect(page.metadata).toMatchObject({
            source: 'shell',
            evidence: 'synthetic-fixture',
            fallbackReason: 'repair_failed',
        })
    })
})
