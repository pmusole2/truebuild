import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHeroManual, createHeroResponse, HERO_DIAGRAM_PNG_BASE64 } from '@truebuild/contracts/hero'
import {
    loadAuthorization,
    manifestSchema,
    main,
    runGate,
    scoreExtraction,
    reviewDisplay,
    type StepReviewer,
} from './run'

const dirs: string[] = []
async function setup(): Promise<{ cwd: string; manifest: ReturnType<typeof manifestSchema.parse> }> {
    const cwd = await mkdtemp(join(tmpdir(), 'truebuild-gate-synthetic-'))
    dirs.push(cwd)
    await writeFile(join(cwd, 'image.png'), Buffer.from(HERO_DIAGRAM_PNG_BASE64, 'base64'))
    await writeFile(join(cwd, 'clip.mp4'), 'synthetic mock transport only, not a real clip')
    const manual = createHeroManual()
    const manifest = manifestSchema.parse({
        pages: manual.pages.map((page) => ({
            path: 'image.png',
            pageId: page.pageId,
            assetId: page.assetId,
            width: page.width,
            height: page.height,
            mimeType: page.mimeType,
        })),
        expected: manual.rawExtraction,
        observation: { path: 'image.png', width: 600, height: 400, mimeType: 'image/png' },
        expectedDecision: 'refuse',
        stepId: 'step-1',
        prompt: 'side panel',
        clip: { path: 'clip.mp4', mimeType: 'video/mp4' },
    })
    return { cwd, manifest }
}
afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('future operator gates with synthetic data only', () => {
    it.each([1, 2, 3])('gate %s refuses without a local key; writes aggregate only', async (gate) => {
        const { cwd } = await setup()
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        expect(await main([String(gate), '--dispatch'], cwd)).toBe(2)
        expect(log).toHaveBeenCalledWith(expect.stringContaining('local_key_required'))
        expect(fetchMock).not.toHaveBeenCalled()
        const report = await readFile(join(cwd, 'docs/gate-results.md'), 'utf8')
        expect(report).toContain('"requests":0')
        expect(report).not.toContain('image.png')
    })
    it('requires dispatch, meta mode, key, shared secret and critical-fact confirmation', async () => {
        const { cwd } = await setup()
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        for (const [env, args, reason] of [
            ['', ['1'], 'operator_dispatch_required'],
            ['PROVIDER_MODE=fixture', ['1', '--dispatch'], 'meta_mode_required'],
            ['PROVIDER_MODE=meta', ['1', '--dispatch'], 'local_key_required'],
            ['PROVIDER_MODE=meta\nMODEL_API_KEY=<synthetic>', ['1', '--dispatch'], 'shared_secret_required'],
            [
                'PROVIDER_MODE=meta\nMODEL_API_KEY=<synthetic>\nAPI_SHARED_SECRET=synthetic',
                ['1', '--dispatch'],
                'critical_facts_confirmation_required',
            ],
        ] as const) {
            await writeFile(join(cwd, '.env'), env)
            expect(await main([...args], cwd)).toBe(2)
            expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining(reason))
        }
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it('scores missing, extra and incorrect steps honestly', async () => {
        const { manifest } = await setup()
        expect(scoreExtraction({ ...manifest.expected, steps: [] }, manifest.expected)).toMatchObject({
            structurallyMatchedSteps: 0,
            expectedSteps: 2,
            returnedSteps: 0,
        })
        const changed = structuredClone(manifest.expected)
        changed.steps[0]!.orientation = { state: 'unknown', reason: 'Not visible' }
        expect(scoreExtraction(changed, manifest.expected).structurallyMatchedSteps).toBe(1)
    })
    it('sends exactly one check from operator-reviewed truth with source hashes and no parse', async () => {
        const { cwd, manifest } = await setup()
        manifest.expected.steps[0]!.title = 'Operator reviewed wording'
        manifest.expected.steps[0]!.stepId = 'operator-step'
        manifest.stepId = 'operator-step'
        for (let i = 1; i < 3; i++)
            manifest.pages.push({ ...manifest.pages[0]!, pageId: `page-${i}`, assetId: `asset-${i}` })
        manifest.expected.steps[0]!.sourceRefs.push({ pageId: 'page-2', region: null })
        const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
            expect(String(url)).toBe('http://localhost:3001/api/checks')
            expect(init?.headers).toEqual({ 'x-truebuild-key': 'synthetic-shared' })
            expect(init?.redirect).toBe('error')
            const form = init?.body as FormData
            const metadata = JSON.parse(String(form.get('metadata')))
            expect(metadata.mode).toBe('model')
            expect(metadata.session.rawExtraction).toEqual(manifest.expected)
            expect(metadata.session.reviewStatus).toBe('reviewed')
            expect(metadata.session.reviewedSteps[0].title).toBe('Operator reviewed wording')
            expect(metadata.session.reviewedSteps[0].correction.reviewed).toBe(true)
            expect(form.has('observation')).toBe(true)
            expect(form.has('source-2')).toBe(true)
            expect(metadata.sourcePageIds).toEqual(['demo-page-1', 'page-1', 'page-2'])
            const source = new Uint8Array(await (form.get('source-0') as File).arrayBuffer())
            expect(metadata.session.pages[0].contentHash).toBe(createHash('sha256').update(source).digest('hex'))
            return Response.json(
                {
                    status: 'ok',
                    mode: 'model',
                    requestId: metadata.requestId,
                    binding: metadata.binding,
                    value: createHeroResponse('reversed'),
                },
                { headers: { 'x-truebuild-check-context': 'full', 'x-truebuild-source-pages': '3' } },
            )
        })
        const result = await runGate(3, manifest, cwd, new URL('http://localhost:3001'), 'synthetic-shared', fetchMock)
        expect(result).toMatchObject({ status: 'pass', requests: 1, fullManual: true })
        expect(result).not.toHaveProperty('structurallyMatchedSteps')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    it.each([false, true])(
        'reports selected-source scope and rejects check latency beyond 8s, slow=%s',
        async (slow) => {
            const { cwd, manifest } = await setup()
            for (let index = 1; index < 5; index++)
                manifest.pages.push({
                    ...manifest.pages[0]!,
                    pageId: `extra-page-${index}`,
                    assetId: `extra-asset-${index}`,
                })
            manifest.sourcePageIds = ['demo-page-1']
            let now = 0
            vi.spyOn(performance, 'now').mockImplementation(() => now)
            const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
                const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
                expect(String(url)).toBe('http://localhost:3001/api/checks')
                expect(metadata.session.pages).toHaveLength(5)
                expect((init?.body as FormData).has('source-1')).toBe(false)
                now += slow ? 8001 : 10
                return Response.json(
                    {
                        status: 'ok',
                        mode: 'model',
                        requestId: metadata.requestId,
                        binding: metadata.binding,
                        value: createHeroResponse('reversed'),
                    },
                    { headers: { 'x-truebuild-check-context': 'compact', 'x-truebuild-source-pages': '1' } },
                )
            })
            expect(
                await runGate(3, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock),
            ).toMatchObject({
                status: slow ? 'fail' : 'unverified',
                fullManual: false,
                sourceCount: 1,
                requests: 1,
                reason: slow ? 'decision_or_latency_failed' : 'selected_sources_only_full_manual_unverified',
            })
        },
    )

    it('rejects a stale parse response and never retries', async () => {
        const { cwd, manifest } = await setup()
        const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
            const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
            return Response.json({
                status: 'ok',
                mode: 'model',
                requestId: metadata.requestId,
                binding: { ...metadata.binding, revision: 2 },
                value: manifest.expected,
            })
        })
        expect(await runGate(1, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)).toMatchObject(
            { status: 'unverified', requests: 1 },
        )
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it.each([false, true])(
        'Gate1 labels strict structural match rather than semantic accuracy, renamed=%s',
        async (renamed) => {
            const { cwd, manifest } = await setup()
            const extracted = structuredClone(manifest.expected)
            if (renamed) extracted.steps[0]!.title = 'Stand the same side panel vertically'
            const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
                expect(String(url)).toBe('http://localhost:3001/api/manuals/parse')
                const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
                return Response.json({
                    status: 'ok',
                    mode: 'model',
                    requestId: metadata.requestId,
                    binding: metadata.binding,
                    value: extracted,
                })
            })
            const result = await runGate(1, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)
            expect(result).toMatchObject({
                status: 'unverified',
                reason: 'structural_score_only_semantic_unverified',
                semanticStepAccuracy: 'unverified',
                strictStructuralMatchPercent: renamed ? 50 : 100,
                requests: 1,
            })
            expect(result).not.toHaveProperty('stepAccuracyPercent')
        },
    )

    it.each([
        'correct',
        'incorrect',
        'unverifiable',
        'missing',
        'extra',
        'unknown-fact',
        'unknown-extraction',
    ] as const)('Gate1 human grading is independent of harmless IDs/wording: %s', async (scenario) => {
        const { cwd, manifest } = await setup()
        const extracted = structuredClone(manifest.expected)
        extracted.steps.forEach((step) => {
            step.stepId = `new-${step.stepId}`
            step.title = `Equivalent wording ${step.order}`
        })
        if (scenario === 'missing') extracted.steps.pop()
        if (scenario === 'extra') extracted.steps.push({ ...extracted.steps[0]!, stepId: 'extra', order: 3 })
        if (scenario === 'unknown-fact') extracted.steps[0]!.orientation = { state: 'unknown', reason: 'Not visible' }
        if (scenario === 'unknown-extraction') extracted.unknowns.push('Unclear diagram')
        const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
            const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
            return Response.json({
                status: 'ok',
                mode: 'model',
                requestId: metadata.requestId,
                binding: metadata.binding,
                value: extracted,
            })
        })
        const reviewer = vi.fn<StepReviewer>(async () =>
            scenario === 'incorrect' || scenario === 'unverifiable' ? scenario : 'correct',
        )
        const result = await runGate(
            1,
            manifest,
            cwd,
            new URL('http://localhost:3001'),
            'synthetic',
            fetchMock,
            reviewer,
        )
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(reviewer).toHaveBeenCalledTimes(scenario === 'missing' ? 1 : 2)
        expect(reviewer.mock.calls[0]?.[0].parsedStep.stepId).toBe('new-step-1')
        expect(result.strictStructuralMatchPercent).toBe(0)
        expect(result.humanStepAccuracyPercent).toBe(
            scenario === 'incorrect' || scenario === 'unverifiable'
                ? 0
                : scenario === 'missing' || scenario === 'unknown-fact'
                  ? 50
                  : 100,
        )
        expect(result.status).toBe(
            scenario === 'incorrect' || scenario === 'missing' || scenario === 'extra'
                ? 'fail'
                : scenario === 'unverifiable' || scenario.startsWith('unknown')
                  ? 'unverified'
                  : 'pass',
        )
        if (scenario === 'missing') expect(result).toMatchObject({ missingSteps: 1, incorrectSteps: 1 })
        if (scenario === 'extra') expect(result.extraSteps).toBe(1)
        if (scenario === 'unknown-fact') expect(result.unverifiableSteps).toBe(1)
        if (scenario === 'unknown-extraction') expect(result.extractionUnknowns).toBe(1)
    })

    it('bounds and JSON-escapes untrusted review facts including terminal and bidi controls', async () => {
        const { manifest } = await setup()
        const step = structuredClone(manifest.expected.steps[0]!)
        step.title = 'untrusted\u001b[2J\n\r\u009b\u202e'
        const input = { expectedOrder: 1, parsedStep: step, parts: manifest.expected.parts }
        const display = reviewDisplay(input)
        expect(
            [...display.text].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) < 127),
        ).toBe(true)
        expect(() => JSON.parse(display.text)).not.toThrow()
        step.visibleChecks = Array.from({ length: 100 }, (_, i) => ({
            checkId: String(i),
            description: { state: 'unknown' as const, reason: 'x'.repeat(500) },
        }))
        const bounded = reviewDisplay(input)
        expect(bounded.truncated).toBe(true)
        expect(bounded.text.length).toBeLessThanOrEqual(24_002)
        expect(() => JSON.parse(bounded.text)).not.toThrow()
    })

    it('Gate1 reports strict structural mismatch and rejects fixture mode', async () => {
        const { cwd, manifest } = await setup()
        for (const mode of ['model', 'fixture']) {
            const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
                const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
                return Response.json({
                    status: 'ok',
                    mode,
                    requestId: metadata.requestId,
                    binding: metadata.binding,
                    value: { ...manifest.expected, steps: [] },
                })
            })
            expect(
                (await runGate(1, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)).status,
            ).not.toBe('pass')
            expect(fetchMock).toHaveBeenCalledTimes(1)
        }
    })
    it.each(['unknown-critical-fact', 'unresolved-citation', 'unselected-citation'] as const)(
        'Gate3 rejects %s before any dispatch',
        async (scenario) => {
            const { cwd, manifest } = await setup()
            if (scenario === 'unknown-critical-fact')
                manifest.expected.steps[0]!.orientation = { state: 'unknown', reason: 'unobservable' }
            if (scenario === 'unresolved-citation')
                manifest.expected.steps[0]!.sourceRefs = [{ pageId: 'absent-page', region: null }]
            if (scenario === 'unselected-citation') {
                manifest.pages.push({ ...manifest.pages[0]!, pageId: 'uncited-page', assetId: 'uncited-asset' })
                manifest.sourcePageIds = ['uncited-page']
            }
            const fetchMock = vi.fn<typeof fetch>()
            expect(
                await runGate(3, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock),
            ).toMatchObject({ status: 'unverified', requests: 0 })
            expect(fetchMock).not.toHaveBeenCalled()
        },
    )

    it('reports explicit compact>=3 and parse>=21 source limits without dispatch', async () => {
        const { cwd, manifest } = await setup()
        const fetchMock = vi.fn<typeof fetch>()
        manifest.pages = Array.from({ length: 3 }, (_, i) => ({
            ...manifest.pages[0]!,
            pageId: `page-${i}`,
            assetId: `asset-${i}`,
        }))
        manifest.sourcePageIds = ['page-0', 'page-1', 'page-2']
        expect(await runGate(3, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)).toMatchObject(
            { status: 'unverified', reason: 'check_source_limit_2', requests: 0 },
        )
        manifest.pages = Array.from({ length: 21 }, (_, i) => ({
            ...manifest.pages[0]!,
            pageId: `page-${i}`,
            assetId: `asset-${i}`,
        }))
        expect(await runGate(1, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)).toMatchObject(
            { status: 'unverified', reason: 'parse_source_limit_20' },
        )
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it.each([
        'stable',
        'unstable',
        'missing-terminal',
        'unavailable',
        'repeated-frame',
        'wrong-stream',
        'wrong-binding',
        'after-terminal',
    ] as const)('validates SAM false snapshots and terminal protocol: %s', async (scenario) => {
        const stable = scenario !== 'unstable'
        const { cwd, manifest } = await setup()
        manifest.localization = 'sam'
        const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
            const form = init?.body as FormData
            const metadata = JSON.parse(String(form.get('metadata')))
            const clip = metadata.media.kind === 'clip'
            if (clip)
                expect(await (form.get('media') as File).text()).toBe('synthetic mock transport only, not a real clip')
            const snapshots = Array.from({ length: clip ? 2 : 1 }, (_, index) => ({
                type: 'snapshot',
                snapshot: {
                    binding: metadata.binding,
                    streamId: 'synthetic-stream',
                    frameIndex: index,
                    capturedAt: metadata.capturedAt,
                    complete: false,
                    records: [
                        {
                            objectId: stable ? 'object-1' : `object-${index}`,
                            label: 'panel',
                            box: { x: 0, y: 0, width: 1, height: 1 },
                        },
                    ],
                },
            }))
            if (clip && scenario === 'repeated-frame') snapshots[1]!.snapshot.frameIndex = 0
            if (clip && scenario === 'wrong-stream') snapshots[1]!.snapshot.streamId = 'wrong-stream'
            if (clip && scenario === 'wrong-binding')
                snapshots[1]!.snapshot.binding = { ...metadata.binding, captureId: 'wrong-capture' }
            const terminal =
                scenario === 'unavailable' && clip
                    ? { type: 'unavailable', code: 'provider_error' }
                    : { type: 'completed' }
            const events = clip && scenario === 'missing-terminal' ? snapshots : [...snapshots, terminal]
            if (clip && scenario === 'after-terminal') events.push(snapshots[0]!)
            return new Response(
                events
                    .map(
                        (value) =>
                            `data: ${JSON.stringify({ status: 'ok', mode: 'model', requestId: metadata.requestId, binding: metadata.binding, value })}\n\n`,
                    )
                    .join(''),
            )
        })
        const result = await runGate(2, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)
        expect(result).toMatchObject({ status: scenario === 'stable' ? 'pass' : 'unverified', requests: 2 })
        if (scenario === 'stable' || scenario === 'unstable') {
            expect(result.stableTrackIds).toBe(stable)
        } else {
            expect(result.stableTrackIds).toBeUndefined()
        }
    })
})

