/**
 * Build-time public configuration. EXPO_PUBLIC_* values are visible in the app bundle: they are never Meta credentials.
 * Meta is the default. Fixture mode is reserved for explicit automated/offline tooling.
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001'

/** Public demo-only shared key sent as x-truebuild-key. Synthetic and visible in the bundle, never a real credential. */
export const API_SECRET = process.env.EXPO_PUBLIC_API_SECRET ?? ''

export type DemoMode = 'fixture' | 'model'

/**
 * Public provider selection. `fixture` simulates every result. `meta` selects the live backend path, which the wire
 * contract names `model`. Anything else is a configuration error: it must never silently fall back to simulation.
 */
export function resolveProviderMode(value: string | undefined): DemoMode {
    if (value === 'fixture') {
        return 'fixture'
    }
    if (value === undefined || value === 'meta') {
        return 'model'
    }
    throw new Error('EXPO_PUBLIC_PROVIDER_MODE must be "fixture" or "meta"')
}

export const DEMO_MODE: DemoMode = resolveProviderMode(process.env.EXPO_PUBLIC_PROVIDER_MODE)

/** Host only, never userinfo, paths, query strings, transport keys or provider credentials. */
export function developmentHost(baseUrl: string): string {
    try {
        return new URL(baseUrl).hostname
    } catch {
        return 'unconfigured'
    }
}

export type GenerativeUiMode = 'off' | 'steps' | 'full'

/**
 * Public generative-UI selection; it must agree with the backend GENERATIVE_UI. Every mode uses complete v2 documents.
 * `off` composes local fallback documents, `steps` generates Guide documents, and `full` (the default) generates all kinds. Anything
 * else is a configuration error and never silently enables or disables generation.
 */
export function resolveGenerativeUi(value: string | undefined): GenerativeUiMode {
    if (value === undefined || value === 'full') {
        return 'full'
    }
    if (value === 'off' || value === 'steps') {
        return value
    }
    throw new Error('EXPO_PUBLIC_GENERATIVE_UI must be "off", "steps" or "full"')
}

export const GENERATIVE_UI: GenerativeUiMode = resolveGenerativeUi(process.env.EXPO_PUBLIC_GENERATIVE_UI)
