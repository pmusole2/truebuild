import { randomInt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { ManualBinding, ManualPage, ParsedManual, StandardModel } from '@truebuild/contracts'
import { createMetaProvider } from '../api/src/providers/meta-provider'
import {
    appendAggregate,
    loadManualSources,
    manifestSchema,
    reviewExtraction,
    scoreExtraction,
    terminalReviewer,
    type Manifest,
    type StepReviewer,
    type Summary,
} from './run'

/**
 * Gate 1b: one bounded parse per Standard model over the same real pages, in process through the provider.
 * Each arm is keyed by the parseModel it requested. The gate never re-sends a parse and never falls back or substitutes a model; provider-internal retries are reported, not added to.
 */
export const GATE_1B_MODELS = {
    spark: 'muse-spark-1.3',
    wonder: 'muse-wonder-1.0',
} as const satisfies Record<string, StandardModel>
const ARM_KEYS = { 'muse-spark-1.3': 'spark', 'muse-wonder-1.0': 'wonder' } as const satisfies Record<
    StandardModel,
    'spark' | 'wonder'
>

/** Provider policy: one 100ms retry before any response, never an HTTP-status retry. */
export const PROVIDER_RETRY_POLICY = 'one_pre_response_network_retry_100ms_no_http_retry'
/** The gate itself never re-sends a parse. */
export const GATE_RETRY_POLICY = 'none'

/** Standard per-million-token prices cited from the Meta pricing page (docs/api-notes.md). Reasoning is inside output. */
export const STANDARD_PRICES_USD_PER_MILLION: Record<
    StandardModel,
    { input: number; cachedInput: number; output: number }
> = {
    'muse-spark-1.3': { input: 1.25, cachedInput: 0.15, output: 4.25 },
    'muse-wonder-1.0': { input: 4, cachedInput: 0.2, output: 20 },
}

/** Provider metric shape; the real provider's ProviderMetrics is structurally assignable to this. */
export interface AbMetric {
    operation: string
    model: string
    status: number
    latencyMs: number
    inputTokens?: number
    cachedTokens?: number
    outputTokens?: number
    reasoningTokens?: number
}
export interface AbSource {
    page: ManualPage
    bytes: Uint8Array
}
export interface AbParseProvider {
    parseManual(
        input: { requestId: string; binding: ManualBinding; pages: AbSource[] },
        signal: AbortSignal,
    ): Promise<ParsedManual>
}
export type AbProviderFactory = (options: {
    apiKey: string
    parseModel: StandardModel
    onMetrics: (metric: AbMetric) => void
}) => AbParseProvider

/**
 * Production wiring: the real provider with an explicit parseModel and no request-level model override.
 * fetchImpl is only injected by tests (for example the documented local mock); production uses global fetch.
 */
export function createMetaAbProviderFactory(fetchImpl?: typeof fetch): AbProviderFactory {
    return (options) =>
        createMetaProvider({
            apiKey: options.apiKey,
            parseModel: options.parseModel,
            onMetrics: options.onMetrics,
            ...(fetchImpl ? { fetchImpl } : {}),
        })
}
export const defaultProviderFactory: AbProviderFactory = createMetaAbProviderFactory()

export type CostResult = { status: 'priced'; costUsd: number } | { status: 'unverified' }
/** Priced only from actual uncached input, cached input and output counts; missing usage is unverified, never zero. */
export function costUsd(
    usage: Pick<AbMetric, 'inputTokens' | 'cachedTokens' | 'outputTokens'>,
    model: StandardModel,
): CostResult {
    const { inputTokens, cachedTokens, outputTokens } = usage
    if (inputTokens === undefined || cachedTokens === undefined || outputTokens === undefined)
        return { status: 'unverified' }
    if (cachedTokens > inputTokens) return { status: 'unverified' }
    const price = STANDARD_PRICES_USD_PER_MILLION[model]
    const total =
        (inputTokens - cachedTokens) * price.input + cachedTokens * price.cachedInput + outputTokens * price.output
    return { status: 'priced', costUsd: Math.round((total / 1_000_000) * 1e10) / 1e10 }
}

/** Fixed operator vocabulary: the report persists only these codes, never free text or model output. */
export const PLAN_QUALITY_ISSUES = [
    'orientation',
    'connection',
    'part_identity',
    'citation',
    'missing_step',
    'extra_step',
    'step_order',
    'unclear_wording',
    'other',
] as const
export type PlanQualityIssue = (typeof PLAN_QUALITY_ISSUES)[number]
export type PlanQualityRating = 1 | 2 | 3 | 4 | 5
export type PlanQuality =
    { status: 'operator_rated'; rating: PlanQualityRating; issues: PlanQualityIssue[] } | { status: 'unverified' }
export type QualityAnswer = { rating: PlanQualityRating; issues: PlanQualityIssue[] } | 'unverifiable'
export type QualityReviewer = (input: { expectedSteps: number }) => Promise<QualityAnswer>

/** Validates an operator's rating and issue codes; anything outside the vocabulary stays unverifiable. */
export function parseQualityAnswer(rating: string, issues: string): QualityAnswer {
    if (!/^[1-5]$/u.test(rating.trim())) return 'unverifiable'
    const codes =
        issues.trim() === '' || issues.trim().toLowerCase() === 'none'
            ? []
            : issues.split(',').map((code) => code.trim())
    const allowed = new Set<string>(PLAN_QUALITY_ISSUES)
    if (!codes.every((code) => allowed.has(code))) return 'unverifiable'
    const unique = [...new Set(codes)] as PlanQualityIssue[]
    return { rating: Number(rating.trim()) as PlanQualityRating, issues: unique }
}

export const terminalQualityReviewer: QualityReviewer = async () => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout })
    try {
        const rating = await terminal.question('Whole-plan quality 1 (poor) to 5 (excellent), or u if unverifiable: ')
        const issues = await terminal.question(
            `Issue codes, comma-separated from ${PLAN_QUALITY_ISSUES.join(', ')}, or none: `,
        )
        return parseQualityAnswer(rating, issues)
    } finally {
        terminal.close()
    }
}

