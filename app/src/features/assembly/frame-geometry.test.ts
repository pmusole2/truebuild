import { describe, expect, it } from 'vitest'
import { boxOnDisplay, containRect, normalizedPointFromTap } from './frame-geometry'

describe('frame geometry', () => {
    it('places a wide photo in a tall box with bands above and below, and no crop', () => {
        const rect = containRect({ width: 300, height: 300 }, { width: 600, height: 300 })
        expect(rect).toEqual({ x: 0, y: 75, width: 300, height: 150 })
    })

    it('maps a tap inside the photo to normalized coordinates and ignores taps on the letterbox', () => {
        const container = { width: 300, height: 300 }
        const image = { width: 600, height: 300 }

        expect(normalizedPointFromTap({ x: 150, y: 150 }, container, image)).toEqual({ x: 0.5, y: 0.5 })
        expect(normalizedPointFromTap({ x: 150, y: 10 }, container, image)).toBeNull()
        expect(normalizedPointFromTap({ x: 150, y: 290 }, container, image)).toBeNull()
    })

    it('returns null for a container with no size', () => {
        expect(normalizedPointFromTap({ x: 0, y: 0 }, { width: 0, height: 0 }, { width: 10, height: 10 })).toBeNull()
    })

    it('places a normalized box onto the displayed photo rectangle', () => {
        const displayed = { x: 10, y: 20, width: 200, height: 100 }
        expect(boxOnDisplay({ x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, displayed)).toEqual({
            x: 110,
            y: 70,
            width: 50,
            height: 50,
        })
    })
})
