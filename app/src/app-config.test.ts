import { describe, expect, it } from 'vitest'
import {
    PRODUCTION_API_BASE_URL,
    assertProductionEnvironment,
    isProductionReleaseContext,
    type ReleaseEnvironment,
} from '../app.config'

const productionEnv: ReleaseEnvironment = {
    EXPO_PUBLIC_API_BASE_URL: PRODUCTION_API_BASE_URL,
    EXPO_PUBLIC_PROVIDER_MODE: 'meta',
    EXPO_PUBLIC_GENERATIVE_UI: 'steps',
}

const EXPO_EXPORT_ARGV = ['/usr/bin/node', '/app/node_modules/expo/bin/cli', 'export', '--platform', 'ios']
const EXPO_START_ARGV = ['/usr/bin/node', '/app/node_modules/expo/bin/cli', 'start']

describe('production release context', () => {
    it('applies to store builds and to the expo export spawned by eas update', () => {
        expect(isProductionReleaseContext({ EAS_BUILD_PROFILE: 'production' }, EXPO_START_ARGV)).toBe(true)
        expect(isProductionReleaseContext({}, EXPO_EXPORT_ARGV)).toBe(true)
    })

    it('does not restrict local development servers or other profiles', () => {
        expect(isProductionReleaseContext({}, EXPO_START_ARGV)).toBe(false)
        expect(isProductionReleaseContext({ EAS_BUILD_PROFILE: 'preview' }, EXPO_START_ARGV)).toBe(false)
    })
})

describe('assertProductionEnvironment', () => {
    it('accepts the exact Sevalla origin with meta, steps and no fixture flags', () => {
        expect(() => assertProductionEnvironment(productionEnv)).not.toThrow()
        expect(() => assertProductionEnvironment({ ...productionEnv, EXPO_PUBLIC_RELEASE_FIXTURE: '0' })).not.toThrow()
    })

    it.each([
        ['an unset API origin', { EXPO_PUBLIC_API_BASE_URL: undefined }, /EXPO_PUBLIC_API_BASE_URL must be exactly/],
        ['a placeholder origin', { EXPO_PUBLIC_API_BASE_URL: 'https://REPLACE_ME.example' }, /must be exactly/],
        ['a plain HTTP origin', { EXPO_PUBLIC_API_BASE_URL: 'http://truebuild-suhsi.sevalla.app' }, /must be exactly/],
        ['a trailing slash', { EXPO_PUBLIC_API_BASE_URL: `${PRODUCTION_API_BASE_URL}/` }, /must be exactly/],
        ['an unset provider mode', { EXPO_PUBLIC_PROVIDER_MODE: undefined }, /EXPO_PUBLIC_PROVIDER_MODE=meta/],
        ['the fixture provider', { EXPO_PUBLIC_PROVIDER_MODE: 'fixture' }, /EXPO_PUBLIC_PROVIDER_MODE=meta/],
        ['the full generative mode', { EXPO_PUBLIC_GENERATIVE_UI: 'full' }, /EXPO_PUBLIC_GENERATIVE_UI=steps/],
        ['an unset generative mode', { EXPO_PUBLIC_GENERATIVE_UI: undefined }, /EXPO_PUBLIC_GENERATIVE_UI=steps/],
        ['a release fixture', { EXPO_PUBLIC_RELEASE_FIXTURE: '1' }, /EXPO_PUBLIC_RELEASE_FIXTURE/],
        ['document fixtures', { EXPO_PUBLIC_DOCUMENT_FIXTURES: 'true' }, /EXPO_PUBLIC_DOCUMENT_FIXTURES/],
        ['the effort proof', { EXPO_PUBLIC_AI_EFFORT_PROOF: '1' }, /EXPO_PUBLIC_AI_EFFORT_PROOF/],
    ])('rejects %s', (_label, override, message) => {
        expect(() => assertProductionEnvironment({ ...productionEnv, ...override })).toThrow(message)
    })
})
