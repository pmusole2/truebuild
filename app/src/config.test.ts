import { afterEach, describe, expect, it } from 'vitest'
import { developmentHost, resolveGenerativeUi, resolveProviderMode } from './config'
import { parseBaseUrl } from './api/transport'

const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
})

describe('production API origin rule', () => {
    it('accepts HTTPS anywhere and plain HTTP for loopback or LAN hosts in a development build', () => {
        process.env.NODE_ENV = 'development'
        expect(parseBaseUrl('https://api.example.com')).toBe('https://api.example.com')
        expect(parseBaseUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
        expect(parseBaseUrl('http://192.168.1.20:3001')).toBe('http://192.168.1.20:3001')
    })

    it('refuses plain HTTP in a production build, even for a LAN address', () => {
        process.env.NODE_ENV = 'production'
        expect(() => parseBaseUrl('http://192.168.1.20:3001')).toThrow(/https origin/)
        expect(() => parseBaseUrl('http://127.0.0.1:3001')).toThrow(/https origin/)
        for (const url of [
            'https://localhost',
            'https://127.0.0.1',
            'https://[::1]',
            'https://[::]',
            'https://[::ffff:127.0.0.1]',
            'https://app.localhost',
        ]) {
            expect(() => parseBaseUrl(url)).toThrow(/https origin/)
        }
        expect(parseBaseUrl('https://api.example.com')).toBe('https://api.example.com')
    })

    it('refuses plain HTTP to public hosts in development', () => {
        process.env.NODE_ENV = 'development'
        expect(() => parseBaseUrl('http://api.example.com')).toThrow(/https origin/)
    })
})

describe('provider mode', () => {
    it('defaults to meta and maps the public "meta" value to the internal model path', () => {
        expect(resolveProviderMode(undefined)).toBe('model')
        expect(resolveProviderMode('fixture')).toBe('fixture')
        expect(resolveProviderMode('meta')).toBe('model')
    })

    it('fails closed on unknown values instead of silently simulating', () => {
        expect(() => resolveProviderMode('model')).toThrow(/"fixture" or "meta"/)
        expect(() => resolveProviderMode('live')).toThrow(/"fixture" or "meta"/)
        expect(() => resolveProviderMode('')).toThrow()
    })
})

describe('development host badge', () => {
    it('shows only the host without credentials, path, query, fragment or port', () => {
        expect(developmentHost('https://user:password@api.example.com:444/path?key=private#fragment')).toBe(
            'api.example.com',
        )
        expect(developmentHost('invalid')).toBe('unconfigured')
    })
})

describe('generative UI mode', () => {
    it('defaults to full and accepts exactly off, steps and full', () => {
        expect(resolveGenerativeUi(undefined)).toBe('full')
        expect(resolveGenerativeUi('full')).toBe('full')
        expect(resolveGenerativeUi('steps')).toBe('steps')
        expect(resolveGenerativeUi('off')).toBe('off')
    })

    it('fails closed on anything else', () => {
        for (const value of ['', 'on', 'FULL', 'true', 'guide']) {
            expect(() => resolveGenerativeUi(value)).toThrow(/"off", "steps" or "full"/)
        }
    })
})
