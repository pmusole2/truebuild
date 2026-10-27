import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createHeroManual, HERO_DIAGRAM_PNG_BASE64 } from '@truebuild/contracts/hero'
import type { ParsedManual, StandardModel } from '@truebuild/contracts'
import { manifestSchema, type Manifest, type StepReviewer } from './run'
import {
    abMain,
    costUsd,
    defaultProviderFactory,
    runAbGate,
    type AbMetric,
    type AbProviderFactory,
    type AbReport,
} from './ab'

const SPARK = 'muse-spark-1.3'
const WONDER = 'muse-wonder-1.0'
const ARGV = ['1b', '--manifest', 'gate.json', '--dispatch', '--ab', '--confirm-critical-facts']
const USAGE = { inputTokens: 1000, cachedTokens: 400, outputTokens: 200, reasoningTokens: 50 }

const dirs: string[] = []
afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const expected = createHeroManual().rawExtraction!

async function setup(
    env = 'PROVIDER_MODE=meta\nMODEL_API_KEY=<synthetic-key>\n',
): Promise<{ cwd: string; manifest: Manifest }> {
    const cwd = await mkdtemp(join(tmpdir(), 'truebuild-gate-ab-synthetic-'))
    dirs.push(cwd)
    await writeFile(join(cwd, 'image.png'), Buffer.from(HERO_DIAGRAM_PNG_BASE64, 'base64'))
    if (env) await writeFile(join(cwd, '.env'), env)
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
        expected,
        observation: { path: 'image.png', width: 600, height: 400, mimeType: 'image/png' },
        expectedDecision: 'refuse',
        stepId: 'step-1',
    })
    await writeFile(join(cwd, 'gate.json'), JSON.stringify(manifest))
    return { cwd, manifest }
}

type FakeFactory = {
    factory: Mock<AbProviderFactory>
    calls: { parseModel: string; pageBytes: number[][]; pageIds: string[] }[]
}
type Behaviour = {
    /** Parsed result, or an error thrown by parseManual. Default: the expected plan attributed to the requested model. */
    result?: ParsedManual | Error
    /** Provider attempts before success; earlier ones emit a status-only transport event. */
    attempts?: number
    /** Usage-bearing event; null omits usage entirely. */
    usage?: Partial<AbMetric> | null
    /** Model reported on dispatch metrics; defaults to the requested model. */
    dispatchModel?: string
    /** Omit metrics entirely. */
    noMetrics?: boolean
}
function parsedFor(model: string | undefined): ParsedManual {
    return { ...structuredClone(expected), ...(model ? { model } : {}) } as ParsedManual
}

/** Records factory options, parse calls and page bytes; never reads a real .env or contacts Meta. */
function fakeFactory(behaviours: Partial<Record<StandardModel, Behaviour>> = {}): FakeFactory {
    const calls: { parseModel: string; pageBytes: number[][]; pageIds: string[] }[] = []
    const factory = vi.fn<AbProviderFactory>((options) => {
        const behaviour = behaviours[options.parseModel] ?? {}
        return {
            async parseManual(input, signal): Promise<ParsedManual> {
                expect(signal).toBeInstanceOf(AbortSignal)
                calls.push({
                    parseModel: options.parseModel,
                    pageBytes: input.pages.map((page) => [...page.bytes]),
                    pageIds: input.pages.map((page) => page.page.pageId),
                })
                const model = behaviour.dispatchModel ?? options.parseModel
                if (!behaviour.noMetrics) {
                    for (let attempt = 1; attempt < (behaviour.attempts ?? 1); attempt++)
                        options.onMetrics({ operation: 'parse', model, status: 429, latencyMs: 5 })
                    options.onMetrics({ operation: 'parse', model, status: 200, latencyMs: 9 })
                    if (behaviour.usage !== null)
                        options.onMetrics({
                            operation: 'parse',
                            model,
                            status: 200,
                            latencyMs: 9,
                            ...USAGE,
                            ...behaviour.usage,
                        })
                }
                const result = behaviour.result ?? parsedFor(options.parseModel)
                if (result instanceof Error) throw result
                return result
            },
        }
    })
    return { factory, calls }
}

async function readReport(cwd: string): Promise<string> {
    return readFile(join(cwd, 'docs/gate-results.md'), 'utf8')
}
async function readLastReport(cwd: string): Promise<AbReport> {
    const [line] = (await readReport(cwd)).trim().split('\n').slice(-1)
    return JSON.parse(line!.replace(/^- \S+ /, '')) as AbReport
}

