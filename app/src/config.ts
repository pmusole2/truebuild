/**
 * Build-time public configuration. EXPO_PUBLIC_* values are visible in the app bundle: they are never Meta credentials.
 * Fixture mode is the default and needs no key. Model mode is selected explicitly and uses the same backend routes.
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001'

/**
 * Public demo-only shared key sent as x-truebuild-key. Synthetic and visible in the bundle, so it is never a Meta or
 * other real credential. The default is empty: set it explicitly for a local or test backend.
 */
export const API_SECRET = process.env.EXPO_PUBLIC_API_SECRET ?? ''

export type DemoMode = 'fixture' | 'model'

export const DEMO_MODE: DemoMode = process.env.EXPO_PUBLIC_PROVIDER_MODE === 'model' ? 'model' : 'fixture'
