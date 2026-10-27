import { describe, expect, it } from 'vitest'
import { clampBox, regionOnFrame } from './comparison-geometry'

describe('clampBox', () => {
    it('keeps a box that already lies inside the frame unchanged', () => {
        const kept = clampBox({ x: 0.2, y: 0.3, width: 0.4, height: 0.1 })
        expect(kept?.x).toBe(0.2)
        expect(kept?.y).toBe(0.3)
        expect(kept?.width).toBeCloseTo(0.4, 10)
        expect(kept?.height).toBeCloseTo(0.1, 10)
    })

    it('clips the left edge separately: a box starting at -0.1 with width 0.3 keeps only 0.2', () => {
        const clipped = clampBox({ x: -0.1, y: 0.5, width: 0.3, height: 0.2 })
        expect(clipped?.x).toBe(0)
        expect(clipped?.width).toBeCloseTo(0.2, 10)
        expect(clipped?.y).toBe(0.5)
        expect(clipped?.height).toBeCloseTo(0.2, 10)
    })

    it('clips the right and bottom edges to the frame without extending past it', () => {
        const clipped = clampBox({ x: 0.8, y: 0.9, width: 0.5, height: 0.5 })
        expect(clipped?.width).toBeCloseTo(0.2, 10)
        expect(clipped?.height).toBeCloseTo(0.1, 10)
    })

    it('rejects non-finite, empty or fully outside boxes instead of drawing them', () => {
        expect(clampBox({ x: Number.NaN, y: 0, width: 0.2, height: 0.2 })).toBeNull()
        expect(clampBox({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 0.2 })).toBeNull()
        expect(clampBox({ x: 0.1, y: 0.1, width: 0, height: 0.2 })).toBeNull()
        expect(clampBox({ x: -0.5, y: 0.1, width: 0.3, height: 0.2 })).toBeNull()
        expect(clampBox({ x: 1, y: 0.1, width: 0.2, height: 0.2 })).toBeNull()
    })
})

describe('regionOnFrame portrait-vs-landscape fit', () => {
    const frame = { width: 300, height: 220 }

    it('places a region on a portrait image letterboxed left and right', () => {
        // Portrait 3000x4000 contains to 165x220 at x=67.5: the left and right bands are letterbox.
        const rect = regionOnFrame({ x: 0, y: 0, width: 0.5, height: 0.5 }, frame, { width: 3000, height: 4000 })
        expect(rect?.x).toBeCloseTo(67.5, 6)
        expect(rect?.y).toBeCloseTo(0, 6)
        expect(rect?.width).toBeCloseTo(82.5, 6)
        expect(rect?.height).toBeCloseTo(110, 6)
    })

    it('places the same region on a landscape image letterboxed top and bottom', () => {
        // Landscape 4000x3000 contains to 293.33x220: a thin band at the sides only, so the offset is small.
        const rect = regionOnFrame({ x: 0, y: 0, width: 0.5, height: 0.5 }, frame, { width: 4000, height: 3000 })
        expect(rect?.x).toBeCloseTo(3.333_333, 5)
        expect(rect?.width).toBeCloseTo(146.666_667, 5)
        expect(rect?.height).toBeCloseTo(110, 6)
    })

    it('returns null when the media has no size, so nothing is positioned from unknown dimensions', () => {
        expect(regionOnFrame({ x: 0, y: 0, width: 0.5, height: 0.5 }, frame, { width: 0, height: 4000 })).toBeNull()
    })
})
