import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createHeroManual, HERO_DIAGRAM_PNG_BASE64 } from '@truebuild/contracts/hero'
import type { ParsedManual, StandardModel } from '@truebuild/contracts'
import { manifestSchema, type Manifest, type StepReviewer } from './run'
import {
    abMain,
    conclude,
    costUsd,
    parseQualityAnswer,
    runAbGate,
    type AbArm,
    type AbMetric,
    type AbProviderFactory,
    type AbReport,
    type QualityReviewer,
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
type FakeFactory = {
    factory: Mock<AbProviderFactory>
    calls: { parseModel: string; pageBytes: number[][]; pageIds: string[] }[]
}
function parsedFor(model: string | undefined): ParsedManual {
    return { ...structuredClone(expected), ...(model ? { model } : {}) } as ParsedManual
}

/** Records factory options, parse calls and page bytes; never reads a real .env or contacts Meta. */
function fakeFactory(behaviours: Partial<Record<StandardModel, Behaviour>> = {}): FakeFactory {
    const calls: FakeFactory['calls'] = []
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

/** Step reviewer answers `correct` for the first `correctCount` calls, then `incorrect`; calls run arm by arm. */
function stepsInOrder(correctCount: number): StepReviewer {
    let calls = 0
    return async () => (calls++ < correctCount ? 'correct' : 'incorrect')
}
/** Quality answers in the order the arms are reviewed. */
function ratingsInOrder(...ratings: (1 | 2 | 3 | 4 | 5)[]): QualityReviewer {
    let calls = 0
    return async () => ({ rating: ratings[calls++]!, issues: [] })
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
        expect(report).not.toContain('<synthetic-key>')
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
        const { cwd } = await setup()
        const before = { ...process.env }
        const { factory } = fakeFactory()
        expect(await abMain(ARGV, cwd, { factory, random: () => false })).toBe(2)
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '<synthetic-key>' }))
        expect(process.env).toEqual(before)
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
            conclusion: 'unverified',
            wonderClearlyWins: false,
        })
    })
    it('maps a DOM TimeoutError to timeout and any unknown error text to provider_error', async () => {
        const { manifest, cwd } = await setup()
        const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        const { factory } = fakeFactory({
            [WONDER]: { result: timeout, noMetrics: true },
            [SPARK]: { result: new Error('raw provider body with secret text'), noMetrics: true },
        })
        const report = await runAbGate({ manifest, cwd, apiKey: '<synthetic-key>', factory, random: () => false })
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
        const report = await runAbGate({ manifest, cwd, apiKey: '<synthetic-key>', factory, random: () => false })
        expect(report.models.wonder).toMatchObject({ status: 'incomplete', reason: 'model_attribution_mismatch' })
        expect(report.models.spark?.status).toBe('completed')
        expect(report.conclusion).toBe('unverified')
    })
    it('accepts a result without a model field when dispatch metrics name the requested model, recording the source', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [SPARK]: { result: parsedFor(undefined) } })
        const report = await runAbGate({ manifest, cwd, apiKey: '<synthetic-key>', factory, random: () => false })
        expect(report.models.spark).toMatchObject({ status: 'completed', provenance: 'dispatch_metrics' })
    })
    it('marks a success without any dispatch metrics as unattributed rather than completed', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [SPARK]: { noMetrics: true } })
        const report = await runAbGate({ manifest, cwd, apiKey: '<synthetic-key>', factory, random: () => false })
        expect(report.models.spark).toMatchObject({ status: 'incomplete', reason: 'model_dispatch_unattributed' })
    })
    it('reports the provider retry policy and zero gate retries, counting provider attempts per arm', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [SPARK]: { attempts: 2 } })
        const report = await runAbGate({ manifest, cwd, apiKey: '<synthetic-key>', factory, random: () => false })
        expect(report.providerRetryPolicy).toBe('one_pre_response_network_retry_100ms_no_http_retry')
        expect(report.gateRetryPolicy).toBe('none')
        expect(report.models.spark).toMatchObject({ attempts: 2, costStatus: 'priced', costUsd: 0.00166 })
        expect(report.requests).toBe(2 + 1)
        expect(factory).toHaveBeenCalledTimes(2)
    })
    it('does not count a usage callback whose usage fields are all undefined as a second attempt', async () => {
        const { manifest, cwd } = await setup()
        // The real provider always spreads usageMetrics(): every key exists, values may be undefined.
        const undefinedUsage = {
            inputTokens: undefined,
            cachedTokens: undefined,
            outputTokens: undefined,
            reasoningTokens: undefined,
        }
        const { factory } = fakeFactory({ [SPARK]: { usage: undefinedUsage } })
        const report = await runAbGate({ manifest, cwd, apiKey: '<synthetic-key>', factory, random: () => false })
        expect(report.models.spark).toMatchObject({ attempts: 1, attemptsStatus: 'exact', costStatus: 'unverified' })
        expect(report.models.spark).not.toHaveProperty('costUsd')
        expect(report.requestsStatus).toBe('exact')
    })
    it('marks a failed arm attempt count as a lower bound, never an exact count', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({
            [WONDER]: { result: new Error('timeout'), attempts: 3 },
        })
        const report = await runAbGate({ manifest, cwd, apiKey: '<synthetic-key>', factory, random: () => false })
        expect(report.models.wonder).toMatchObject({ attempts: 3, attemptsStatus: 'lower_bound' })
        expect(report.requestsStatus).toBe('lower_bound')
    })
    it('leaves cost unverified when the provider returns no usage', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [WONDER]: { usage: null } })
        const report = await runAbGate({ manifest, cwd, apiKey: '<synthetic-key>', factory, random: () => false })
        expect(report.models.wonder).toMatchObject({ costStatus: 'unverified' })
        expect(report.models.wonder).not.toHaveProperty('costUsd')
    })
})

