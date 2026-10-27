import { ModelCallCounter } from '../server/budget'
import { describe, expect, it } from 'vitest'
import { uploadMetaFile } from './meta-files'

describe('inactive Files boundary against documented variants', () => {
    it.each(['omitted', 'null', 'timestamp'] as const)(
        'uploads metadata before file and accepts expires_at %s',
        async (expiration) => {
            const fetchImpl: typeof fetch = async (url, init) => {
                expect(url).toBe('https://api.meta.ai/v1/files')
                expect(init?.method).toBe('POST')
                expect(new Headers(init?.headers).has('content-type')).toBe(false)
                const request = new Request(String(url), init)
                const form = await request.formData()
                expect([...form.keys()]).toEqual(['purpose', 'expires_after[anchor]', 'expires_after[seconds]', 'file'])
                expect(form.get('purpose')).toBe('user_data')
                expect(form.get('expires_after[anchor]')).toBe('created_at')
                expect(form.get('expires_after[seconds]')).toBe('3600')
                expect(await (form.get('file') as File).text()).toBe('synthetic-media')
                return Response.json({
                    id: 'file-synthetic',
                    object: 'file',
                    bytes: 15,
                    created_at: 1,
                    filename: 'image.png',
                    purpose: 'user_data',
                    status: 'processed',
                    ...(expiration === 'omitted' ? {} : { expires_at: expiration === 'null' ? null : 3601 }),
                })
            }
            expect(
                (
                    await uploadMetaFile(
                        {
                            apiKey: 'synthetic',
                            counter: new ModelCallCounter(1),
                            file: new File(['synthetic-media'], 'image.png'),
                            expiresAfterSeconds: 3600,
                            fetchImpl,
                        },
                        new AbortController().signal,
                    )
                ).id,
            ).toBe('file-synthetic')
        },
    )
    it.each([400, 404])('sanitizes plain/empty HTTP %i without retry', async (status) => {
        let calls = 0
        const fetchImpl: typeof fetch = async () => {
            calls++
            return new Response(status === 404 ? null : 'private content', { status })
        }
        await expect(
            uploadMetaFile(
                { apiKey: 'synthetic', counter: new ModelCallCounter(1), file: new File(['x'], 'x'), fetchImpl },
                new AbortController().signal,
            ),
        ).rejects.toThrow('provider_error')
        expect(calls).toBe(1)
    })
})

it('retains failed upload attempts and refuses another upload when the shared cap is exhausted', async () => {
    const counter = new ModelCallCounter(1)
    let calls = 0
    const options = {
        apiKey: 'synthetic',
        counter,
        file: new File(['x'], 'x'),
        fetchImpl: async (): Promise<Response> => {
            calls++
            return new Response(null, { status: 404 })
        },
    }
    await expect(uploadMetaFile(options, new AbortController().signal)).rejects.toThrow('provider_error')
    await expect(uploadMetaFile(options, new AbortController().signal)).rejects.toThrow('budget_exhausted')
    expect(counter.used).toBe(1)
    expect(calls).toBe(1)
})
