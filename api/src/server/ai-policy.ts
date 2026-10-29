import { PARSE_DEFAULT_OVERALL_MS, PARSE_ROUTE_MARGIN_MS, describeParseBudget } from './parse-budget'
import {
    AI_EFFORTS,
    aiEffortSchema,
    standardModelSchema,
    type AiEffort,
    type StandardModel,
} from '@truebuild/contracts'

/**
 * Per-stage model policy. This is a general quality/latency policy, independent of the UI mode (GENERATIVE_UI).
 * Efforts are the documented Responses values; `max` is the default everywhere except the latency-critical verdict,
 * whose `low` is PROVISIONAL: no paid measurement chose it. Output caps are application choices, not provider maxima.
 * `max_output_tokens` includes reasoning tokens, so a higher effort needs more headroom and a cap never guarantees
 * that output is complete: an incomplete response is reported as unavailable and falls back, never repaired as valid.
 */
export const POLICY_STAGES = [
    'parse',
    'screens',
    'step-pages',
    'verdict',
    'overlay',
    'second-opinion',
    'questions',
] as const
export type PolicyStage = (typeof POLICY_STAGES)[number]

export interface StagePolicy {
    effort: AiEffort
    maxOutputTokens: number
    /**
     * Absolute deadline. For `parse` this is the overall budget (first attempt plus at most one repair; the route
     * adds `PARSE_ROUTE_MARGIN_MS`); for `verdict` it is CHECK_TIMEOUT_MS; elsewhere it is the per-attempt deadline.
     */
    deadlineMs: number
    /** Model for stages that choose one; parse/verdict/second-opinion models keep their own env settings. */
    model: StandardModel
    /**
     * The verdict remains provisional until latency/quality evidence is actually verified. Environment settings and
     * an operator-supplied record reference are configuration, so neither can establish that verification here.
     */
    provisional: boolean
    /** Operator-asserted id of the measurement record that justifies this stage's settings; the server cannot verify it. */
    measurementId: string | null
}

export type GenerativeUiMode = 'full' | 'steps' | 'off'

export interface AiPolicy {
    stages: Readonly<Record<PolicyStage, StagePolicy>>
    generativeUi: GenerativeUiMode
}

/** Longest deadline `createDeadline` accepts. */
export const MAX_DEADLINE_MS = 105_000
/** The parse route adds this margin to the overall parse budget, so the budget itself stops below the route ceiling. */
const MAX_PARSE_BUDGET_MS = MAX_DEADLINE_MS - PARSE_ROUTE_MARGIN_MS
const MIN_OUTPUT_TOKENS = 16
/** Documented context window; an output cap above it is meaningless. Not a claim about the output maximum. */
const MAX_OUTPUT_TOKEN_SETTING = 1_048_576

type Environment = Readonly<Record<string, string | undefined>>

const SUFFIX: Record<PolicyStage, string> = {
    parse: 'PARSE',
    screens: 'SCREENS',
    'step-pages': 'STEP_PAGES',
    verdict: 'VERDICT',
    overlay: 'OVERLAY',
    'second-opinion': 'SECOND_OPINION',
    questions: 'QUESTIONS',
}

function integer(value: string | undefined, fallback: number, min: number, max: number, error: string): number {
    if (value === undefined || value === '') return fallback
    const number = Number(value)
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(error)
    return number
}

const MEASUREMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u

const MODEL_CHOOSING_STAGES: readonly PolicyStage[] = ['screens', 'step-pages', 'overlay']

function enumValue<T extends string>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    value: string | undefined,
    fallback: T,
    error: string,
): T {
    if (value === undefined || value === '') return fallback
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new Error(error)
    return parsed.data
}

export function generativeUiMode(value: string | undefined): GenerativeUiMode {
    if (value === undefined || value === '') return 'full'
    if (value === 'full' || value === 'steps' || value === 'off') return value
    throw new Error('invalid_generative_ui')
}

export interface PolicyDefaults {
    checkTimeoutMs: number
    parseModel: StandardModel
    verdictModel: StandardModel
    secondOpinionModel: StandardModel
}