describe('plan quality and conclusion', () => {
    it.each(['step', 'quality'] as const)(
        'retains paid parse evidence after %s review is interrupted',
        async (phase) => {
            const { manifest, cwd } = await setup()
            const { factory } = fakeFactory()
            const stepReview = vi.fn<StepReviewer>(async () => {
                if (phase === 'step') throw new Error('synthetic closed review')
                return 'correct'
            })
            const qualityReview = vi.fn<QualityReviewer>(async () => {
                if (phase === 'quality') throw new Error('synthetic closed review')
                return { rating: 5, issues: [] }
            })
            const report = await runAbGate({
                manifest,
                cwd,
                apiKey: '<synthetic-key>',
                factory,
                reviewer: stepReview,
                qualityReviewer: qualityReview,
                random: () => false,
            })
            expect(report).toMatchObject({
                status: 'unverified',
                conclusion: 'unverified',
                requests: 2,
                requestsStatus: 'exact',
            })
            expect(report.models.spark).toMatchObject({
                status: 'completed',
                costStatus: 'priced',
                reason: 'operator_review_incomplete',
            })
            expect(report.models.wonder).toMatchObject({ status: 'completed', costStatus: 'priced' })
            expect(stepReview).toHaveBeenCalledTimes(phase === 'step' ? 1 : manifest.expected.steps.length)
            expect(qualityReview).toHaveBeenCalledTimes(phase === 'quality' ? 1 : 0)
            expect(report.models.spark?.semanticStepAccuracy).toBe(
                phase === 'quality' ? 'human_reviewed' : 'unverified',
            )
            expect(report.models.spark?.quality).toEqual({ status: 'unverified' })
            expect(report.models.wonder?.semanticStepAccuracy).toBe('unverified')
            expect(JSON.stringify(report)).not.toContain('synthetic closed review')
        },
    )

    it('keeps quality unverified and declares no conclusion without operator review', async () => {
        const { cwd } = await setup()
        const { factory } = fakeFactory()
        expect(await abMain(ARGV, cwd, { factory })).toBe(2)
        const report = await readLastReport(cwd)
        expect(report.models.spark).toMatchObject({
            semanticStepAccuracy: 'unverified',
            quality: { status: 'unverified' },
        })
        expect(report).toMatchObject({
            conclusion: 'unverified',
            wonderClearlyWins: false,
            reason: 'semantic_review_unverified',
            defaultChange: 'none',
            recommendation: 'keep_spark_default',
        })
    })
    it('needs plan-quality notes for both arms, not only step accuracy', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: '<synthetic-key>',
            factory,
            reviewer: stepsInOrder(manifest.expected.steps.length),
            random: () => false,
        })
        expect(report.status).toBe('unverified')
        expect(report.reason).toBe('plan_quality_unverified')
        expect(report.conclusion).toBe('unverified')
    })
    it('keeps a conclusion unverified when a quality answer is outside the vocabulary', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: '<synthetic-key>',
            factory,
            reviewer: stepsInOrder(manifest.expected.steps.length),
            qualityReviewer: async () => 'unverifiable',
            random: () => false,
        })
        expect(report.models.spark?.quality).toEqual({ status: 'unverified' })
        expect(report.conclusion).toBe('unverified')
    })
    it('declares Wonder clearly wins when the step and rating margins are met', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const steps = manifest.expected.steps.length
        // random() true reviews Wonder first: all steps correct and rating 5; Spark second: incorrect and rating 2.
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: '<synthetic-key>',
            factory,
            reviewer: stepsInOrder(steps),
            qualityReviewer: ratingsInOrder(5, 2),
            random: () => true,
        })
        expect(report).toMatchObject({
            status: 'pass',
            reason: 'ab_human_reviewed',
            conclusion: 'wonderClearlyWins',
            wonderClearlyWins: true,
            defaultChange: 'none',
            recommendation: 'keep_spark_default',
        })
    })
    it('declares Spark clearly wins without changing the default when Spark is better on both measures', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: '<synthetic-key>',
            factory,
            reviewer: stepsInOrder(manifest.expected.steps.length),
            qualityReviewer: ratingsInOrder(4, 3),
            random: () => false,
        })
        expect(report).toMatchObject({
            conclusion: 'sparkClearlyWins',
            wonderClearlyWins: false,
            defaultChange: 'none',
        })
    })
    it('treats equal step accuracy as no clear win even when ratings differ', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: '<synthetic-key>',
            factory,
            reviewer: async () => 'correct',
            qualityReviewer: ratingsInOrder(2, 5),
            random: () => true,
        })
        expect(report.models.wonder?.humanStepAccuracyPercent).toBe(report.models.spark?.humanStepAccuracyPercent)
        expect(report.conclusion).toBe('no_clear_win')
        expect(report.wonderClearlyWins).toBe(false)
    })
    it('prints n=1, inconclusive beside raw counts when Wonder leads by only one step', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const steps = manifest.expected.steps.length
        const print = vi.spyOn(console, 'log').mockImplementation(() => {})
        await abMain([...ARGV, '--review'], cwd, {
            factory,
            interactive: true,
            random: () => true,
            reviewer: stepsInOrder(2 * steps - 1),
            qualityReviewer: ratingsInOrder(4, 3),
        })
        const report = await readLastReport(cwd)
        expect(report).toMatchObject({
            conclusion: 'no_clear_win',
            wonderClearlyWins: false,
            comparisonSummary: `n=1, inconclusive; correct steps: Spark ${steps - 1}, Wonder ${steps}; quality ratings: Spark 3, Wonder 4`,
        })
        expect(print).toHaveBeenCalledWith(JSON.stringify(report))
    })
    it('treats a step-accuracy lead without a quality lead as no clear win, not a quality win', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: '<synthetic-key>',
            factory,
            reviewer: stepsInOrder(manifest.expected.steps.length),
            qualityReviewer: ratingsInOrder(3, 3),
            random: () => true,
        })
        expect(report.conclusion).toBe('no_clear_win')
        expect(report.wonderClearlyWins).toBe(false)
    })
    it('keeps the conclusion unverified and the status incomplete when the Wonder arm failed, even if Spark was rated', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory({ [WONDER]: { result: new Error('timeout'), noMetrics: true } })
        const report = await runAbGate({
            manifest,
            cwd,
            apiKey: '<synthetic-key>',
            factory,
            reviewer: stepsInOrder(manifest.expected.steps.length),
            qualityReviewer: ratingsInOrder(4),
            random: () => false,
        })
        expect(report.models.spark?.semanticStepAccuracy).toBe('human_reviewed')
        expect(report.models.wonder?.status).toBe('failed')
        expect(report).toMatchObject({
            conclusion: 'unverified',
            status: 'unverified',
            reason: 'arm_incomplete_no_fallback',
            comparisonSummary: `n=0, inconclusive; correct steps: Spark ${manifest.expected.steps.length}, Wonder unverified; quality ratings: Spark 4, Wonder unverified`,
        })
    })
    it('blinds reviewers: step and quality review inputs carry no model identity', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        const seen: string[] = []
        await runAbGate({
            manifest,
            cwd,
            apiKey: '<synthetic-key>',
            factory,
            reviewer: async (input) => {
                seen.push(JSON.stringify(input))
                return 'correct'
            },
            qualityReviewer: async (input) => {
                seen.push(JSON.stringify(input))
                return { rating: 3, issues: [] }
            },
            random: () => false,
        })
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.some((text) => /muse|spark|wonder/i.test(text))).toBe(false)
    })
    it('persists only the fixed quality vocabulary, never operator text or model bodies', async () => {
        const { manifest, cwd } = await setup()
        const { factory } = fakeFactory()
        await abMain([...ARGV, '--review'], cwd, {
            factory,
            interactive: true,
            random: () => false,
            reviewer: stepsInOrder(manifest.expected.steps.length),
            qualityReviewer: async () => ({ rating: 4, issues: ['orientation', 'citation'] }),
        })
        const report = await readLastReport(cwd)
        expect(report.models.spark?.quality).toEqual({
            status: 'operator_rated',
            rating: 4,
            issues: ['orientation', 'citation'],
        })
        const text = await readReport(cwd)
        expect(text).not.toContain('<synthetic-key>')
        expect(text).not.toContain(manifest.expected.steps[0]!.title)
        expect(text).not.toContain('image.png')
    })
    it('writes exactly one aggregate line for a run', async () => {
        const { cwd } = await setup()
        const { factory } = fakeFactory()
        await abMain(ARGV, cwd, { factory })
        const report = await readReport(cwd)
        expect(report.trim().split('\n')).toHaveLength(1)
        expect(report).toContain('"costUsd"')
        expect(report).toContain('"latencyMs"')
    })
})