it.each([true, false])(
    'Gate2 defaults to same-call Spark still box with operator truth, matching=%s',
    async (matching) => {
        const { cwd, manifest } = await setup()
        manifest.expectedObservationRegion = { x: 0.3, y: 0.2, width: 0.2, height: 0.65 }
        const transport = vi.fn<typeof fetch>(async (url, init) => {
            expect(String(url)).toBe('http://localhost:3001/api/checks')
            const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
            return Response.json({
                status: 'ok',
                mode: 'model',
                requestId: metadata.requestId,
                binding: metadata.binding,
                value: {
                    ...createHeroResponse('reversed'),
                    observedRegion: matching
                        ? manifest.expectedObservationRegion
                        : { x: 0.8, y: 0, width: 0.1, height: 0.1 },
                },
            })
        })
        expect(await runGate(2, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', transport)).toMatchObject(
            {
                status: matching ? 'pass' : 'fail',
                requests: 1,
                localizationProvider: 'spark',
                boxIou: matching ? 1 : 0,
            },
        )
        expect(transport).toHaveBeenCalledTimes(1)
    },
)

it('Gate2 requires independent box truth before any provider dispatch', async () => {
    const { cwd, manifest } = await setup()
    const transport = vi.fn<typeof fetch>()
    expect(await runGate(2, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', transport)).toMatchObject({
        status: 'unverified',
        requests: 0,
        reason: 'operator_box_truth_required',
    })
    expect(transport).not.toHaveBeenCalled()
})

it.each(['compact', 'unverified'] as const)(
    'does not label full-manual acceptance when server scope is %s',
    async (scope) => {
        const { cwd, manifest } = await setup()
        for (let i = 1; i < 3; i++)
            manifest.pages.push({ ...manifest.pages[0]!, pageId: `page-${i}`, assetId: `asset-${i}` })
        const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
            const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
            expect(metadata.sourcePageIds).toHaveLength(3)
            return Response.json(
                {
                    status: 'ok',
                    mode: 'model',
                    requestId: metadata.requestId,
                    binding: metadata.binding,
                    value: createHeroResponse('reversed'),
                },
                {
                    headers:
                        scope === 'compact'
                            ? { 'x-truebuild-check-context': 'compact', 'x-truebuild-source-pages': '1' }
                            : {},
                },
            )
        })
        expect(await runGate(3, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)).toMatchObject(
            {
                status: 'unverified',
                fullManual: false,
                contextMode: scope,
                requests: 1,
            },
        )
    },
)

