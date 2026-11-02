import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBaseUrl } from './transport'

afterEach(() => vi.unstubAllEnvs())
function release(): void {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('EXPO_PUBLIC_RELEASE_FIXTURE', '1')
    vi.stubEnv('EXPO_PUBLIC_AI_EFFORT_PROOF', '1')
    vi.stubEnv('EXPO_PUBLIC_PROVIDER_MODE', 'fixture')
    vi.stubEnv('EXPO_PUBLIC_AI_EFFORT_PROOF_RUN', 'isolated-release')
}
describe('isolated non-development fixture transport', () => {
    it('allows only the explicit release-fixture loopback API and keeps normal HTTPS working', () => {
        release()
        expect(parseBaseUrl('http://127.0.0.1:3101')).toBe('http://127.0.0.1:3101')
        expect(parseBaseUrl('https://example.com')).toBe('https://example.com')
    })
    it.each([
        'http://127.0.0.1:3102',
        'http://192.168.0.2:3101',
        'http://127.0.0.1:3101/path',
        'http://user:password@127.0.0.1:3101',
    ])('never widens release transport to %s', (url) => {
        release()
        expect(() => parseBaseUrl(url)).toThrow()
    })
    it('rejects live-mode and unflagged release HTTP', () => {
        release()
        vi.stubEnv('EXPO_PUBLIC_PROVIDER_MODE', 'meta')
        expect(() => parseBaseUrl('http://127.0.0.1:3101')).toThrow()
        vi.stubEnv('EXPO_PUBLIC_PROVIDER_MODE', 'fixture')
        vi.stubEnv('EXPO_PUBLIC_RELEASE_FIXTURE', '')
        expect(() => parseBaseUrl('http://127.0.0.1:3101')).toThrow()
    })
})
