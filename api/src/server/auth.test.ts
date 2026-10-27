import { describe, expect, it } from 'vitest'

import { SharedKeyAuth } from './auth'

const syntheticKey = 'synthetic-local-test-value'

describe('shared header authentication', (): void => {
    it('requires the exact header before reading the request body', (): void => {
        const auth = new SharedKeyAuth({ sharedSecret: syntheticKey })
        for (const supplied of [undefined, '', 'wrong', `${syntheticKey}extra`]) {
            const request = new Request('http://localhost/api/checks', {
                method: 'POST',
                headers: supplied === undefined ? {} : { 'x-truebuild-key': supplied },
                body: '{',
            })
            expect(() => auth.authenticate(request)).toThrow('unauthorized')
            expect(request.bodyUsed).toBe(false)
        }
        expect(() =>
            auth.authenticate(
                new Request('http://localhost', {
                    headers: { 'x-truebuild-key': syntheticKey },
                }),
            ),
        ).not.toThrow()
    })

    it('rejects bearer-only authentication and missing server configuration', (): void => {
        const request = new Request('https://deployed.example/api/checks', {
            headers: { authorization: `Bearer ${syntheticKey}` },
        })
        expect(() => new SharedKeyAuth({}).authenticate(request)).toThrow('unauthorized')
        expect(() => new SharedKeyAuth({ sharedSecret: syntheticKey }).authenticate(request)).toThrow('unauthorized')
    })

    it('fails closed when no shared secret is configured', (): void => {
        expect(() => new SharedKeyAuth({}).authenticate(new Request('http://localhost'))).toThrow('unauthorized')
    })
})
