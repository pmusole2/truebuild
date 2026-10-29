import { describe, expect, it } from 'vitest'
import {
    BUBBLE_MAX_SHARE,
    bubbleMaxHeight,
    bubbleWidth,
    cutoutOf,
    placeBubble,
    validRect,
    type Insets,
    type Size,
} from './coach-placement'
import type { Rect } from './coach-types'

const WINDOW: Size = { width: 390, height: 844 }
const INSETS: Insets = { top: 47, right: 0, bottom: 34, left: 0 }
const BUBBLE: Size = { width: 320, height: 160 }

function place(
    target: Rect,
    options: { bubble?: Size; actionable?: boolean; window?: Size } = {},
): ReturnType<typeof placeBubble> {
    return placeBubble({
        target,
        bubble: options.bubble ?? BUBBLE,
        window: options.window ?? WINDOW,
        insets: INSETS,
        actionable: options.actionable ?? true,
    })
}

function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

describe('placeBubble preference order', () => {
    it('goes below a target near the top, with its arrow up', () => {
        const target = { x: 300, y: 60, width: 44, height: 44 }
        const placed = place(target)
        expect(placed?.side).toBe('below')
        expect(placed?.arrow?.direction).toBe('up')
        expect(placed?.y).toBeGreaterThan(target.y + target.height)
    })

    it('goes above a bottom-bar primary, with its arrow down', () => {
        const target = { x: 16, y: 730, width: 358, height: 56 }
        const placed = place(target)
        expect(placed?.side).toBe('above')
        expect(placed?.arrow?.direction).toBe('down')
        expect((placed?.y ?? 0) + BUBBLE.height).toBeLessThan(target.y)
    })

    it('pins to the bottom when a mid-screen target leaves no room above or below, without covering it', () => {
        const target = { x: 150, y: 330, width: 90, height: 90 }
        const tall: Size = { width: 320, height: 340 }
        const placed = place(target, { bubble: tall })
        expect(placed).not.toBeNull()
        expect(overlaps({ x: placed!.x, y: placed!.y, ...tall }, cutoutOf(target))).toBe(false)
    })

    it('keeps the bubble inside the safe area, and clamps it horizontally for a target at the edge', () => {
        const target = { x: 340, y: 60, width: 44, height: 44 }
        const placed = place(target)!
        expect(placed.x + BUBBLE.width).toBeLessThanOrEqual(WINDOW.width - 16)
        expect(placed.x).toBeGreaterThanOrEqual(16)
        expect(placed.y).toBeGreaterThanOrEqual(INSETS.top + 8)
        expect(placed.y + BUBBLE.height).toBeLessThanOrEqual(WINDOW.height - INSETS.bottom - 8)
        // The arrow base never slides onto the rounded corner.
        expect(placed.arrow!.x).toBeGreaterThanOrEqual(24)
        expect(placed.arrow!.x).toBeLessThanOrEqual(BUBBLE.width - 24)
    })
})

describe('placeBubble never covers an actionable target', () => {
    it('withholds the tip when no placement can clear the target', () => {
        // A control as tall as the safe area leaves no free space for the bubble.
        const target = { x: 20, y: 60, width: 350, height: 740 }
        expect(place(target, { actionable: true })).toBeNull()
    })

    it('lets an informational surface be partly covered, with the least cover, and says so', () => {
        const hero = { x: 0, y: 100, width: 390, height: 600 }
        const placed = place(hero, { actionable: false, bubble: { width: 320, height: 260 } })
        expect(placed).not.toBeNull()
        expect(placed!.coversTarget).toBe(true)
        expect(placed!.arrow).toBeNull()
    })

    it.each([
        ['small phone, largest text', { width: 320, height: 568 }, { width: 288, height: 255 }],
        ['regular phone', WINDOW, { width: 320, height: 200 }],
    ])('never overlaps a bottom-bar target (%s)', (_label, window, bubble) => {
        const target = { x: 16, y: window.height - INSETS.bottom - 70, width: window.width - 32, height: 56 }
        const placed = place(target, { window, bubble })
        if (placed !== null) {
            expect(overlaps({ x: placed.x, y: placed.y, ...bubble }, cutoutOf(target))).toBe(false)
        }
    })
})

describe('bubble size', () => {
    it('is at most 320 wide and fits narrow windows with margins', () => {
        expect(bubbleWidth(WINDOW, INSETS)).toBe(320)
        expect(bubbleWidth({ width: 320, height: 568 }, INSETS)).toBe(288)
    })

    it('caps at 45 percent of the safe height, past which the sentence scrolls', () => {
        expect(BUBBLE_MAX_SHARE).toBe(0.45)
        expect(bubbleMaxHeight(WINDOW, INSETS)).toBe(Math.floor(0.45 * (844 - 47 - 34)))
    })
})

describe('validRect', () => {
    const min = 44
    it.each([
        ['null', null],
        ['empty', { x: 0, y: 0, width: 0, height: 0 }],
        ['not finite', { x: Number.NaN, y: 10, width: 50, height: 50 }],
        ['too small for a control', { x: 10, y: 100, width: 30, height: 30 }],
        ['off the window', { x: 10, y: 900, width: 100, height: 50 }],
        ['half under the home indicator', { x: 10, y: 800, width: 100, height: 56 }],
    ])('rejects a control that is %s', (_label, rect) => {
        expect(validRect(rect, WINDOW, INSETS, 'control', min)).toBe(false)
    })

    it('accepts a real control and a partly visible picture surface', () => {
        expect(validRect({ x: 10, y: 100, width: 100, height: 56 }, WINDOW, INSETS, 'control', min)).toBe(true)
        expect(validRect({ x: 0, y: 40, width: 390, height: 400 }, WINDOW, INSETS, 'surface', min)).toBe(true)
    })
})