describe('Standard model cost from actual usage at cited prices', () => {
    it('prices Spark from uncached input, cached input and output; reasoning stays inside output', () => {
        // (1000-400)*1.25 + 400*0.15 + 200*4.25 = 1660 per million tokens.
        expect(costUsd({ inputTokens: 1000, cachedTokens: 400, outputTokens: 200 }, SPARK)).toEqual({
            status: 'priced',
            costUsd: 0.00166,
        })
    })
    it('prices Wonder at its cited Standard rates', () => {
        // 600*4 + 400*0.20 + 200*20 = 6480 per million tokens.
        expect(costUsd({ inputTokens: 1000, cachedTokens: 400, outputTokens: 200 }, WONDER)).toEqual({
            status: 'priced',
            costUsd: 0.00648,
        })
    })
    it.each([
        ['missing cached tokens', { inputTokens: 1000, outputTokens: 200 }],
        ['missing output tokens', { inputTokens: 1000, cachedTokens: 0 }],
        ['cached exceeding input', { inputTokens: 100, cachedTokens: 101, outputTokens: 1 }],
        ['no usage at all', {}],
    ] as const)('reports cost unverified, never zero, for %s', (_label, usage) => {
        expect(costUsd(usage, SPARK)).toEqual({ status: 'unverified' })
    })
})

describe('gate 1b consent and local readiness', () => {
    it('checks both explicit flags and critical-fact confirmation before any key is read', async () => {
        const { cwd } = await setup()
        const { factory } = fakeFactory()
        for (const argv of [
            ['1b', '--manifest', 'gate.json', '--confirm-critical-facts'],
            ['1b', '--manifest', 'gate.json', '--dispatch', '--confirm-critical-facts'],
            ['1b', '--manifest', 'gate.json', '--dispatch', '--ab'],
        ]) {
            expect(await abMain(argv.slice(1), cwd, { factory })).toBe(2)
        }
        expect(factory).not.toHaveBeenCalled()
        const report = await readReport(cwd)
        expect(report).toContain('"reason":"operator_dispatch_required"')
        expect(report).toContain('"reason":"ab_consent_required"')
        expect(report).toContain('"reason":"critical_facts_confirmation_required"')
        expect(report).toContain('"requests":0')
        expect(report).not.toContain('synthetic-key')
    })
    it.each([
        ['PROVIDER_MODE=fixture\nMODEL_API_KEY=<synthetic-key>\n', 'meta_mode_required'],
        ['PROVIDER_MODE=meta\nMODEL_API_KEY=\n', 'local_key_required'],
        ['', 'local_key_required'],
    ])('refuses unready local env %# without dispatch', async (env, reason) => {
        const { cwd } = await setup(env)
        const { factory } = fakeFactory()
        expect(await abMain(ARGV, cwd, { factory })).toBe(2)
        expect(factory).not.toHaveBeenCalled()
        expect(await readReport(cwd)).toContain(`"reason":"${reason}"`)
    })
    it('passes the local key to the factory without requiring the shared secret or mutating process env', async () => {
        const { cwd } = await setup('PROVIDER_MODE=meta\nMODEL_API_KEY=<synthetic-key>\n')
        const before = { ...process.env }
        const { factory } = fakeFactory()
        await abMain(ARGV, cwd, { factory, random: () => false })
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '<synthetic-key>' }))
        expect(process.env).toEqual(before)
        expect(await readReport(cwd)).not.toContain('shared_secret_required')
    })
    it('refuses --review without an interactive terminal before dispatch', async () => {
        const { cwd } = await setup()
        const { factory } = fakeFactory()
        expect(await abMain([...ARGV, '--review'], cwd, { factory, interactive: false })).toBe(2)
        expect(factory).not.toHaveBeenCalled()
        expect(await readReport(cwd)).toContain('"reason":"interactive_gate1_review_required"')
    })
})

describe('gate 1b sequencing and identical inputs', () => {
    it('parses each model once with an explicit parseModel, in the randomized order', async () => {
        const { cwd } = await setup()
        const { factory, calls } = fakeFactory()
        await abMain(ARGV, cwd, { factory, random: () => true })
        expect(factory.mock.calls.map(([options]) => options.parseModel)).toEqual([WONDER, SPARK])
        expect(calls.map((call) => call.parseModel)).toEqual([WONDER, SPARK])
        for (const [options] of factory.mock.calls) {
            expect(Object.keys(options).sort()).toEqual(['apiKey', 'onMetrics', 'parseModel'])
        }
    })
    it('sends identical real page bytes and page identities to both arms', async () => {
        const { cwd, manifest } = await setup()
        const { factory, calls } = fakeFactory()
        await abMain(ARGV, cwd, { factory })
        expect(calls).toHaveLength(2)
        expect(calls[0]!.pageBytes).toEqual(calls[1]!.pageBytes)
        expect(calls[0]!.pageIds).toEqual(manifest.pages.map((page) => page.pageId))
        expect(calls[0]!.pageBytes[0]!.length).toBeGreaterThan(0)
    })
})

