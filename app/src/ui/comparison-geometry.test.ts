import { describe, expect, it } from 'vitest'
import { clampBox, percentBox } from './comparison-geometry'

describe('clampBox', () => {
    it('keeps a box that already lies inside the frame unchanged', () => {
        expect(clampBox({ x: 0.2, y: 0.3, width: 0.4, height: 0.1 })).toEqual({
            x: 0.2,
            y: 0.3,
            width: 0.4,
            height: 0.1,
        })
    })

    it('clips a box that overhangs the right or bottom edge to the frame', () => {
        const clipped = clampBox({ x: 0.8, y: 0.9, width: 0.5, height: 0.5 })
        expect(clipped).not.toBeNull()
        expect(clipped?.x).toBeCloseTo(0.8, 10)
        expect(clipped?.y).toBeCloseTo(0.9, 10)
        expect(clipped?.width).toBeCloseTo(0.2, 10)
        expect(clipped?.height).toBeCloseTo(0.1, 10)
    })

    it('pulls a box that starts outside the frame back onto it', () => {
        expect(clampBox({ x: -0.1, y: 1.4, width: 0.3, height: 0.3 })).toBeNull()
        expect(clampBox({ x: -0.1, y: 0.5, width: 0.3, height: 0.2 })).toEqual({
            x: 0,
            y: 0.5,
            width: 0.3,
            height: 0.2,
        })
    })

    it('rejects non-finite, empty or fully outside boxes instead of drawing them', () => {
        expect(clampBox({ x: Number.NaN, y: 0, width: 0.2, height: 0.2 })).toBeNull()
        expect(clampBox({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 0.2 })).toBeNull()
        expect(clampBox({ x: 0.1, y: 0.1, width: 0, height: 0.2 })).toBeNull()
        expect(clampBox({ x: 1, y: 0.1, width: 0.2, height: 0.2 })).toBeNull()
    })
})

describe('percentBox', () => {
    it('expresses the clipped box as percentages of the frame for absolute positioning', () => {
        expect(percentBox({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 })).toEqual({
            left: '25%',
            top: '50%',
            width: '50%',
            height: '25%',
        })
    })

    it('returns null for an invalid box so nothing is drawn', () => {
        expect(percentBox({ x: 0, y: 0, width: -1, height: 0.2 })).toBeNull()
    })
})
