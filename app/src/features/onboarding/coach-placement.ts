import type { Rect } from './coach-types'

export type Insets = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
export type Size = { readonly width: number; readonly height: number }

export type Placement = {
    readonly x: number
    readonly y: number
    readonly side: 'below' | 'above' | 'bottom' | 'top'
    // The arrow sits on the bubble edge facing the target; null when it would point into space.
    readonly arrow: { readonly x: number; readonly direction: 'up' | 'down' } | null
    // True only for an informational surface the bubble could not avoid; never for an actionable target.
    readonly coversTarget: boolean
}

export const BUBBLE_MAX_WIDTH = 320
export const BUBBLE_MARGIN = 16
export const SAFE_MARGIN = 8
export const ARROW_GAP = 12
export const RING_PAD = 4
export const ARROW_CORNER = 24
// The bubble never takes more than this share of the safe height; its sentence scrolls past it.
export const BUBBLE_MAX_SHARE = 0.45

export function bubbleWidth(window: Size, insets: Insets, large = false): number {
    const available = window.width - insets.left - insets.right - 2 * BUBBLE_MARGIN
    return large ? available : Math.min(BUBBLE_MAX_WIDTH, available)
}

export function bubbleMaxHeight(window: Size, insets: Insets, large = false): number {
    return Math.floor((large ? 0.6 : BUBBLE_MAX_SHARE) * (window.height - insets.top - insets.bottom))
}

/** The cutout: the target grown by the ring's padding. */
export function cutoutOf(target: Rect): Rect {
    return {
        x: target.x - RING_PAD,
        y: target.y - RING_PAD,
        width: target.width + 2 * RING_PAD,
        height: target.height + 2 * RING_PAD,
    }
}

function overlap(a: Rect, b: Rect): number {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    return width > 0 && height > 0 ? width * height : 0
}

/**
 * Where the bubble goes, deterministically: below the target, above it, pinned to the bottom, pinned to the top; the
 * first that fits the safe area and, for an actionable target, leaves it uncovered. An actionable target that no
 * placement can leave uncovered returns null, so that tip is deferred rather than drawn over its own control. A surface
 * falls back to the placement that covers the least of it.
 */
export function placeBubble(input: {
    readonly target: Rect
    readonly bubble: Size
    readonly window: Size
    readonly insets: Insets
    readonly actionable: boolean
}): Placement | null {
    const { target, bubble, window, insets, actionable } = input
    const cutout = cutoutOf(target)
    const safe = {
        top: insets.top + SAFE_MARGIN,
        bottom: window.height - insets.bottom - SAFE_MARGIN,
    }
    const minX = insets.left + BUBBLE_MARGIN
    const maxX = Math.max(minX, window.width - insets.right - BUBBLE_MARGIN - bubble.width)
    const x = Math.min(maxX, Math.max(minX, target.x + target.width / 2 - bubble.width / 2))
    const candidates: readonly { side: Placement['side']; y: number }[] = [
        { side: 'below', y: cutout.y + cutout.height + ARROW_GAP },
        { side: 'above', y: cutout.y - ARROW_GAP - bubble.height },
        { side: 'bottom', y: safe.bottom - bubble.height },
        { side: 'top', y: safe.top },
    ]
    const fits = (y: number): boolean => y >= safe.top && y + bubble.height <= safe.bottom
    let best: { side: Placement['side']; y: number; covered: number } | null = null
    for (const candidate of candidates) {
        if (!fits(candidate.y)) continue
        const covered = overlap({ x, y: candidate.y, width: bubble.width, height: bubble.height }, cutout)
        if (covered === 0) {
            best = { ...candidate, covered }
            break
        }
        if (!actionable && (best === null || covered < best.covered)) {
            best = { ...candidate, covered }
        }
    }
    if (best === null) return null
    const centre = target.y + target.height / 2
    const above = best.y + bubble.height / 2 > centre
    const edge = above ? best.y : best.y + bubble.height
    const reaches = Math.abs(centre - edge) <= bubble.height
    const arrowX = Math.min(bubble.width - ARROW_CORNER, Math.max(ARROW_CORNER, target.x + target.width / 2 - x))
    return {
        x,
        y: best.y,
        side: best.side,
        arrow: reaches && best.covered === 0 ? { x: arrowX, direction: above ? 'up' : 'down' } : null,
        coversTarget: best.covered > 0,
    }
}

/** A rect is a usable target when it is finite, non-empty, large enough for a control and inside the safe area. */
export function validRect(
    rect: Rect | null,
    window: Size,
    insets: Insets,
    kind: 'control' | 'surface',
    minimum: number,
): rect is Rect {
    if (rect === null) return false
    const { x, y, width, height } = rect
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false
    if (kind === 'control' && Math.min(width, height) < minimum - 1) return false
    const left = insets.left
    const right = window.width - insets.right
    const top = insets.top
    const bottom = window.height - insets.bottom
    // A control must lie wholly inside the safe window; a half-visible control is skipped, never clamped into a lie.
    return kind === 'control'
        ? x >= left - 1 && y >= top - 1 && x + width <= right + 1 && y + height <= bottom + 1
        : x < right && x + width > left && y < bottom && y + height > top
}