export type AbArm = {
    model: StandardModel
    status: 'completed' | 'failed' | 'incomplete'
    reason: string
    /** HTTP responses observed through transport events, including the provider's own retries; the gate adds none. */
    attempts: number
    /** exact only when the arm completed: every dispatched attempt returned a response. A failed arm may hide a rejected fetch. */
    attemptsStatus: 'exact' | 'lower_bound'
    latencyMs: number
    inputTokens?: number
    cachedTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    costStatus: CostResult['status']
    costUsd?: number
    provenance?: 'result_field' | 'dispatch_metrics'
    structuralMatchPercent?: number
    semanticStepAccuracy: 'unverified' | 'human_reviewed'
    humanStepAccuracyPercent?: number
    correctSteps?: number
    incorrectSteps?: number
    unverifiableSteps?: number
    missingSteps?: number
    extraSteps?: number
    extractionUnknowns?: number
    quality: PlanQuality
}
export type Conclusion = 'wonderClearlyWins' | 'sparkClearlyWins' | 'no_clear_win' | 'unverified'
export type AbReport = {
    gate: '1b'
    status: 'pass' | 'unverified'
    reason: string
    conclusion: Conclusion
    wonderClearlyWins: boolean
    comparisonSummary: string
    conclusionScope: 'single_manual_single_run'
    automaticFallback: 'none'
    defaultChange: 'none'
    recommendation: 'keep_spark_default'
    providerRetryPolicy: typeof PROVIDER_RETRY_POLICY
    gateRetryPolicy: typeof GATE_RETRY_POLICY
    requests: number
    requestsStatus: 'exact' | 'lower_bound'
    models: Partial<Record<'spark' | 'wonder', AbArm>>
}

const PROVIDER_REASONS = [
    'timeout',
    'provider_error',
    'invalid_output',
    'invalid_input',
    'unconfigured',
    'provider_dependency_unavailable',
]

/** Maps failures to a fixed safe vocabulary; raw provider text and bodies never reach the report. */
function failureReason(error: unknown): string {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout'
    const message = error instanceof Error ? error.message : ''
    return PROVIDER_REASONS.includes(message) ? message : 'provider_error'
}

