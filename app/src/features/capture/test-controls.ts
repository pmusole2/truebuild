import { API_BASE_URL } from '../../config'
import { nativeProofConfig } from '../ai-effort-proof/config'

/**
 * Development-only fixture control: delays the first library restore so the loading state can be
 * captured. Production builds (where __DEV__ is false) never read it, and it never changes stored data or requests.
 */
export function testRestoreDelayMs(): number {
    if (!__DEV__) {
        return 0
    }
    const fixtureDelay = Number(process.env.EXPO_PUBLIC_TEST_RESTORE_DELAY_MS)
    if (
        Number.isSafeInteger(fixtureDelay) &&
        fixtureDelay > 0 &&
        fixtureDelay <= 30_000 &&
        nativeProofConfig(API_BASE_URL) !== null
    )
        return fixtureDelay
    if (typeof window === 'undefined') return 0
    const value = Number(new URLSearchParams(window.location.search).get('truebuildTestRestoreDelayMs'))
    return Number.isSafeInteger(value) && value > 0 && value <= 30_000 ? value : 0
}