describe('gate 3 is Spark-only', () => {
    it.each(['muse-wonder-1.0', 'muse-spark-1.3-contributor'])(
        'refuses a local MODEL_SPARK=%s before any dispatch',
        async (model) => {
            const { cwd } = await setup()
            await writeFile(
                join(cwd, '.env'),
                `PROVIDER_MODE=meta\nMODEL_API_KEY=<synthetic>\nAPI_SHARED_SECRET=synthetic\nMODEL_SPARK=${model}`,
            )
            const fetchMock = vi.fn<typeof fetch>()
            vi.stubGlobal('fetch', fetchMock)
            vi.spyOn(console, 'log').mockImplementation(() => {})
            expect(
                await main(['3', '--dispatch', '--confirm-critical-facts', '--manifest', 'manifest.json'], cwd),
            ).toBe(2)
            expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('spark_only_gate3_required'))
            expect(fetchMock).not.toHaveBeenCalled()
        },
    )
    it('accepts an explicit or absent Spark setting and still fails a returned non-Spark model', async () => {
        for (const env of ['', 'MODEL_SPARK=muse-spark-1.3\n']) {
            const { cwd } = await setup()
            await writeFile(
                join(cwd, '.env'),
                `PROVIDER_MODE=meta\nMODEL_API_KEY=<synthetic>\nAPI_SHARED_SECRET=synthetic\n${env}`,
            )
            await loadAuthorization(cwd, true, 3)
        }
        const { cwd, manifest } = await setup()
        const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
            const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
            return Response.json({
                status: 'ok',
                mode: 'model',
                requestId: metadata.requestId,
                binding: metadata.binding,
                value: { ...createHeroResponse('reversed'), model: 'muse-wonder-1.0' },
            })
        })
        expect(await runGate(3, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)).toMatchObject(
            {
                status: 'fail',
                reason: 'non_spark_model_returned',
                requests: 1,
            },
        )
    })
    it('passes a returned Spark model with full-manual scope unchanged', async () => {
        const { cwd, manifest } = await setup()
        const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
            const metadata = JSON.parse(String((init?.body as FormData).get('metadata')))
            return Response.json(
                {
                    status: 'ok',
                    mode: 'model',
                    requestId: metadata.requestId,
                    binding: metadata.binding,
                    value: { ...createHeroResponse('reversed'), model: 'muse-spark-1.3' },
                },
                { headers: { 'x-truebuild-check-context': 'full', 'x-truebuild-source-pages': '1' } },
            )
        })
        expect(await runGate(3, manifest, cwd, new URL('http://localhost:3001'), 'synthetic', fetchMock)).toMatchObject(
            {
                status: 'pass',
                requests: 1,
            },
        )
    })
})