async function parseArm(
    model: StandardModel,
    input: { factory: AbProviderFactory; apiKey: string; sources: AbSource[] },
): Promise<{ arm: AbArm; parsed?: ParsedManual }> {
    const metrics: AbMetric[] = []
    let parsed: ParsedManual | undefined
    let failure: string | undefined
    const started = performance.now()
    try {
        const provider = input.factory({
            apiKey: input.apiKey,
            parseModel: model,
            onMetrics: (metric) => metrics.push(metric),
        })
        parsed = await provider.parseManual(
            {
                requestId: randomUUID(),
                binding: { kind: 'manual', manualId: randomUUID(), revision: 1 },
                pages: input.sources,
            },
            // Both arms, including Wonder, are bound by the provider's existing 30 s parse deadline.
            new AbortController().signal,
        )
    } catch (error: unknown) {
        failure = failureReason(error)
    }
    const latencyMs = Math.round(performance.now() - started)
    // The provider's transport callback reports one status per HTTP response. Its usage callback spreads every usage
    // key (values may be undefined when the response had no usage), so key ownership separates the two kinds of event.
    const isUsageEvent = (metric: AbMetric): boolean => 'inputTokens' in metric
    const attempts = metrics.filter((metric) => !isUsageEvent(metric)).length
    const usageEvents = metrics.filter(isUsageEvent)
    const usage = usageEvents.length === 1 ? usageEvents[0]! : undefined
    const cost = costUsd(usage ?? {}, model)
    const base = {
        model,
        attempts,
        attemptsStatus: 'lower_bound' as const,
        latencyMs,
        costStatus: cost.status,
        ...(cost.status === 'priced' ? { costUsd: cost.costUsd } : {}),
        ...(usage
            ? {
                  inputTokens: usage.inputTokens,
                  cachedTokens: usage.cachedTokens,
                  outputTokens: usage.outputTokens,
                  reasoningTokens: usage.reasoningTokens,
              }
            : {}),
        semanticStepAccuracy: 'unverified' as const,
        quality: { status: 'unverified' as const },
    }
    // Attribution is the requested model; any other dispatch or result provenance makes the arm incomplete, never substituted.
    const dispatchMismatch = metrics.some((metric) => metric.model !== model)
    const resultMismatch = parsed?.model !== undefined && parsed.model !== model
    if (dispatchMismatch || resultMismatch) {
        return { arm: { ...base, status: 'incomplete', reason: 'model_attribution_mismatch' } }
    }
    if (failure !== undefined) {
        return { arm: { ...base, status: 'failed', reason: failure } }
    }
    if (!parsed || metrics.length === 0) {
        return { arm: { ...base, status: 'incomplete', reason: 'model_dispatch_unattributed' } }
    }
    return {
        arm: {
            ...base,
            status: 'completed',
            reason: 'parse_completed',
            attemptsStatus: 'exact',
            provenance: parsed.model === model ? 'result_field' : 'dispatch_metrics',
        },
        parsed,
    }
}

function score(arm: AbArm, parsed: ParsedManual, expected: Manifest['expected']): Summary {
    const summary: Summary = { gate: 1, status: 'unverified', reason: 'not_completed', requests: 0, latenciesMs: [] }
    Object.assign(summary, scoreExtraction(parsed, expected))
    summary.strictStructuralMatchPercent = expected.steps.length
        ? Math.round((10_000 * summary.structurallyMatchedSteps!) / expected.steps.length) / 100
        : 0
    arm.structuralMatchPercent = summary.strictStructuralMatchPercent
    return summary
}

function copyReview(arm: AbArm, summary: Summary): void {
    arm.semanticStepAccuracy = summary.semanticStepAccuracy === 'human_reviewed' ? 'human_reviewed' : 'unverified'
    arm.humanStepAccuracyPercent = summary.humanStepAccuracyPercent
    arm.correctSteps = summary.correctSteps
    arm.incorrectSteps = summary.incorrectSteps
    arm.unverifiableSteps = summary.unverifiableSteps
    arm.missingSteps = summary.missingSteps
    arm.extraSteps = summary.extraSteps
    arm.extractionUnknowns = summary.extractionUnknowns
}

const MIN_CLEAR_WIN_STEP_DIFFERENCE = 2
const MIN_CLEAR_WIN_RATING_DIFFERENCE = 1

