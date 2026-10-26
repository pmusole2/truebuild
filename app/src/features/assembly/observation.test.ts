import { describe, expect, it } from 'vitest'
import { SEGMENTATION_MAX_PIXELS, segmentationSize } from './segmentation-size'

describe('segmentation downsample', () => {
    it('leaves an image at or under the ceiling unchanged', () => {
        expect(segmentationSize(1024, 1024)).toEqual({ width: 1024, height: 1024 })
    })

    it('reduces a large photo under the ceiling while keeping its aspect ratio (no crop)', () => {
        const size = segmentationSize(4032, 3024)
        expect(size.width * size.height).toBeLessThanOrEqual(SEGMENTATION_MAX_PIXELS)
        expect(size.width / size.height).toBeCloseTo(4032 / 3024, 2)
    })

    it('keeps both sides at least one pixel for an extreme aspect ratio', () => {
        const size = segmentationSize(20000, 10)
        expect(size.width * size.height).toBeLessThanOrEqual(SEGMENTATION_MAX_PIXELS)
        expect(size.height).toBeGreaterThanOrEqual(1)
    })
})