describe('no automatic fallback: a Wonder failure stays a Wonder failure', () => {
    it('reports a Wonder timeout as a failed Wonder arm, keeps Spark, retries nothing and substitutes nothing', async () => {
        const { cwd } = await setup()
        const { factory, calls } = fakeFactory({
            [WONDER]: { result: Object.assign(new Error('timeout'), { code: 'timeout' }), noMetrics: true },
        })
        expect(await abMain(ARGV, cwd, { factory })).toBe(2)
        expect(calls.map((call) => call.parseModel).sort()).toEqual([SPARK, WONDER])
        expect(factory.mock.calls.filter(([options]) => options.parseModel === SPARK)).toHaveLength(1)
        const report = await readLastReport(cwd)
        expect(report.models.wonder).toMatchObject({ model: WONDER, status: 'failed', reason: 'timeout' })
        expect(report.models.spark).toMatchObject({ model: SPARK, status: 'completed' })
        expect(report).toMatchObject({
            reason: 'arm_incomplete_no_fallback',
            automaticFallback: 'none',
            winner: 'unverified',
        })
    })
    it('maps a DOM TimeoutError to timeout and any unknown error text to provider_error', async () => {
        const { manifest, cwd } = await setup()
        const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        const { factory } = fakeFactory({
            [WONDER]: { result: timeout, noMetrics: true },
            [SPARK]: { result: new Error('raw provider body with secret text'), noMetrics: true },
        })
        const report = await runAbGate({ manifest, cwd, apiKey: 'synthetic-key', factory, random: () => false })
        expect(report.models.wonder?.reason).toBe('timeout')
        expect(report.models.spark?.reason).toBe('provider_error')
        expect(JSON.stringify(report)).not.toContain('raw provider body')
    })
    it('marks an arm incomplete when dispatch metrics name a different model, without a retry', async () => {
        const { cwd } = await setup()
        const { factory } = fakeFactory({ [WONDER]: { dispatchModel: SPARK } })
        await abMain(ARGV, cwd, { factory })
        expect(factory.mock.calls.map(([options]) => options.parseModel).sort()).toEqual([SPARK, WONDER])
        expect(await readReport(cwd)).toContain('"reason":"model_attribution_mismatch"')
    })
    it('marks an arm incomplete when a returned model field names another model', async () => {
        const { cwd, manifest } = await setup()
        const { factory } = fakeFactory({ [WONDER]: { result: parsedFor(SPARK) } })
        const report = await runAbGate({ manifest, cwd, apiKey: 'synthetic-key', factory, random: () => false })
        expect(report.models.wonder).toMatchObject({ status: 'incomplete', reason: 'model_attribution_mismatch' })
        expect(report.models.spark?.status).toBe('completed')
        expect(report.winner).toBe('unverified')
    })
    it('accepts a result without a model field when dispatch metrics name the requested model, recording the source', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [SPARK]: { result: parsedFor(undefined) } })
        const report = await runAbGate({ manifest, cwd, apiKey: 'synthetic-key', factory, random: () => false })
        expect(report.models.spark).toMatchObject({ status: 'completed', provenance: 'dispatch_metrics' })
    })
    it('marks a success without any dispatch metrics as unattributed rather than completed', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [SPARK]: { noMetrics: true } })
        const report = await runAbGate({ manifest, cwd, apiKey: 'synthetic-key', factory, random: () => false })
        expect(report.models.spark).toMatchObject({ status: 'incomplete', reason: 'model_dispatch_unattributed' })
    })
    it('refuses both arms without a Spark substitute when the parse dependency is unavailable', async () => {
        const { cwd } = await setup()
        const fetchMock = vi.fn<typeof fetch>()
        vi.stubGlobal('fetch', fetchMock)
        expect(await abMain(ARGV, cwd)).toBe(2)
        expect(fetchMock).not.toHaveBeenCalled()
        const report = await readReport(cwd)
        expect(report).toContain('"reason":"provider_dependency_unavailable"')
        expect(report).toContain('"requests":0')
        expect(defaultProviderFactory).toBeTypeOf('function')
    })
    it('reports attempts from transport events and prices only the single usage event', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [SPARK]: { attempts: 2 } })
        const report = await runAbGate({ manifest, cwd, apiKey: 'synthetic-key', factory, random: () => false })
        expect(report.models.spark).toMatchObject({ attempts: 2, costStatus: 'priced', costUsd: 0.00166 })
        expect(report.requests).toBe(2 + 1)
    })
    it('leaves cost unverified when the provider returns no usage', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [WONDER]: { usage: null } })
        const report = await runAbGate({ manifest, cwd, apiKey: 'synthetic-key', factory, random: () => false })
        expect(report.models.wonder).toMatchObject({ costStatus: 'unverified' })
        expect(report.models.wonder).not.toHaveProperty('costUsd')
    })
})

