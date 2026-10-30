import { describe, expect, it } from 'vitest'
import { mergeNativeIds, originId, parseOrigin, withOriginSegment } from './render-origin'
import { InvalidNativeMeterMarker } from './native-meter-markers'

describe('strict render-origin parsing (native-meter-markers backed)', () => {
    it('reads a single valid origin and ignores unrelated namespaces', () => {
        expect(parseOrigin('ordinary-id|truebuild-render-origin:generated')).toBe('generated')
        expect(parseOrigin('truebuild-document-root:abc|truebuild-render-origin:fallback')).toBe('fallback')
        expect(parseOrigin('ordinary-id')).toBeNull()
        expect(parseOrigin(undefined)).toBeNull()
    })

    it('rejects the whole id when a later segment is invalid or conflicts (no first-valid hiding)', () => {
        for (const suffix of [
            'truebuild-render-origin:fallback',
            'truebuild-render-origin:bogus',
            'truebuild-capability-internals:Unknown',
            'truebuild-document-root:bad value',
            'truebuild-render-orign:generated',
        ]) {
            expect(() => parseOrigin(`truebuild-render-origin:generated|${suffix}`)).toThrow(InvalidNativeMeterMarker)
        }
    })

    it('accepts repeated identical origins', () => {
        expect(parseOrigin('truebuild-render-origin:shell|truebuild-render-origin:shell')).toBe('shell')
    })
})

describe('mergeNativeIds composed through the strict helper', () => {
    it('preserves ordinary ids, dedupes and keeps reserved markers', () => {
        expect(mergeNativeIds('ordinary-id', 'truebuild-document-root:abc', originId('generated'))).toBe(
            'ordinary-id|truebuild-document-root:abc|truebuild-render-origin:generated',
        )
        expect(mergeNativeIds('a|b', 'b|c')).toBe('a|b|c')
        expect(mergeNativeIds(undefined, null, '')).toBeUndefined()
        expect(withOriginSegment('ordinary-id', 'shell')).toBe('ordinary-id|truebuild-render-origin:shell')
    })

    it('throws for malformed/conflicting provenance so a child cannot recover inherited generated credit', () => {
        for (const suffix of [
            'truebuild-render-origin:fallback',
            'truebuild-render-origin:bogus',
            'truebuild-document-root:bad value',
            'truebuild-render-orign:generated',
        ]) {
            expect(() => mergeNativeIds('ordinary-id', originId('generated'), suffix)).toThrow(InvalidNativeMeterMarker)
        }
        expect(() => withOriginSegment('truebuild-render-origin:bogus|ordinary-id', 'generated')).toThrow(
            InvalidNativeMeterMarker,
        )
    })
})