/** Complete human review and both raw-count margins must favour the same model. */
export function conclude(arms: Partial<Record<'spark' | 'wonder', AbArm>>): {
    conclusion: Conclusion
    wonderClearlyWins: boolean
} {
    const { spark, wonder } = arms
    const complete = [spark, wonder].every(
        (arm) =>
            arm?.status === 'completed' &&
            arm.semanticStepAccuracy === 'human_reviewed' &&
            arm.quality.status === 'operator_rated',
    )
    if (!spark || !wonder || !complete) return { conclusion: 'unverified', wonderClearlyWins: false }
    if (spark.quality.status !== 'operator_rated' || wonder.quality.status !== 'operator_rated')
        return { conclusion: 'unverified', wonderClearlyWins: false }
    if (spark.correctSteps === undefined || wonder.correctSteps === undefined)
        return { conclusion: 'unverified', wonderClearlyWins: false }
    const steps = wonder.correctSteps - spark.correctSteps
    const rating = wonder.quality.rating - spark.quality.rating
    if (
        Math.abs(steps) < MIN_CLEAR_WIN_STEP_DIFFERENCE ||
        Math.abs(rating) < MIN_CLEAR_WIN_RATING_DIFFERENCE ||
        Math.sign(steps) !== Math.sign(rating)
    )
        return { conclusion: 'no_clear_win', wonderClearlyWins: false }
    return steps > 0
        ? { conclusion: 'wonderClearlyWins', wonderClearlyWins: true }
        : { conclusion: 'sparkClearlyWins', wonderClearlyWins: false }
}

function comparisonSummary(arms: AbReport['models'], conclusion: Conclusion): string {
    const { spark, wonder } = arms
    const n = spark?.status === 'completed' && wonder?.status === 'completed' ? 1 : 0
    const result =
        conclusion === 'wonderClearlyWins' || conclusion === 'sparkClearlyWins' ? 'margin met' : 'inconclusive'
    const rating = (arm: AbArm | undefined): number | 'unverified' =>
        arm?.quality.status === 'operator_rated' ? arm.quality.rating : 'unverified'
    return `n=${n}, ${result}; correct steps: Spark ${spark?.correctSteps ?? 'unverified'}, Wonder ${wonder?.correctSteps ?? 'unverified'}; quality ratings: Spark ${rating(spark)}, Wonder ${rating(wonder)}`
}

export async function runAbGate(input: {
    manifest: Manifest
    cwd: string
    apiKey: string
    factory: AbProviderFactory
    reviewer?: StepReviewer
    qualityReviewer?: QualityReviewer
    /** true starts with Wonder; injected so tests can pin the randomized order. */
    random?: () => boolean
}): Promise<AbReport> {
    const sources = (await loadManualSources(input.manifest, input.cwd)).map((source) => ({
        page: source.metadata,
        bytes: source.data,
    }))
    const order: StandardModel[] = (input.random ?? ((): boolean => randomInt(2) === 1))()
        ? [GATE_1B_MODELS.wonder, GATE_1B_MODELS.spark]
        : [GATE_1B_MODELS.spark, GATE_1B_MODELS.wonder]
    const arms: Partial<Record<'spark' | 'wonder', AbArm>> = {}
    const parsedByKey: Partial<Record<'spark' | 'wonder', ParsedManual>> = {}
    for (const model of order) {
        const { arm, parsed } = await parseArm(model, { factory: input.factory, apiKey: input.apiKey, sources })
        arms[ARM_KEYS[model]] = arm
        if (parsed) parsedByKey[ARM_KEYS[model]] = parsed
    }
    for (const model of order) {
        const key = ARM_KEYS[model]
        const arm = arms[key]!
        const parsed = parsedByKey[key]
        if (arm.status !== 'completed' || !parsed) continue
        const summary = score(arm, parsed, input.manifest.expected)
        try {
            if (input.reviewer) {
                await reviewExtraction(parsed, input.manifest.expected, input.reviewer, summary)
                copyReview(arm, summary)
            }
            if (input.qualityReviewer) {
                const answer = await input.qualityReviewer({ expectedSteps: input.manifest.expected.steps.length })
                arm.quality =
                    answer === 'unverifiable'
                        ? { status: 'unverified' }
                        : { status: 'operator_rated', rating: answer.rating, issues: answer.issues }
            }
        } catch {
            // Both paid parses have completed. Preserve their evidence when operator review cannot finish.
            arm.reason = 'operator_review_incomplete'
            arm.quality = { status: 'unverified' }
            break
        }
    }
    const complete = Object.values(arms).every((arm) => arm?.status === 'completed')
    const stepReviewed = Object.values(arms).every((arm) => arm?.semanticStepAccuracy === 'human_reviewed')
    const rated = Object.values(arms).every((arm) => arm?.quality.status === 'operator_rated')
    const { conclusion, wonderClearlyWins } = conclude(arms)
    return {
        gate: '1b',
        status: complete && stepReviewed && rated ? 'pass' : 'unverified',
        reason: !complete
            ? 'arm_incomplete_no_fallback'
            : !stepReviewed
              ? 'semantic_review_unverified'
              : !rated
                ? 'plan_quality_unverified'
                : 'ab_human_reviewed',
        conclusion,
        wonderClearlyWins,
        comparisonSummary: comparisonSummary(arms, conclusion),
        conclusionScope: 'single_manual_single_run',
        automaticFallback: 'none',
        defaultChange: 'none',
        recommendation: 'keep_spark_default',
        providerRetryPolicy: PROVIDER_RETRY_POLICY,
        gateRetryPolicy: GATE_RETRY_POLICY,
        requests: Object.values(arms).reduce((total, arm) => total + (arm?.attempts ?? 0), 0),
        requestsStatus: Object.values(arms).every((arm) => arm?.attemptsStatus === 'exact') ? 'exact' : 'lower_bound',
        models: arms,
    }
}

