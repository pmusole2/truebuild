import { describe, expect, it, vi } from 'vitest'

import { createRuntimeFromEnvironment } from './model-runtime'

describe('provider runtime configuration', (): void => {
    it.each(['fixture'])('never reads the model key in %s mode', (mode): void => {
        const outbound = vi.fn<typeof fetch>()
        let keyReads = 0
        const runtime = createRuntimeFromEnvironment(
            {
                PROVIDER_MODE: mode,
                get MODEL_API_KEY(): string {
                    keyReads += 1
                    throw new Error('unexpected_key_read')
                },
            },
            outbound,
        )
        expect(runtime.mode).toBe('fixture')
        expect(runtime.configured).toBe(false)
        expect(keyReads).toBe(0)
        expect(outbound).not.toHaveBeenCalled()
    })

    it('fails closed for invalid mode, counter, or deadline configuration', (): void => {
        for (const env of [
            { PROVIDER_MODE: 'unknown' },
            { MODEL_CHECK_CONTEXT: 'automatic' },
            { MODEL_CALL_LIMIT_PER_DAY: '0' },
            { STEP_MOTION_ENABLED: 'false' },
            { STEP_MOTION_DAILY_LIMIT: '0' },
            { MODEL_CALL_LIMIT_PER_CLIENT_DAY: '2.5' },
            { CHECK_TIMEOUT_MS: '0' },
            { CHECK_TIMEOUT_MS: '105001' },
            { GENERATIVE_UI: 'partial' },
            { AI_EFFORT_PARSE: 'none' },
            { AI_EFFORT_SCREENS: 'ultra' },
            { AI_MAX_OUTPUT_QUESTIONS: '8' },
            { AI_DEADLINE_OVERLAY_MS: '500' },
            { AI_MODEL_VERDICT: 'muse-wonder-1.0' },
        ]) {
            expect(() => createRuntimeFromEnvironment(env)).toThrow()
        }
    })

    it('defaults motion on with a daily cap and accepts the explicit off switch', () => {
        const defaults = createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture' })
        expect(defaults.stepMotionEnabled).toBe(true)
        expect(defaults.stepMotionDailyLimit).toBe(300)
        const disabled = createRuntimeFromEnvironment({
            PROVIDER_MODE: 'fixture',
            STEP_MOTION_ENABLED: '0',
            STEP_MOTION_DAILY_LIMIT: '17',
        })
        expect(disabled.stepMotionEnabled).toBe(false)
        expect(disabled.stepMotionDailyLimit).toBe(17)
    })

    it('does not dispatch while starting an unconfigured meta runtime', (): void => {
        const outbound = vi.fn<typeof fetch>()
        const runtime = createRuntimeFromEnvironment({ PROVIDER_MODE: 'meta' }, outbound)
        expect(runtime.configured).toBe(false)
        expect(outbound).not.toHaveBeenCalled()
    })
})

it('defaults to meta and rejects unknown server-only Spark model IDs', () => {
    expect(createRuntimeFromEnvironment({}).mode).toBe('meta')
    expect(() => createRuntimeFromEnvironment({ MODEL_SPARK: 'untrusted-model' })).toThrow()
})

it('isolates Standard parse/secondary configuration from Spark-only live tasks', () => {
    const runtime = createRuntimeFromEnvironment({
        MODEL_PARSE: 'muse-wonder-1.0',
        MODEL_SECOND_OPINION: 'muse-wonder-1.0',
    })
    expect(runtime.sparkModel).toBe('muse-spark-1.3')
    expect(runtime.parseModel).toBe('muse-wonder-1.0')
    expect(runtime.secondOpinionModel).toBe('muse-wonder-1.0')
    expect(createRuntimeFromEnvironment({ MODEL_SECOND_OPINION: '' }).secondOpinionModel).toBeUndefined()
    for (const field of ['MODEL_SPARK', 'MODEL_PARSE', 'MODEL_SECOND_OPINION']) {
        expect(() => createRuntimeFromEnvironment({ [field]: 'muse-spark-1.3-contributor' })).toThrow()
    }
    expect(() => createRuntimeFromEnvironment({ MODEL_SPARK: 'muse-wonder-1.0' })).toThrow()
})
