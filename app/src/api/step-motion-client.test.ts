import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoManual } from '@truebuild/contracts'
import {
    MODEL_PIECES_TIMEOUT_MS,
    ModelApiClient,
    resetStepMotionEndpointForTests,
    type ModelFetch,
} from './model-client'
import {
    motionRequestForStep,
    StepMotionRegistry,
    stepMotionCacheKey,
} from '../features/step-motion/step-motion-registry'
import { AiConsentStore } from '../features/consent/consent-store'
import type { KeyValueStorage } from '../features/capture/library'
import { RECORDED_STEP_MOTION_SCENES } from '../features/step-motion/__fixtures__/recorded-scenes'

function memory(): KeyValueStorage {
    const values = new Map<string, string>()
    return {
        getItem: async (key): Promise<string | null> => values.get(key) ?? null,
        setItem: async (key, value): Promise<void> => {
            values.set(key, value)
        },
        removeItem: async (key): Promise<void> => {
            values.delete(key)
        },
        getAllKeys: async (): Promise<string[]> => [...values.keys()],
    }
}

// The 404 latch is per app session: each test starts with the endpoint assumed present.
beforeEach(() => {
    resetStepMotionEndpointForTests()
})

describe('step motion additive client', () => {
    it.each([
        [true, 'not_sent'],
        [false, 'unknown'],
    ] as const)(
        'trusts an explicit pre-dispatch attestation (%s), otherwise preserves uncertainty',
        async (notDispatched, status) => {
            const fetch = vi.fn<ModelFetch>(async () =>
                Response.json({ code: 'timeout', notDispatched }, { status: 503 }),
            )
            const client = new ModelApiClient({ baseUrl: 'https://fixture.example', secret: '', fetch })
            const request = motionRequestForStep(createDemoManual(), 'step-1', 'motion-1')!
            expect(await client.stepMotion(request, { [request.page.pageId]: 'data:image/png;base64,AQID' })).toEqual({
                status,
            })
        },
    )

    it('marks declined consent as not sent, with no upload', async () => {
        const fetch = vi.fn<ModelFetch>()
        const consent = new AiConsentStore({
            getItem: async (): Promise<string> => 'declined',
            setItem: async (): Promise<void> => {},
        })
        const client = new ModelApiClient({ baseUrl: 'https://fixture.example', secret: '', fetch, consent })
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'motion-1')!
        expect(await client.stepMotion(request, {})).toEqual({ status: 'not_sent' })
        expect(fetch).not.toHaveBeenCalled()
    })

    it.each([
        ['a JSON body', (): Response => Response.json({ code: 'not_found' }, { status: 404 })],
        [
            'a body that fails to read',
            (): Response =>
                new Response(new ReadableStream({ pull: (controller) => controller.error(new Error('reset')) }), {
                    status: 404,
                }),
        ],
    ])('stops calling motion after an original 404 with %s, across client instances', async (_body, refuse) => {
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'motion-1')!
        const pageUris = { [request.page.pageId]: 'data:image/png;base64,AQID' }
        const fetch = vi.fn<ModelFetch>(async () => refuse())
        const first = new ModelApiClient({ baseUrl: 'https://fixture.example', secret: '', fetch })
        const second = new ModelApiClient({ baseUrl: 'https://fixture.example', secret: '', fetch })
        expect(await first.stepMotion(request, pageUris)).toEqual({ status: 'not_sent' })
        expect(await second.stepMotion(request, pageUris)).toEqual({ status: 'not_sent' })
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('does not latch on a cache-only 404, so the original generation is still attempted', async () => {
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'motion-1')!
        const pageUris = { [request.page.pageId]: 'data:image/png;base64,AQID' }
        const fetch = vi.fn<ModelFetch>(async () => Response.json({ code: 'not_found' }, { status: 404 }))
        const client = new ModelApiClient({ baseUrl: 'https://fixture.example', secret: '', fetch })
        expect(await client.stepMotion({ ...request, cacheOnly: true }, pageUris)).toEqual({ status: 'unknown' })
        expect(await client.stepMotion(request, pageUris)).toEqual({ status: 'not_sent' })
        expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('treats an older server 404 as no hint and sends once with the verbatim text and cited figure', async () => {
        const fetch = vi.fn<ModelFetch>(async () => Response.json({ code: 'not_found' }, { status: 404 }))
        const client = new ModelApiClient({ baseUrl: 'https://fixture.example', secret: '', fetch })
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'motion-1')!
        expect(await client.stepMotion(request, { [request.page.pageId]: 'data:image/png;base64,AQID' })).toEqual({
            status: 'not_sent',
        })
        expect(fetch).toHaveBeenCalledTimes(1)
        const call = fetch.mock.calls[0]!
        expect(call[0]).toBe('https://fixture.example/api/step-motion')
        const form = call[1].body
        if (!(form instanceof FormData)) throw new Error('Expected the multipart request')
        expect(JSON.parse(String(form.get('metadata'))).instructionText).toBe(request.instructionText)
        expect(form.get(`page:${request.page.pageId}`)).toBeInstanceOf(Blob)
    })
})

