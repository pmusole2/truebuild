import { describe, expect, it, vi } from 'vitest'
import { createDemoManual } from '@truebuild/contracts'
import { ModelApiClient, type ModelFetch } from './model-client'
import { motionRequestForStep } from '../features/step-motion/step-motion-registry'
import { AiConsentStore } from '../features/consent/consent-store'

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