describe('human review, winner and default', () => {
    it('keeps quality unverified and declares no winner without operator review', async () => {
        const { cwd } = await setup()
        const { factory } = fakeFactory()
        expect(await abMain(ARGV, cwd, { factory })).toBe(2)
        const report = await readReport(cwd)
        expect(report).toContain('"semanticStepAccuracy":"unverified"')
        expect(report).toContain('"winner":"unverified"')
        expect(report).toContain('"reason":"semantic_review_unverified"')
        expect(report).toContain('"defaultChange":"none"')
        expect(report).not.toContain('"semanticStepAccuracy":"human_reviewed"')
    })
    it('reviews a fixed set per arm; the first reviewed arm is Spark when the order is Spark-first', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const steps = manifest.expected.steps.length
        let calls = 0
        const reviewer = vi.fn<StepReviewer>(async () => (calls++ < steps ? 'correct' : 'incorrect'))
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: 'synthetic-key',
            factory,
            reviewer,
            random: () => false,
        })
        expect(report.models.spark).toMatchObject({
            semanticStepAccuracy: 'human_reviewed',
            humanStepAccuracyPercent: 100,
        })
        expect(report.models.wonder).toMatchObject({
            semanticStepAccuracy: 'human_reviewed',
            humanStepAccuracyPercent: 0,
        })
        expect(report.status).toBe('pass')
        expect(report.reason).toBe('ab_human_reviewed')
        expect(report.winner).toBe(SPARK)
        expect(report.defaultChange).toBe('none')
        expect(report.recommendation).toBe('keep_spark_default')
    })
    it('declares Wonder as the reviewed accuracy winner when Wonder is better, while the default is unchanged', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const steps = manifest.expected.steps.length
        let calls = 0
        const reviewer = vi.fn<StepReviewer>(async () => (calls++ < steps ? 'correct' : 'incorrect'))
        // random() true parses and reviews Wonder first, so its set is the all-correct one.
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: 'synthetic-key',
            factory,
            reviewer,
            random: () => true,
        })
        expect(report.winner).toBe(WONDER)
        expect(report.defaultChange).toBe('none')
        expect(report.recommendation).toBe('keep_spark_default')
    })
    it('reports equal reviewed accuracy as no measured difference', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: 'synthetic-key',
            factory,
            reviewer: async () => 'correct',
            random: () => false,
        })
        expect(report.winner).toBe('no_measured_difference')
    })
    it('keeps the winner unverified when a reviewed step is unverifiable', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: 'synthetic-key',
            factory,
            reviewer: async () => 'unverifiable',
            random: () => false,
        })
        expect(report.winner).toBe('unverified')
        expect(report.status).toBe('unverified')
        expect(report.models.spark?.semanticStepAccuracy).toBe('unverified')
    })
    it('keeps the outcome unverified and no winner when the Wonder arm failed, even if Spark was reviewed', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [WONDER]: { result: new Error('timeout'), noMetrics: true } })
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: 'synthetic-key',
            factory,
            reviewer: async () => 'correct',
            random: () => false,
        })
        expect(report.models.spark?.semanticStepAccuracy).toBe('human_reviewed')
        expect(report.models.wonder?.status).toBe('failed')
        expect(report.winner).toBe('unverified')
        expect(report.status).toBe('unverified')
        expect(report.reason).toBe('arm_incomplete_no_fallback')
    })
    it('blinds the reviewer: review input carries no model identity', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const seen: string[] = []
        await runAbGate({
            manifest,
            cwd,
            apiKey: 'synthetic-key',
            factory,
            reviewer: async (input) => {
                seen.push(JSON.stringify(input))
                return 'correct'
            },
            random: () => false,
        })
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.some((text) => /muse|spark|wonder/i.test(text))).toBe(false)
    })
    it('writes one aggregate-only line without key, page bytes or step wording', async () => {
        const { cwd, manifest } = await setup()
        const { factory } = fakeFactory()
        await abMain(ARGV, cwd, { factory })
        const report = await readReport(cwd)
        expect(report.trim().split('\n')).toHaveLength(1)
        expect(report).not.toContain('synthetic-key')
        expect(report).not.toContain('image.png')
        expect(report).not.toContain(manifest.expected.steps[0]!.title)
        expect(report).toContain('"costUsd"')
        expect(report).toContain('"latencyMs"')
    })
})
