import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoManual, type ManualBinding } from '@truebuild/contracts'
import { AiConsentStore, AI_CONSENT_KEY, type ConsentStorage } from '../features/consent/consent-store'
import { aiConsent } from '../features/consent/consent-runtime'
import { ModelApiClient, type ImageBytes } from './model-client'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

const session = createDemoManual()
const binding: ManualBinding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
const image: ImageBytes = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 1200, height: 900 }
const ctx = { requestId: 'consent-parse' }
function storage(): { values: Map<string, string>; port: ConsentStorage } {
    const values = new Map<string, string>()
    return {
        values,
        port: {
            getItem: async (key): Promise<string | null> => values.get(key) ?? null,
            setItem: async (key, value): Promise<void> => {
                values.set(key, value)
            },
        },
    }
}
function network(): ReturnType<typeof vi.fn<typeof fetch>> {
    const transport = vi.fn<typeof fetch>(async () =>
        Response.json({
            status: 'ok',
            mode: 'model',
            requestId: ctx.requestId,
            binding,
            value: session.rawExtraction,
        }),
    )
    vi.stubGlobal('fetch', transport)
    return transport
}
const client = (consent: AiConsentStore): ModelApiClient =>
    new ModelApiClient({
        baseUrl: 'https://consent.example',
        secret: '',
        consent,
    })

describe('production image-send consent boundary', () => {
    it('sends nothing before permission, on Not now, or when an old request is aborted', async () => {
        vi.stubGlobal('__DEV__', false)
        vi.stubEnv('EXPO_PUBLIC_SKIP_TIPS', '1')
        vi.stubGlobal('window', { location: { search: '?truebuildSkipTips=1' } })
        const saved = storage()
        const consent = new AiConsentStore(saved.port)
        const transport = network()
        const append = vi.spyOn(FormData.prototype, 'append')
        try {
            const api = client(consent)
            const denied = api.parse(binding, session.pages, [image], ctx)
            await vi.waitFor(() => expect(consent.getSnapshot().visible).toBe(true))
            expect(append).not.toHaveBeenCalled()
            expect(transport).not.toHaveBeenCalled()
            await consent.choose(false)
            expect(await denied).toMatchObject({ status: 'unavailable' })
            expect(saved.values.get(AI_CONSENT_KEY)).toBe('declined')
            expect(transport).not.toHaveBeenCalled()

            const abort = new AbortController()
            const stopped = api.parse(binding, session.pages, [image], { ...ctx, signal: abort.signal })
            await vi.waitFor(() => expect(consent.getSnapshot().visible).toBe(true))
            abort.abort()
            await consent.choose(true)
            expect(await stopped).toMatchObject({ status: 'unavailable' })
            expect(transport).not.toHaveBeenCalled()

            // Injecting just a fixture stream must not exempt the real HTTP transport.
            const browserValues = new Map<string, string>()
            vi.stubGlobal('__DEV__', false)
            vi.stubGlobal('window', {
                location: { search: '' },
                localStorage: {
                    getItem: (key: string): string | null => browserValues.get(key) ?? null,
                    setItem: (key: string, value: string): void => {
                        browserValues.set(key, value)
                    },
                },
            })
            const partial = new ModelApiClient({
                baseUrl: 'https://consent.example',
                secret: '',
                streamFetch: async (): Promise<Response> => {
                    throw new Error('unused_fixture_stream')
                },
            })
            const http = partial.parse(binding, session.pages, [image], ctx)
            await vi.waitFor(() => expect(aiConsent.getSnapshot().visible).toBe(true))
            expect(transport).not.toHaveBeenCalled()
            await aiConsent.choose(false)
            expect(await http).toMatchObject({ status: 'unavailable' })
            expect(transport).not.toHaveBeenCalled()
        } finally {
            append.mockRestore()
        }
    })

    it('persists explicit agreement and restores it without another screen or upload prompt', async () => {
        const saved = storage()
        const consent = new AiConsentStore(saved.port)
        const transport = network()
        const initial = client(consent).parse(binding, session.pages, [image], ctx)
        await vi.waitFor(() => expect(consent.getSnapshot().visible).toBe(true))
        await consent.choose(true)
        expect(await initial).toMatchObject({ status: 'ok' })
        expect(saved.values.get(AI_CONSENT_KEY)).toBe('accepted')
        expect(transport).toHaveBeenCalledTimes(1)

        const restored = new AiConsentStore(saved.port)
        expect(await client(restored).parse(binding, session.pages, [image], ctx)).toMatchObject({ status: 'ok' })
        expect(restored.getSnapshot()).toMatchObject({ choice: 'accepted', visible: false })
        expect(transport).toHaveBeenCalledTimes(2)
    })
})
