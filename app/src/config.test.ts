import { afterEach, describe, expect, it } from 'vitest'
import { resolveProviderMode } from './config'
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
        expect(parseBaseUrl('https://api.example.com')).toBe('https://api.example.com')
    })

    it('refuses plain HTTP to public hosts in development', () => {
        process.env.NODE_ENV = 'development'
        expect(() => parseBaseUrl('http://api.example.com')).toThrow(/https origin/)
    })
})

describe('provider mode', () => {
    it('defaults to fixture and maps the public "meta" value to the internal model path', () => {
        expect(resolveProviderMode(undefined)).toBe('fixture')
        expect(resolveProviderMode('fixture')).toBe('fixture')
        expect(resolveProviderMode('meta')).toBe('model')
    })

    it('fails closed on unknown values instead of silently simulating', () => {
        expect(() => resolveProviderMode('model')).toThrow(/"fixture" or "meta"/)
        expect(() => resolveProviderMode('live')).toThrow(/"fixture" or "meta"/)
        expect(() => resolveProviderMode('')).toThrow()
    })
})
