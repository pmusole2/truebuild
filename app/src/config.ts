/**
 * Build-time public configuration. EXPO_PUBLIC_* values are visible in the app bundle: they are never Meta credentials.
 * Fixture mode is the default and needs no key.
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
    if (value === undefined || value === 'fixture') {
        return 'fixture'
    }
    if (value === 'meta') {
        return 'model'
    }
    throw new Error('EXPO_PUBLIC_PROVIDER_MODE must be "fixture" or "meta"')
}

export const DEMO_MODE: DemoMode = resolveProviderMode(process.env.EXPO_PUBLIC_PROVIDER_MODE)
