import { describe, expect, it } from 'vitest'
import { normalizedSize, NORMALIZED_TARGET_BYTES } from './normalization-policy'

describe('phone photo app budgets', () => {
    it.each([
        [8064, 6048],
        [4032, 3024],
        [3024, 4032],
    ])('resizes %i by %i instead of rejecting full resolution', (width, height) => {
        const size = normalizedSize(width, height)
        expect(Math.max(size.width, size.height)).toBe(1280)
        expect(size.width / size.height).toBeCloseTo(width / height, 2)
    })
    it('bounds aggregate twenty-page uploads below the existing byte ceiling', () => {
        expect(NORMALIZED_TARGET_BYTES * 20).toBeLessThan(8_388_608)
        expect(() => normalizedSize(100_000, 100_000)).toThrow()
    })
})
