import { describe, expect, it } from 'vitest'

import { aiPolicyFromEnvironment, describeAiPolicy, generativeUiMode, POLICY_STAGES } from './ai-policy'
import { createRuntimeFromEnvironment } from './model-runtime'

const defaults = {
    checkTimeoutMs: 8_000,
    parseModel: 'muse-spark-1.3' as const,
    verdictModel: 'muse-spark-1.3' as const,
    secondOpinionModel: 'muse-wonder-1.0' as const,
}

describe('AI policy', (): void => {
    it('defaults measured stages to their selected efforts and keeps the verdict provisional', (): void => {
        const { stages } = aiPolicyFromEnvironment({}, defaults)
        for (const stage of POLICY_STAGES) {
            expect(stages[stage].effort).toBe(
                stage === 'verdict' || stage === 'screens'
                    ? 'low'
                    : ['parse', 'step-pages', 'overlay'].includes(stage)
                      ? 'medium'
                      : 'max',
            )
        }
        expect(stages.verdict.provisional).toBe(true)
        expect(POLICY_STAGES.filter((stage) => stages[stage].provisional)).toEqual(['verdict'])
        expect(stages.verdict).toMatchObject({ maxOutputTokens: 2_500, deadlineMs: 8_000 })
        expect(stages.questions.deadlineMs).toBe(60_000)
        expect(stages['step-pages'].model).toBe('muse-wonder-1.0')
        expect(stages.screens).toMatchObject({
            model: 'muse-spark-1.3',
            deadlineMs: 30_000,
            quickCheckEffort: 'medium',
        })
        expect(stages.overlay.model).toBe('muse-wonder-1.0')
    })

    it('exposes the 8k document cap while keeping the 48k geometry stage cap', (): void => {
        const policy = aiPolicyFromEnvironment({}, defaults)
        expect(policy.stages['step-pages'].maxOutputTokens).toBe(48_000)
        expect(describeAiPolicy(policy)).toMatchObject({
            stages: { 'step-pages': { maxOutputTokens: 48_000, documentMaxOutputTokens: 8_000 } },
        })
    })

    it('raises output headroom on the long stages without claiming a provider maximum', (): void => {
        const { stages } = aiPolicyFromEnvironment({}, defaults)
        expect(stages.parse.maxOutputTokens).toBeGreaterThan(24_000)
        expect(stages['second-opinion'].maxOutputTokens).toBeGreaterThan(16_000)
        for (const stage of ['screens', 'step-pages', 'overlay', 'questions'] as const) {
            expect(stages[stage].maxOutputTokens).toBeGreaterThan(1_500)
        }
    })

    it('lets an operator change effort, headroom, deadline and model per stage', (): void => {
        const { stages } = aiPolicyFromEnvironment(
            {
                AI_EFFORT_VERDICT: 'medium',
                AI_EFFORT_STEP_PAGES: 'xhigh',
                AI_EFFORT_SCREENS: 'high',
                AI_MAX_OUTPUT_PARSE: '64000',
                AI_DEADLINE_QUESTIONS_MS: '90000',
                AI_MODEL_SCREENS: 'muse-wonder-1.0',
            },
            defaults,
        )
        // An operator setting is a configuration, not a measurement: it never clears the provisional flag.
        expect(stages.verdict).toMatchObject({ effort: 'medium', provisional: true, measurementId: null })
        expect(stages['step-pages'].effort).toBe('xhigh')
        expect(stages.parse.maxOutputTokens).toBe(64_000)
        expect(stages.questions.deadlineMs).toBe(90_000)
        expect(stages.screens).toMatchObject({ model: 'muse-wonder-1.0', effort: 'high', quickCheckEffort: 'high' })
    })

    it('keeps an operator measurement reference separate from verified latency evidence', (): void => {
        const { stages } = aiPolicyFromEnvironment(
            { AI_EFFORT_VERDICT: 'high', AI_MEASUREMENT_VERDICT: 'live-run-2026-10-30' },
            defaults,
        )
        expect(stages.verdict).toMatchObject({
            effort: 'high',
            provisional: true,
            measurementId: 'live-run-2026-10-30',
        })
        expect(POLICY_STAGES.filter((stage) => stages[stage].provisional)).toEqual(['verdict'])
        for (const measurement of ['has space', '-leading', 'x'.repeat(65), 'quote"']) {
            expect(() => aiPolicyFromEnvironment({ AI_MEASUREMENT_VERDICT: measurement }, defaults)).toThrow(
                'invalid_ai_measurement',
            )
        }
    })

    it('honors the documented parse deadline and reports the budgets that are actually executed', (): void => {
        expect(aiPolicyFromEnvironment({}, defaults).stages.parse.deadlineMs).toBe(165_000)
        const { stages } = aiPolicyFromEnvironment({ AI_DEADLINE_PARSE_MS: '60000' }, defaults)
        expect(stages.parse.deadlineMs).toBe(60_000)
        const described = describeAiPolicy(aiPolicyFromEnvironment({ AI_DEADLINE_PARSE_MS: '60000' }, defaults)) as {
            stages: { parse: { budget: Record<string, number> } }
        }
        // Every page count shares the configured overall budget; a repair needs at least 20 s plus return margin.
        expect(described.stages.parse.budget).toEqual({
            overallMs: 60_000,
            routeMs: 65_000,
            firstAttemptMinMs: 59_000,
            firstAttemptMaxMs: 59_000,
            repairMs: 40_000,
            minimumRepairMs: 20_000,
            clientMinimumMs: 65_000,
        })
        // Parse alone has a 165 s overall ceiling and a separate route return margin.
        for (const value of ['165001', '999', '1e5', 'abc']) {
            expect(() => aiPolicyFromEnvironment({ AI_DEADLINE_PARSE_MS: value }, defaults)).toThrow(
                'invalid_ai_deadline',
            )
        }
    })

    it('accepts AI_DEADLINE_VERDICT_MS only as an alias that agrees with the verdict deadline, and rejects bad values', (): void => {
        expect(aiPolicyFromEnvironment({ AI_DEADLINE_VERDICT_MS: '8000' }, defaults).stages.verdict.deadlineMs).toBe(
            8_000,
        )
        expect(() => aiPolicyFromEnvironment({ AI_DEADLINE_VERDICT_MS: '9000' }, defaults)).toThrow(
            'conflicting_verdict_deadline',
        )
        for (const value of ['0', '105001', '12.5', 'soon']) {
            expect(() => aiPolicyFromEnvironment({ AI_DEADLINE_VERDICT_MS: value }, defaults)).toThrow(
                'invalid_ai_deadline',
            )
        }
    })

    it.each([
        { AI_EFFORT_PARSE: 'none' },
        { AI_EFFORT_PARSE: 'MAX' },
        { AI_MAX_OUTPUT_OVERLAY: '15' },
        { AI_MAX_OUTPUT_OVERLAY: '2000000' },
        { AI_DEADLINE_SCREENS_MS: '999' },
        { AI_DEADLINE_SCREENS_MS: '105001' },
        { AI_MODEL_VERDICT: 'muse-wonder-1.0' },
        { AI_MODEL_SCREENS: 'muse-spark-1.3-contributor' },
        { GENERATIVE_UI: 'on' },
    ])('refuses the invalid setting %j', (environment): void => {
        expect(() => aiPolicyFromEnvironment(environment, defaults)).toThrow()
    })

    it('reads GENERATIVE_UI as full by default, steps or off', (): void => {
        expect(generativeUiMode(undefined)).toBe('full')
        expect(generativeUiMode('')).toBe('full')
        expect(generativeUiMode('steps')).toBe('steps')
        expect(generativeUiMode('off')).toBe('off')
    })

    it('summarizes the policy without any secret', (): void => {
        const summary = JSON.stringify(describeAiPolicy(aiPolicyFromEnvironment({}, defaults)))
        expect(summary).toContain('"provisional":true')
        expect(summary).not.toMatch(/api[_-]?key|secret|bearer/iu)
    })
})