describe('conclude and quality answer parsing', () => {
    const arm = (model: StandardModel, correctSteps: number, rating: 1 | 2 | 3 | 4 | 5 | undefined): AbArm => ({
        model,
        status: 'completed',
        reason: 'parse_completed',
        attempts: 1,
        attemptsStatus: 'exact',
        latencyMs: 1,
        costStatus: 'unverified',
        semanticStepAccuracy: 'human_reviewed',
        correctSteps,
        quality: rating === undefined ? { status: 'unverified' } : { status: 'operator_rated', rating, issues: [] },
    })
    it.each([
        [
            'Spark margin met: two steps, one point',
            4,
            4,
            2,
            3,
            { conclusion: 'sparkClearlyWins', wonderClearlyWins: false },
        ],
        [
            'Wonder margin met: two steps, one point',
            2,
            3,
            4,
            4,
            { conclusion: 'wonderClearlyWins', wonderClearlyWins: true },
        ],
        ['Wonder one step, one point', 2, 3, 3, 4, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
        ['Spark one step, one point', 3, 4, 2, 3, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
        ['one rating point only', 2, 3, 2, 4, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
        ['one step with two rating points', 2, 2, 3, 4, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
        ['complete tie', 2, 3, 2, 3, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
        ['accuracy tie', 2, 2, 2, 4, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
        ['rating tie', 2, 3, 4, 3, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
        ['split verdict', 4, 2, 2, 4, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
        ['opposite split verdict', 2, 4, 4, 2, { conclusion: 'no_clear_win', wonderClearlyWins: false }],
    ] as const)('%s', (_label, sparkAcc, sparkRating, wonderAcc, wonderRating, expected) => {
        expect(
            conclude({
                spark: arm(SPARK, sparkAcc, sparkRating),
                wonder: arm(WONDER, wonderAcc, wonderRating),
            }),
        ).toEqual(expected)
    })
    it('is unverified when any arm lacks quality notes or the other arm is missing', () => {
        expect(conclude({ spark: arm(SPARK, 4, undefined), wonder: arm(WONDER, 2, 2) })).toEqual({
            conclusion: 'unverified',
            wonderClearlyWins: false,
        })
        expect(conclude({ spark: arm(SPARK, 4, 3), wonder: undefined })).toEqual({
            conclusion: 'unverified',
            wonderClearlyWins: false,
        })
    })
    it.each([
        ['5', 'orientation,citation', { rating: 5, issues: ['orientation', 'citation'] }],
        ['1', 'none', { rating: 1, issues: [] }],
        ['3', '', { rating: 3, issues: [] }],
        ['4', 'other, other', { rating: 4, issues: ['other'] }],
    ] as const)('accepts rating %s with issues %j', (rating, issues, expected) => {
        expect(parseQualityAnswer(rating, issues)).toEqual(expected)
    })
    it.each([
        ['0', 'none'],
        ['6', 'none'],
        ['x', 'none'],
        ['4', 'free text about the model answer'],
        ['4', 'orientation,<script>'],
    ])('leaves rating %s with issues %j unverifiable', (rating, issues) => {
        expect(parseQualityAnswer(rating, issues)).toBe('unverifiable')
    })
})
