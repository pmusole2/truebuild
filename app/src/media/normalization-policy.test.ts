import { describe, expect, it } from 'vitest'
import { LIMITS } from '@truebuild/contracts'
import { MAX_PARSE_PAGES, MODEL_METADATA_MAX_BYTES } from '@truebuild/contracts/model'
import {
    NORMALIZED_MAX_PIXELS,
    NORMALIZED_MIN_SHORT_EDGE,
    NORMALIZED_TARGET_BYTES,
    normalizedSize,
    shrunkSize,
    shortEdgeFloor,
} from './normalization-policy'

describe('normalized size', () => {
    it.each([
        // A4 at 300 dpi, A4 at 150 dpi, and US letter, portrait and landscape: the long edge is 1280 as before.
        { width: 2480, height: 3508, expected: { width: 905, height: 1280 } },
        { width: 3508, height: 2480, expected: { width: 1280, height: 905 } },
        { width: 1240, height: 1754, expected: { width: 905, height: 1280 } },
        { width: 2550, height: 3300, expected: { width: 989, height: 1280 } },
        { width: 3300, height: 2550, expected: { width: 1280, height: 989 } },
        { width: 4032, height: 3024, expected: { width: 1280, height: 960 } },
        { width: 1920, height: 1080, expected: { width: 1280, height: 720 } },
    ])('keeps $width×$height at the prior 1280 long edge', ({ width, height, expected }) => {
        expect(normalizedSize(width, height)).toEqual(expected)
    })

    it('keeps a 438×2625 tall strip at its own short side instead of shrinking it to 214', () => {
        // The source short side is below the readability floor: it cannot be upscaled, and it must not shrink.
        expect(normalizedSize(438, 2625)).toEqual({ width: 438, height: 2625 })
    })

    it('raises the short side to the readability floor for a very long page, then bounds its pixels', () => {
        expect(normalizedSize(1000, 5000)).toEqual({ width: NORMALIZED_MIN_SHORT_EDGE, height: 3840 })
        // A 1:6 page also retains the 768px short side within the local pixel ceiling.
        expect(normalizedSize(1000, 6000)).toEqual({ width: 768, height: 4608 })

        const extreme = normalizedSize(1000, 40_000)
        expect(extreme.width * extreme.height).toBeLessThanOrEqual(NORMALIZED_MAX_PIXELS)
        expect(extreme.height).toBeLessThanOrEqual(40_000)
    })

    it('keeps the SDK symmetric-box rounded result within the pixel ceiling', () => {
        const size = normalizedSize(2689, 21312)
        expect(size).toEqual({ width: 727, height: 5765 })
        const edge = Math.max(size.width, size.height)
        expect(Math.round((2689 * edge) / 21312) * edge).toBeLessThanOrEqual(NORMALIZED_MAX_PIXELS)
    })

    it('never upscales a source that is already small', () => {
        expect(normalizedSize(400, 300)).toEqual({ width: 400, height: 300 })
    })

    it('rejects impossible or oversized raw dimensions', () => {
        expect(() => normalizedSize(100_000, 100_000)).toThrow()
        expect(() => normalizedSize(0, 100)).toThrow()
    })
})

describe('shrunk size', () => {
    it('keeps ordinary page retries identical to the previous 80 percent resize', () => {
        const floor = shortEdgeFloor(2480, 3508)
        expect(floor).toBe(0)
        expect(shrunkSize({ width: 905, height: 1280 }, floor)).toEqual({ width: 724, height: 1024 })
    })
    it('shrinks by 80% while the short side stays at or above the floor', () => {
        expect(shrunkSize({ width: 1280, height: 960 }, NORMALIZED_MIN_SHORT_EDGE)).toEqual({
            width: 1024,
            height: 768,
        })
    })

    it('stops at the floor instead of dropping the short side below it', () => {
        expect(shrunkSize({ width: 1024, height: 768 }, NORMALIZED_MIN_SHORT_EDGE)).toEqual({
            width: 1024,
            height: 768,
        })
        expect(shrunkSize({ width: 438, height: 2625 }, 438)).toEqual({ width: 438, height: 2625 })
    })
})

describe('encoding budget', () => {
    it('fits twelve encoded pages and the full metadata allowance inside an actual 8 MiB multipart body', async () => {
        const form = new FormData()
        form.set('metadata', ' '.repeat(MODEL_METADATA_MAX_BYTES))
        for (let page = 0; page < MAX_PARSE_PAGES; page++) {
            form.set(
                `page-${page}`,
                new Blob([new Uint8Array(NORMALIZED_TARGET_BYTES)], { type: 'image/jpeg' }),
                `page-${page}.jpg`,
            )
        }
        const serialized = await new Request('http://localhost', { method: 'POST', body: form }).arrayBuffer()
        expect(serialized.byteLength).toBeLessThan(LIMITS.requestBytes)
    })
})