const REFUSALS = [
    'operator_dispatch_required',
    'ab_consent_required',
    'critical_facts_confirmation_required',
    'interactive_gate1_review_required',
    'local_key_required',
    'meta_mode_required',
    'manifest_required',
]

function refusal(reason: string): AbReport {
    return {
        gate: '1b',
        status: 'unverified',
        reason,
        conclusion: 'unverified',
        wonderClearlyWins: false,
        comparisonSummary: comparisonSummary({}, 'unverified'),
        conclusionScope: 'single_manual_single_run',
        automaticFallback: 'none',
        defaultChange: 'none',
        recommendation: 'keep_spark_default',
        providerRetryPolicy: PROVIDER_RETRY_POLICY,
        gateRetryPolicy: GATE_RETRY_POLICY,
        requests: 0,
        requestsStatus: 'exact',
        models: {},
    }
}

/**
 * Local readiness is read only after both explicit flags are present. The key is returned to the caller for the
 * provider's bearer header only; it is never printed or written to the report.
 */
export async function loadAbKey(cwd: string): Promise<string> {
    let env: Record<string, string | undefined>
    try {
        env = parseEnv(await readFile(resolve(cwd, '.env'), 'utf8'))
    } catch {
        throw new Error('local_key_required')
    }
    if (env.PROVIDER_MODE !== 'meta') throw new Error('meta_mode_required')
    const key = env.MODEL_API_KEY?.trim()
    if (!key) throw new Error('local_key_required')
    return key
}

export async function abMain(
    argv: string[],
    cwd = process.cwd(),
    deps: {
        factory?: AbProviderFactory
        random?: () => boolean
        interactive?: boolean
        reviewer?: StepReviewer
        qualityReviewer?: QualityReviewer
    } = {},
): Promise<number> {
    const option = (name: string): string | undefined => {
        const index = argv.indexOf(name)
        return index < 0 ? undefined : argv[index + 1]
    }
    let report: AbReport
    try {
        if (!argv.includes('--dispatch')) throw new Error('operator_dispatch_required')
        if (!argv.includes('--ab')) throw new Error('ab_consent_required')
        if (!argv.includes('--confirm-critical-facts')) throw new Error('critical_facts_confirmation_required')
        const interactive = deps.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY))
        const review = argv.includes('--review')
        if (review && !interactive) throw new Error('interactive_gate1_review_required')
        const apiKey = await loadAbKey(cwd)
        const manifestPath = option('--manifest')
        if (!manifestPath) throw new Error('manifest_required')
        const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(cwd, manifestPath), 'utf8')))
        report = await runAbGate({
            manifest,
            cwd,
            apiKey,
            factory: deps.factory ?? defaultProviderFactory,
            reviewer: review ? (deps.reviewer ?? terminalReviewer) : undefined,
            qualityReviewer: review ? (deps.qualityReviewer ?? terminalQualityReviewer) : undefined,
            random: deps.random,
        })
    } catch (error: unknown) {
        const reason = error instanceof Error && REFUSALS.includes(error.message) ? error.message : 'input_refused'
        report = refusal(reason)
    }
    console.log(await appendAggregate(cwd, report))
    return report.status === 'pass' ? 0 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    abMain(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code
        })
        .catch(() => {
            console.log('Gate 1b unverified: local execution failed.')
            process.exitCode = 2
        })
}
