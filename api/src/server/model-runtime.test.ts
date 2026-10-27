import { describe, expect, it, vi } from 'vitest'

import { createRuntimeFromEnvironment } from './model-runtime'

describe('provider runtime configuration', (): void => {
    it.each([undefined, 'fixture'])('never reads the model key in %s mode', (mode): void => {
        const outbound = vi.fn<typeof fetch>()
        let keyReads = 0
        const runtime = createRuntimeFromEnvironment(
            {
                PROVIDER_MODE: mode,
                get MODEL_API_KEY(): string {
                    keyReads += 1
                    throw new Error('unexpected_key_read')
                },
            },
            outbound,
        )
        expect(runtime.mode).toBe('fixture')
        expect(runtime.configured).toBe(false)
        expect(keyReads).toBe(0)
        expect(outbound).not.toHaveBeenCalled()
    })

    it('fails closed for invalid mode, counter, or deadline configuration', (): void => {
        for (const env of [
            { PROVIDER_MODE: 'unknown' },
            { MODEL_CALL_LIMIT: '0' },
            { MODEL_CALL_LIMIT: '2.5' },
            { CHECK_TIMEOUT_MS: '0' },
            { CHECK_TIMEOUT_MS: '8001' },
            { CHECK_TIMEOUT_MS: '30001' },
        ]) {
            expect(() => createRuntimeFromEnvironment(env)).toThrow()
        }
    })

    it('does not dispatch while starting an unconfigured meta runtime', (): void => {
        const outbound = vi.fn<typeof fetch>()
        const runtime = createRuntimeFromEnvironment({ PROVIDER_MODE: 'meta' }, outbound)
        expect(runtime.configured).toBe(false)
        expect(outbound).not.toHaveBeenCalled()
    })
})
