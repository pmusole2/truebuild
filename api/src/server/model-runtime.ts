import { randomUUID } from 'node:crypto'

import { createFixtureProvider } from '../providers/fixture'
import { createMetaProvider } from '../providers/meta-provider'
import { createSamProvider } from '../providers/sam'
import { SharedKeyAuth } from './auth'
import { ModelCallCounter } from './budget'
import { DEFAULT_ORIGINS } from './cors'
import { createApiHandlers } from './handlers'
import { createModelHandlers, guardModelFetch } from './model-service'

// Compatibility metadata only: no token, session persistence, expiry timer, or authorization role.
const PROCESS_METADATA = Object.freeze({ runId: randomUUID(), expiresAt: Number.MAX_SAFE_INTEGER })

export interface ApiRuntime {
    sessionMetadata: typeof PROCESS_METADATA
    mode: 'fixture' | 'meta'
    configured: boolean
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

export function createRuntimeFromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
    transport?: typeof fetch,
): ApiRuntime {
    const mode = environment.PROVIDER_MODE ?? 'fixture'
    if (mode !== 'fixture' && mode !== 'meta') {
        throw new Error('invalid_provider_mode')
    }
    const checkTimeoutMs = positiveInteger(environment.CHECK_TIMEOUT_MS, 8_000, 8_000)
    const counter = new ModelCallCounter(positiveInteger(environment.MODEL_CALL_LIMIT, 200))
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
    const providerOptions = { apiKey, fetchImpl: guardModelFetch(transport), checkTimeoutMs }
    return {
        sessionMetadata: PROCESS_METADATA,
        mode,
        configured,
        auth,
        counter,
        allowedOrigins,
        fixture: createApiHandlers(createFixtureProvider(), allowedOrigins),
        model: createModelHandlers({
            auth,
            counter,
            allowedOrigins,
            checkTimeoutMs,
            provider: configured ? createMetaProvider(providerOptions) : null,
            samProvider: configured ? createSamProvider(providerOptions) : null,
        }),
    }
}