describe('runtime policy wiring', (): void => {
    it('uses daily call ceilings and accepts a verdict deadline beyond eight seconds', (): void => {
        const runtime = createRuntimeFromEnvironment({ CHECK_TIMEOUT_MS: '20000' })
        expect(runtime.counter.limit).toBe(1_500)
        expect(createRuntimeFromEnvironment({}).policy.stages.verdict.deadlineMs).toBe(12_000)
        expect(runtime.policy.stages.verdict.deadlineMs).toBe(20_000)
        expect(createRuntimeFromEnvironment({ MODEL_CALL_LIMIT: '8' }).counter.limit).toBe(1_500)
        expect(createRuntimeFromEnvironment({ MODEL_CALL_LIMIT_PER_DAY: '5' }).counter.limit).toBe(5)
    })

    it('resolves the verdict deadline from CHECK_TIMEOUT_MS or its alias and rejects disagreement or invalid values', (): void => {
        expect(createRuntimeFromEnvironment({ AI_DEADLINE_VERDICT_MS: '12000' }).policy.stages.verdict.deadlineMs).toBe(
            12_000,
        )
        expect(
            createRuntimeFromEnvironment({ CHECK_TIMEOUT_MS: '12000', AI_DEADLINE_VERDICT_MS: '12000' }).policy.stages
                .verdict.deadlineMs,
        ).toBe(12_000)
        expect(() =>
            createRuntimeFromEnvironment({ CHECK_TIMEOUT_MS: '12000', AI_DEADLINE_VERDICT_MS: '9000' }),
        ).toThrow('conflicting_verdict_deadline')
        expect(() => createRuntimeFromEnvironment({ AI_DEADLINE_VERDICT_MS: '0' })).toThrow()
        expect(() => createRuntimeFromEnvironment({ AI_DEADLINE_PARSE_MS: '1' })).toThrow('invalid_ai_deadline')
        expect(createRuntimeFromEnvironment({ AI_DEADLINE_PARSE_MS: '70000' }).policy.stages.parse.deadlineMs).toBe(
            70_000,
        )
    })

    it('validates the concurrency reserve and background worker bound', (): void => {
        expect(() =>
            createRuntimeFromEnvironment({ MODEL_MAX_CONCURRENCY: '4', MODEL_FOREGROUND_RESERVE: '4' }),
        ).toThrow()
        expect(() => createRuntimeFromEnvironment({ SCREEN_PRECOMPUTE_CONCURRENCY: '0' })).toThrow()
        expect(() => createRuntimeFromEnvironment({ SCREEN_PRECOMPUTE_CONCURRENCY: '17' })).toThrow()
        expect(() =>
            createRuntimeFromEnvironment({ MODEL_MAX_CONCURRENCY: '4', MODEL_FOREGROUND_RESERVE: '1' }),
        ).not.toThrow()
    })

    it('defaults the stronger second opinion to Wonder and lets an operator turn it off', (): void => {
        expect(createRuntimeFromEnvironment({}).secondOpinionModel).toBe('muse-wonder-1.0')
        expect(createRuntimeFromEnvironment({ MODEL_SECOND_OPINION: 'off' }).secondOpinionModel).toBeUndefined()
    })

    it('turns follow-up offers off together with GENERATIVE_UI=off', (): void => {
        const on = createRuntimeFromEnvironment({})
        expect([on.overlay, on.segments]).toEqual([true, true])
        const off = createRuntimeFromEnvironment({ GENERATIVE_UI: 'off' })
        expect([off.overlay, off.segments]).toEqual([false, false])
        expect(createRuntimeFromEnvironment({ MODEL_SEGMENTS: '0' }).segments).toBe(false)
    })
})
