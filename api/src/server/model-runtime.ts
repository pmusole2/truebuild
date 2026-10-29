import type { StandardModel } from '@truebuild/contracts'
import { randomUUID } from 'node:crypto'

import type { ProviderMetrics } from '../providers/meta-transport'
import { createFixtureProvider } from '../providers/fixture'
import { createScreenFixtureGenerator } from '../providers/screen-fixtures'
import type { ScreenFixtureGenerator } from './screens/service'
import {
    createMetaProvider,
    sparkModel,
    parseModel,
    secondOpinionModel,
    checkContextMode,
    type CheckContextMode,
    type SparkModel,
} from '../providers/meta-provider'
import { createSamProvider } from '../providers/sam'
import { SharedKeyAuth } from './auth'
import {
    aiPolicyFromEnvironment,
    describeAiPolicy,
    generativeUiMode,
    MAX_DEADLINE_MS,
    type AiPolicy,
} from './ai-policy'
import { ModelCallCounter } from './budget'
import { DEFAULT_ORIGINS } from './cors'
import { createApiHandlers } from './handlers'
import { createModelHandlers, guardModelFetch, runModelParseRepair } from './model-service'

// Compatibility metadata only: no token, session persistence, expiry timer, or authorization role.
const PROCESS_METADATA = Object.freeze({ runId: randomUUID(), expiresAt: Number.MAX_SAFE_INTEGER })

export interface ApiRuntime {
    sessionMetadata: typeof PROCESS_METADATA
    mode: 'fixture' | 'meta'
    configured: boolean
    sparkModel: SparkModel
    parseModel: StandardModel
    secondOpinionModel?: StandardModel
    checkContext: CheckContextMode
    /** Default off; only the explicit value MODEL_LAYOUT=1 enables layout resolution. */
    layout: boolean
    /** MODEL_LAYOUT_WONDER=1 with MODEL_LAYOUT=1 lets a Wonder second opinion author the layout in the same call. */
    layoutWonder: boolean
    /** Per-stage effort, output headroom, deadline and model; includes GENERATIVE_UI. */
    policy: AiPolicy
    /** MODEL_LAYOUT_WONDER (default on unless GENERATIVE_UI=off): offer the asynchronous Wonder overlay after a verdict. */
    overlay: boolean
    /** MODEL_SEGMENTS (default on unless GENERATIVE_UI=off): offer the separate SAM stage after a verdict. */
    segments: boolean
    samModel: 'sam-3.1'
    auth: SharedKeyAuth
    counter: ModelCallCounter
    allowedOrigins: readonly string[]
    fixture: ReturnType<typeof createApiHandlers>
    model: ReturnType<typeof createModelHandlers>
}

function positiveInteger(value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
    if (value === undefined || value === '') {
        return fallback
    }
    const number = Number(value)
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number <= 0 || number > maximum) {
        throw new Error('invalid_runtime_configuration')
    }
    return number
}

function flag(value: string | undefined, fallback: boolean, error: string): boolean {
    if (value === undefined || value === '') return fallback
    if (value === '1') return true
    if (value === '0') return false
    throw new Error(error)
}

function layoutFlag(value: string | undefined, error = 'invalid_model_layout'): boolean {
    if (value === undefined || value === '' || value === '0') {
        return false
    }
    if (value === '1') {
        return true
    }
    throw new Error(error)
}

export { describeAiPolicy }

export interface RuntimeOptions {
    /**
     * Explicit synthetic screen composition source, for tests and the isolated fixture stack only. `PROVIDER_MODE=fixture`
     * wires the bundled one by default; a live (`meta`) runtime never uses one, configured or not.
     */
    screenFixtures?: ScreenFixtureGenerator | null
}