/** Environment: AI_EFFORT_<STAGE>, AI_MAX_OUTPUT_<STAGE>, AI_DEADLINE_<STAGE>_MS, AI_MODEL_<SCREENS|STEP_PAGES|OVERLAY>. */
export function aiPolicyFromEnvironment(environment: Environment, defaults: PolicyDefaults): AiPolicy {
    const wonder: StandardModel = 'muse-wonder-1.0'
    const base: Record<PolicyStage, Omit<StagePolicy, 'provisional' | 'measurementId'>> = {
        parse: {
            effort: 'max',
            maxOutputTokens: 48_000,
            deadlineMs: PARSE_DEFAULT_OVERALL_MS,
            model: defaults.parseModel,
        },
        // Full documents include all state variants. Fixture wire sizes are measured locally; live token usage and
        // reasoning needs are not. These are quality headroom, not provider maxima or a guarantee of completeness.
        screens: { effort: 'max', maxOutputTokens: 32_000, deadlineMs: 20_000, model: defaults.verdictModel },
        'step-pages': { effort: 'max', maxOutputTokens: 48_000, deadlineMs: 45_000, model: wonder },
        verdict: {
            effort: 'low',
            maxOutputTokens: 1_500,
            deadlineMs: defaults.checkTimeoutMs,
            model: defaults.verdictModel,
        },
        overlay: { effort: 'max', maxOutputTokens: 32_000, deadlineMs: 60_000, model: wonder },
        'second-opinion': {
            effort: 'max',
            maxOutputTokens: 32_000,
            deadlineMs: 60_000,
            model: defaults.secondOpinionModel,
        },
        questions: { effort: 'max', maxOutputTokens: 32_000, deadlineMs: 60_000, model: defaults.verdictModel },
    }
    const stages = {} as Record<PolicyStage, StagePolicy>
    for (const stage of POLICY_STAGES) {
        const key = SUFFIX[stage]
        const effortValue = environment[`AI_EFFORT_${key}`]
        const effort = enumValue(aiEffortSchema, effortValue, base[stage].effort, 'invalid_ai_effort')
        const modelValue = environment[`AI_MODEL_${key}`]
        if (modelValue !== undefined && modelValue !== '' && !MODEL_CHOOSING_STAGES.includes(stage)) {
            throw new Error('invalid_ai_model')
        }
        const model = enumValue(standardModelSchema, modelValue, base[stage].model, 'invalid_ai_model')
        // The verdict deadline is CHECK_TIMEOUT_MS, resolved (with its AI_DEADLINE_VERDICT_MS alias) by the runtime and
        // passed in as `defaults.checkTimeoutMs`; an environment value given here must agree with it.
        const deadlineValue = environment[`AI_DEADLINE_${key}_MS`]
        if (stage === 'verdict' && deadlineValue !== undefined && deadlineValue !== '') {
            if (integer(deadlineValue, 0, 1, MAX_DEADLINE_MS, 'invalid_ai_deadline') !== defaults.checkTimeoutMs) {
                throw new Error('conflicting_verdict_deadline')
            }
        }
        const measurementValue = stage === 'verdict' ? environment.AI_MEASUREMENT_VERDICT : undefined
        if (measurementValue !== undefined && measurementValue !== '' && !MEASUREMENT_ID.test(measurementValue)) {
            throw new Error('invalid_ai_measurement')
        }
        const measurementId = measurementValue === undefined || measurementValue === '' ? null : measurementValue
        stages[stage] = {
            effort,
            model,
            maxOutputTokens: integer(
                environment[`AI_MAX_OUTPUT_${key}`],
                base[stage].maxOutputTokens,
                MIN_OUTPUT_TOKENS,
                MAX_OUTPUT_TOKEN_SETTING,
                'invalid_ai_max_output',
            ),
            deadlineMs:
                stage === 'verdict'
                    ? base.verdict.deadlineMs
                    : integer(
                          deadlineValue,
                          base[stage].deadlineMs,
                          1_000,
                          stage === 'parse' ? MAX_PARSE_BUDGET_MS : MAX_DEADLINE_MS,
                          'invalid_ai_deadline',
                      ),
            // A reference is useful for an operator's report, but this process has not verified its measurements.
            provisional: stage === 'verdict',
            measurementId,
        }
    }
    return { stages, generativeUi: generativeUiMode(environment.GENERATIVE_UI) }
}

/** Public, secret-free summary for `/api/session`. */
export function describeAiPolicy(policy: AiPolicy): Record<string, unknown> {
    return {
        generativeUi: policy.generativeUi,
        efforts: AI_EFFORTS,
        stages: Object.fromEntries(
            POLICY_STAGES.map((stage) => {
                const { effort, maxOutputTokens, deadlineMs, model, provisional, measurementId } = policy.stages[stage]
                return [
                    stage,
                    {
                        effort,
                        maxOutputTokens,
                        deadlineMs,
                        model,
                        provisional,
                        measurementId,
                        ...(stage === 'parse' ? { budget: describeParseBudget(deadlineMs) } : {}),
                    },
                ]
            }),
        ),
    }
}