describe('step motion cache-only recovery', () => {
    const pageUris = { 'demo-page-1': 'data:image/png;base64,AQID' }
    const request = motionRequestForStep(createDemoManual(), 'step-1', 'motion-1')!
    const scene = { ...RECORDED_STEP_MOTION_SCENES.press, stepId: request.stepId }
    const registryOver = (disk: KeyValueStorage, fetch: ModelFetch): StepMotionRegistry => {
        const client = new ModelApiClient({ baseUrl: 'https://fixture.example', secret: '', fetch })
        return new StepMotionRegistry(disk, (value, pages) => client.stepMotion(value, pages))
    }
    const metadataOf = (body: BodyInit | null | undefined): Record<string, unknown> => {
        if (!(body instanceof FormData)) throw new Error('Expected the multipart request')
        return JSON.parse(String(body.get('metadata')))
    }

    it.each([
        ['a network failure', async (): Promise<Response> => Promise.reject(new TypeError('network'))],
        ['a proxy 502', async (): Promise<Response> => new Response('<html>bad gateway</html>', { status: 502 })],
        [
            'an unattested proxy busy response',
            async (): Promise<Response> => Response.json({ code: 'busy' }, { status: 503 }),
        ],
    ])(
        'after %s, one cache-only lookup reads the finished scene, sends no pages, and never generates again',
        async (_label, first) => {
            const fetch = vi
                .fn<ModelFetch>()
                .mockImplementationOnce(first)
                .mockImplementationOnce(async () => Response.json({ scene }))
            const disk = memory()
            expect(await registryOver(disk, fetch).load(request, pageUris)).toEqual(scene)
            expect(fetch).toHaveBeenCalledTimes(2)
            const [original, lookup] = fetch.mock.calls.map((call) => call[1].body)
            expect(fetch.mock.calls.map((call) => call[0])).toEqual([
                'https://fixture.example/api/step-motion',
                'https://fixture.example/api/step-motion?cacheOnly=1',
            ])
            expect(original).toBeInstanceOf(FormData)
            expect((original as FormData).get('page:demo-page-1')).toBeInstanceOf(Blob)
            expect(metadataOf(original)).not.toHaveProperty('cacheOnly')
            expect(metadataOf(lookup).cacheOnly).toBe(true)
            expect((lookup as FormData).has('page:demo-page-1')).toBe(false)
            expect(await registryOver(disk, fetch).load(request, pageUris)).toEqual(scene)
            expect(fetch).toHaveBeenCalledTimes(2)
        },
    )

    it('after the client deadline, uses one fresh cache-only request without re-dispatching', async () => {
        vi.useFakeTimers()
        try {
            const fetch = vi
                .fn<ModelFetch>()
                .mockImplementationOnce(() => new Promise<Response>(() => {}))
                .mockImplementationOnce(async (_url, init) => {
                    expect(init.signal?.aborted).toBe(false)
                    expect(metadataOf(init.body).cacheOnly).toBe(true)
                    return Response.json({ scene })
                })
            const disk = memory()
            const pending = registryOver(disk, fetch).load(request, pageUris)
            await vi.advanceTimersByTimeAsync(0)
            expect(fetch).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(MODEL_PIECES_TIMEOUT_MS)
            expect(await pending).toEqual(scene)
            expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true)
            expect(await registryOver(disk, fetch).load(request, pageUris)).toEqual(scene)
            expect(fetch).toHaveBeenCalledTimes(2)
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([
        ['finds no scene', async (): Promise<Response> => Response.json({ scene: null })],
        [
            'is refused as not found',
            async (): Promise<Response> => Response.json({ code: 'not_found' }, { status: 404 }),
        ],
    ])('keeps the original uncertainty when the lookup %s', async (_label, lookupOutcome) => {
        const fetch = vi
            .fn<ModelFetch>()
            .mockImplementationOnce(async () => new Response('<html>bad gateway</html>', { status: 502 }))
            .mockImplementationOnce(lookupOutcome)
        const disk = memory()
        expect(await registryOver(disk, fetch).load(request, pageUris)).toBeNull()
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(await registryOver(disk, fetch).load(request, pageUris)).toBeNull()
        expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('ignores the recovery flag when keying the cache', () => {
        expect(stepMotionCacheKey({ ...request, cacheOnly: true })).toBe(stepMotionCacheKey(request))
    })
})
