import { describe, expect, it } from 'vitest'
import { contrastRatio } from './contrast'
import { colorsFor, darkColors, lightColors, motion, radius, space, touchTarget, type Colors } from './tokens'

// Text pairs must meet WCAG AA body contrast (4.5:1). Non-text pairs (borders of controls, focus rings) meet 3:1.
const TEXT_PAIRS: readonly (readonly [string, keyof Colors, keyof Colors])[] = [
    ['ink on canvas', 'ink', 'canvas'],
    ['ink on surface', 'ink', 'surface'],
    ['ink on raised surface', 'ink', 'surfaceRaised'],
    ['ink on sunken surface', 'ink', 'surfaceSunken'],
    ['muted ink on canvas', 'inkMuted', 'canvas'],
    ['muted ink on surface', 'inkMuted', 'surface'],
    ['muted ink on sunken surface', 'inkMuted', 'surfaceSunken'],
    ['strong button label', 'fillStrongInk', 'fillStrong'],
    ['accent fill label', 'accentFillInk', 'accent'],
    ['accent text on surface', 'accentInk', 'surface'],
    ['pass on surface', 'pass', 'surface'],
    ['pass on pass surface', 'pass', 'passSurface'],
    ['refuse on surface', 'refuse', 'surface'],
    ['refuse on refuse surface', 'refuse', 'refuseSurface'],
    ['caution on surface', 'caution', 'surface'],
    ['caution on caution surface', 'caution', 'cautionSurface'],
    ['inverse text on ink', 'inkInverse', 'ink'],
]

const NON_TEXT_PAIRS: readonly (readonly [string, keyof Colors, keyof Colors])[] = [
    ['control border on surface', 'borderStrong', 'surface'],
    ['focus ring on surface', 'focus', 'surface'],
    ['focus ring on canvas', 'focus', 'canvas'],
]

const SCHEMES: readonly (readonly [string, Colors])[] = [
    ['light', lightColors],
    ['dark', darkColors],
]

describe('theme colour tokens', () => {
    it.each(SCHEMES)('%s scheme meets AA text contrast for every text pair', (_name, colors) => {
        for (const [label, foreground, background] of TEXT_PAIRS) {
            expect(contrastRatio(colors[foreground], colors[background]), label).toBeGreaterThanOrEqual(4.5)
        }
    })

    it.each(SCHEMES)('%s scheme meets 3:1 for non-text control and focus pairs', (_name, colors) => {
        for (const [label, foreground, background] of NON_TEXT_PAIRS) {
            expect(contrastRatio(colors[foreground], colors[background]), label).toBeGreaterThanOrEqual(3)
        }
    })

    it('resolves the scheme to its own palette and never mixes the two', () => {
        expect(colorsFor('light')).toBe(lightColors)
        expect(colorsFor('dark')).toBe(darkColors)
        expect(lightColors.canvas).not.toBe(darkColors.canvas)
    })
})

describe('layout and motion scales', () => {
    it('keeps the spacing and radius scales strictly increasing', () => {
        const spacing = Object.values(space)
        const corners = [radius.sm, radius.md, radius.lg, radius.pill]
        expect(spacing).toEqual([...spacing].sort((a, b) => a - b))
        expect(new Set(spacing).size).toBe(spacing.length)
        expect(corners).toEqual([...corners].sort((a, b) => a - b))
    })

    it('never sizes an interactive target below 44 points', () => {
        expect(touchTarget).toBeGreaterThanOrEqual(44)
    })

    it('has exactly the three approved transition durations, none past 400 ms, and zero meaning immediate', () => {
        expect(motion).toEqual({ instant: 0, fast: 150, standard: 250, emphasis: 350 })
        expect(Math.max(...Object.values(motion))).toBeLessThanOrEqual(400)
    })
})
