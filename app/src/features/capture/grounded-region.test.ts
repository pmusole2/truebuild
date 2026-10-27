import { describe, expect, it } from 'vitest'
import { groundedRegion } from './grounded-region'

describe('shared check and optional question observation geometry', () => {
    it('uses the normalized observedRegion without renaming or changing coordinates', () => {
        const region = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
        expect(groundedRegion({ observedRegion: region })).toEqual(region)
    })
    it.each([null, {}, { observedRegion: null }, { observedRegion: { x: 0.8, y: 0, width: 0.3, height: 1 } }])(
        'omits absent or invalid regions without inventing geometry: %j',
        (value) => {
            expect(groundedRegion(value)).toBeNull()
        },
    )
})
