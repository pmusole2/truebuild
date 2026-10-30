import { describe, expect, it } from 'vitest'
import {
    composeNativeMeterMarkers,
    nativeMeterOriginInheritance,
    parseNativeMeterMarkers,
} from './native-meter-markers'

describe('trusted native meter marker segments', () => {
    it('composes document ownership, origin and capability without discarding an ordinary native id', () => {
        const id = composeNativeMeterMarkers(
            'ordinary-id',
            'truebuild-document-root:abc',
            'truebuild-render-origin:generated',
            'truebuild-capability-internals:ManualPage',
        )
        expect(id).toBe(
            'ordinary-id|truebuild-document-root:abc|truebuild-render-origin:generated|truebuild-capability-internals:ManualPage',
        )
        expect(parseNativeMeterMarkers(id)).toMatchObject({
            documentRoot: 'abc',
            origin: 'generated',
            capability: 'ManualPage',
            development: false,
        })
    })

    it.each([
        'truebuild-document-root:',
        'truebuild-document-navigation:bad value',
        'truebuild-document-content-boundary',
        'truebuild-render-origin:generated|truebuild-render-origin:fallback',
        'truebuild-document-root:one|truebuild-document-root:two',
        'truebuild-render-origin:generated|truebuild-capability-internals:Unknown',
        'truebuild-document-root:abc|truebuild-meter-exclude:everything',
        'truebuild-render-orign:generated',
        'truebuild-unknown:value',
    ])('rejects invalid or conflicting reserved segment %s', (id) => {
        expect(() => parseNativeMeterMarkers(id)).toThrow('invalid_native_meter_marker')
        expect(() => composeNativeMeterMarkers(id)).toThrow('invalid_native_meter_marker')
    })

    it('accepts repeated identical markers and ignores unrelated namespaces', () => {
        expect(parseNativeMeterMarkers('ordinary-id|another:generated')).toMatchObject({ origin: null })
        expect(parseNativeMeterMarkers('truebuild-render-origin:shell|truebuild-render-origin:shell').origin).toBe(
            'shell',
        )
    })

    it.each(['navigation', 'content-boundary'])(
        'allows the %s boundary its own origin but resets unmarked descendants to shell',
        (kind) => {
            for (const origin of ['generated', 'fallback', 'shell'] as const) {
                const marked = parseNativeMeterMarkers(
                    `truebuild-document-${kind}:route|truebuild-render-origin:${origin}`,
                )
                expect(nativeMeterOriginInheritance(marked, 'generated')).toEqual({ origin, childOrigin: 'shell' })
            }
            const unmarked = parseNativeMeterMarkers(`truebuild-document-${kind}:route`)
            expect(nativeMeterOriginInheritance(unmarked, 'generated')).toEqual({
                origin: 'shell',
                childOrigin: 'shell',
            })
            const child = parseNativeMeterMarkers('truebuild-document-root:body|truebuild-render-origin:generated')
            expect(nativeMeterOriginInheritance(child, 'shell')).toEqual({
                origin: 'generated',
                childOrigin: 'generated',
            })
        },
    )
})
