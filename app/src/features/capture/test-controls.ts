/**
 * Test-only, development-only control for browser evidence: delays the first library restore so the loading state can be
 * captured. Production builds (where __DEV__ is false) never read it, and it never changes stored data or requests.
 */
export function testRestoreDelayMs(): number {
    if (!__DEV__ || typeof window === 'undefined') {
        return 0
    }
    const value = Number(new URLSearchParams(window.location.search).get('truebuildTestRestoreDelayMs'))
    return Number.isSafeInteger(value) && value > 0 && value <= 30_000 ? value : 0
}