export function createRuntimeFromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
    transport?: typeof fetch,
    runtimeOptions: RuntimeOptions = {},
): ApiRuntime {
    const mode = environment.PROVIDER_MODE ?? 'meta'
    if (mode !== 'fixture' && mode !== 'meta') {
        throw new Error('invalid_provider_mode')
    }
    const model = sparkModel(environment.MODEL_SPARK)
    const parse = parseModel(environment.MODEL_PARSE)
    // The stronger second opinion is on by default (Wonder); an empty value or `off` disables it.
    const secondary = secondOpinionModel(
        environment.MODEL_SECOND_OPINION === 'off' ? '' : (environment.MODEL_SECOND_OPINION ?? 'muse-wonder-1.0'),
    )
    const checkContext = checkContextMode(environment.MODEL_CHECK_CONTEXT)
    const layout = layoutFlag(environment.MODEL_LAYOUT)
    const wonderFlag = flag(environment.MODEL_LAYOUT_WONDER, true, 'invalid_model_layout_wonder')
    const layoutWonder = wonderFlag && layout && environment.MODEL_LAYOUT_WONDER === '1'
    if (environment.MODEL_SAM !== undefined && environment.MODEL_SAM !== 'sam-3.1') throw new Error('invalid_model_sam')
    // The verdict deadline is configurable up to the trusted 105 s ceiling; the default stays 8 s (provisional).
    // CHECK_TIMEOUT_MS and its documented alias AI_DEADLINE_VERDICT_MS name the same value; both set must agree.
    const verdictDeadlines = [environment.CHECK_TIMEOUT_MS, environment.AI_DEADLINE_VERDICT_MS]
        .filter((value) => value !== undefined && value !== '')
        .map((value) => positiveInteger(value, 8_000, MAX_DEADLINE_MS))
    if (new Set(verdictDeadlines).size > 1) throw new Error('conflicting_verdict_deadline')
    const checkTimeoutMs = verdictDeadlines[0] ?? 8_000
    // No call-count cap unless an operator sets MODEL_CALL_LIMIT explicitly.
    const counter = new ModelCallCounter(
        environment.MODEL_CALL_LIMIT === undefined || environment.MODEL_CALL_LIMIT === ''
            ? undefined
            : positiveInteger(environment.MODEL_CALL_LIMIT, 1),
    )
    const policy = aiPolicyFromEnvironment(environment, {
        checkTimeoutMs,
        parseModel: parse,
        verdictModel: model,
        secondOpinionModel: secondary ?? 'muse-wonder-1.0',
    })
    const followUpsOn = generativeUiMode(environment.GENERATIVE_UI) !== 'off'
    const overlay = followUpsOn && wonderFlag
    const segments = followUpsOn && flag(environment.MODEL_SEGMENTS, true, 'invalid_model_segments')
    const maxConcurrency = positiveInteger(environment.MODEL_MAX_CONCURRENCY, 32, 1_024)
    // Slots only foreground work (verdict, question, overlay, second opinion, SAM, latency screens) may take.
    const foregroundReserve =
        environment.MODEL_FOREGROUND_RESERVE === undefined || environment.MODEL_FOREGROUND_RESERVE === ''
            ? undefined
            : Number(environment.MODEL_FOREGROUND_RESERVE)
    if (
        foregroundReserve !== undefined &&
        (!/^\d+$/u.test(environment.MODEL_FOREGROUND_RESERVE ?? '') || foregroundReserve >= maxConcurrency)
    ) {
        throw new Error('invalid_runtime_configuration')
    }
    // Background step-screen generation runs this many provider calls at once. It is bounded by provider pacing and
    // memory, not by cost; the default matches the normal worker bound and an operator tunes it to the rate limit.
    const precomputeConcurrency = positiveInteger(environment.SCREEN_PRECOMPUTE_CONCURRENCY, 4, 16)
    const questionSyncWaitMs = positiveInteger(environment.QUESTION_SYNC_WAIT_MS, 8_000, 60_000)
    const auth = new SharedKeyAuth({ sharedSecret: environment.API_SHARED_SECRET })
    const configuredOrigins = (environment.CORS_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    for (const origin of configuredOrigins) {
        try {
            const url = new URL(origin)
            if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) {
                throw new Error('invalid_cors_origin')
            }
        } catch {
            throw new Error('invalid_cors_origin')
        }
    }
    const allowedOrigins = [...new Set([...DEFAULT_ORIGINS, ...configuredOrigins])]
    // Deliberately do not access MODEL_API_KEY at all in fixture mode.
    let apiKey: string | undefined
    if (mode === 'meta') {
        apiKey = environment.MODEL_API_KEY
    }
    const configured = mode === 'meta' && Boolean(apiKey?.trim())
    const onMetrics = (metrics: ProviderMetrics): void => console.info(JSON.stringify(metrics))
    const providerOptions = {
        apiKey,
        onMetrics,
        fetchImpl: guardModelFetch(transport),
        checkTimeoutMs,
        model,
        parseModel: parse,
        secondOpinionModel: secondary,
        checkContext,
        layout,
        layoutWonder,
        policy,
        runRepair: runModelParseRepair,
        // With the Wonder overlay stage offered, the Spark verdict is a verdict only: geometry arrives later.
        verdictOnly: overlay,
    }
    return {
        sessionMetadata: PROCESS_METADATA,
        mode,
        configured,
        sparkModel: model,
        parseModel: parse,
        secondOpinionModel: secondary,
        checkContext,
        layout,
        layoutWonder,
        policy,
        overlay,
        segments,
        samModel: 'sam-3.1',
        auth,
        counter,
        allowedOrigins,
        fixture: createApiHandlers(createFixtureProvider(), allowedOrigins),
        model: createModelHandlers({
            auth,
            counter,
            allowedOrigins,
            checkTimeoutMs,
            secondOpinionModel: secondary,
            checkContext,
            layout,
            policy,
            runtimeMode: mode,
            followUps: { overlay, segments },
            maxConcurrency,
            foregroundReserve,
            precomputeConcurrency,
            questionSyncWaitMs,
            // Synthetic sources are confined to fixture mode, including explicitly injected test sources.
            screenFixtures:
                mode === 'fixture' ? (runtimeOptions.screenFixtures ?? createScreenFixtureGenerator()) : null,
            provider: configured
                ? createMetaProvider({ ...providerOptions, runParseRepair: runModelParseRepair })
                : null,
            samProvider: configured && segments ? createSamProvider(providerOptions) : null,
        }),
    }
}
