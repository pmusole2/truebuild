import { randomInt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { ManualBinding, ManualPage, ParsedManual, StandardModel } from '@truebuild/contracts'
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
 * Each arm is keyed by the parseModel it requested. Nothing here retries, falls back or substitutes a model.
 */
export const GATE_1B_MODELS = {
    spark: 'muse-spark-1.3',
    wonder: 'muse-wonder-1.0',
} as const satisfies Record<string, StandardModel>
const ARM_KEYS = { 'muse-spark-1.3': 'spark', 'muse-wonder-1.0': 'wonder' } as const satisfies Record<
    StandardModel,
    'spark' | 'wonder'
>

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
 * Production factory is intentionally not wired in this base: createMetaProvider here has no parseModel option.
 * It refuses every arm rather than falling back to a different model or the check model.
 */
export const defaultProviderFactory: AbProviderFactory = () => {
    throw new Error('provider_dependency_unavailable')
}

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

export type AbArm = {
    model: StandardModel
    status: 'completed' | 'failed' | 'incomplete'
    reason: string
    attempts: number
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
}
export type AbReport = {
    gate: '1b'
    status: 'pass' | 'unverified'
    reason: string
    automaticFallback: 'none'
    defaultChange: 'none'
    recommendation: 'keep_spark_default'
    winner: StandardModel | 'no_measured_difference' | 'unverified'
    winnerScope: 'single_manual_single_run'
    requests: number
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
            AbortSignal.timeout(45_000),
        )
    } catch (error: unknown) {
        failure = failureReason(error)
    }
    const latencyMs = Math.round(performance.now() - started)
    // Transport events carry no usage; the single usage-bearing event prices the request.
    const attempts = metrics.filter((metric) => metric.inputTokens === undefined).length
    const usageEvents = metrics.filter((metric) => metric.inputTokens !== undefined)
    const usage = usageEvents.length === 1 ? usageEvents[0]! : undefined
    const cost = costUsd(usage ?? {}, model)
    const base = {
        model,
        attempts,
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
    if (!parsed) return { arm: { ...base, status: 'incomplete', reason: 'model_dispatch_unattributed' } }
    if (metrics.length === 0) return { arm: { ...base, status: 'incomplete', reason: 'model_dispatch_unattributed' } }
    return {
        arm: {
            ...base,
            status: 'completed',
            reason: 'parse_completed',
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

function winnerOf(arms: Partial<Record<'spark' | 'wonder', AbArm>>): AbReport['winner'] {
    const { spark, wonder } = arms
    if (!spark || !wonder) return 'unverified'
    if (spark.status !== 'completed' || wonder.status !== 'completed') return 'unverified'
    if (spark.semanticStepAccuracy !== 'human_reviewed' || wonder.semanticStepAccuracy !== 'human_reviewed')
        return 'unverified'
    const a = spark.humanStepAccuracyPercent ?? 0
    const b = wonder.humanStepAccuracyPercent ?? 0
    if (a === b) return 'no_measured_difference'
    return a > b ? GATE_1B_MODELS.spark : GATE_1B_MODELS.wonder
}

export async function runAbGate(input: {
    manifest: Manifest
    cwd: string
    apiKey: string
    factory: AbProviderFactory
    reviewer?: StepReviewer
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
        if (input.reviewer) {
            await reviewExtraction(parsed, input.manifest.expected, input.reviewer, summary)
            copyReview(arm, summary)
        }
    }
    const complete = Object.values(arms).every((arm) => arm?.status === 'completed')
    const reviewed = Object.values(arms).every((arm) => arm?.semanticStepAccuracy === 'human_reviewed')
    return {
        gate: '1b',
        status: complete && reviewed ? 'pass' : 'unverified',
        reason: !complete
            ? 'arm_incomplete_no_fallback'
            : reviewed
              ? 'ab_human_reviewed'
              : 'semantic_review_unverified',
        automaticFallback: 'none',
        defaultChange: 'none',
        recommendation: 'keep_spark_default',
        winner: winnerOf(arms),
        winnerScope: 'single_manual_single_run',
        requests: Object.values(arms).reduce((total, arm) => total + (arm?.attempts ?? 0), 0),
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
        automaticFallback: 'none',
        defaultChange: 'none',
        recommendation: 'keep_spark_default',
        winner: 'unverified',
        winnerScope: 'single_manual_single_run',
        requests: 0,
        models: {},
    }
}

/** Local readiness is read only after both explicit flags are present; the key is never printed or sent by this CLI. */
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
    deps: { factory?: AbProviderFactory; random?: () => boolean; interactive?: boolean } = {},
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
        if (argv.includes('--review') && !interactive) throw new Error('interactive_gate1_review_required')
        const apiKey = await loadAbKey(cwd)
        const manifestPath = option('--manifest')
        if (!manifestPath) throw new Error('manifest_required')
        const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(cwd, manifestPath), 'utf8')))
        report = await runAbGate({
            manifest,
            cwd,
            apiKey,
            factory: deps.factory ?? defaultProviderFactory,
            reviewer: argv.includes('--review') ? terminalReviewer : undefined,
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
