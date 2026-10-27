import { describe, expect, it } from 'vitest'
import { contrastRatio, relativeLuminance } from './contrast'

describe('contrastRatio', () => {
    it('reports the WCAG maximum for black on white and 1 for identical colours', () => {
        expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
        expect(contrastRatio('#7A7262', '#7A7262')).toBeCloseTo(1, 5)
    })

    it('is symmetric in its arguments', () => {
        expect(contrastRatio('#1E2225', '#EB8E1F')).toBeCloseTo(contrastRatio('#EB8E1F', '#1E2225'), 10)
    })

    it('uses the linear-light curve, so mid-grey is well below 0.5 relative luminance', () => {
        expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3)
    })

    it('rejects anything that is not a six-digit hex colour instead of guessing', () => {
        expect(() => relativeLuminance('white')).toThrow('#RRGGBB')
        expect(() => relativeLuminance('#FFF')).toThrow('#RRGGBB')
    })
})
