// Normalised 0–1 regions over a photo or diagram frame: origin top-left, x to the right, y down. Coordinates are clamped
// to the frame so an overlay can never be drawn outside the photo.

export type NormalizedBox = {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
}

export type PercentBox = {
    readonly left: `${number}%`
    readonly top: `${number}%`
    readonly width: `${number}%`
    readonly height: `${number}%`
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high)
}

/** Returns the box clipped to the frame, or null when any edge is not finite or nothing visible remains. */
export function clampBox(box: NormalizedBox): NormalizedBox | null {
    const values = [box.x, box.y, box.width, box.height]
    if (!values.every((value) => Number.isFinite(value))) {
        return null
    }
    const x = clamp(box.x, 0, 1)
    const y = clamp(box.y, 0, 1)
    const width = clamp(box.width, 0, 1 - x)
    const height = clamp(box.height, 0, 1 - y)
    if (width <= 0 || height <= 0) {
        return null
    }
    return { x, y, width, height }
}

export function percentBox(box: NormalizedBox): PercentBox | null {
    const clipped = clampBox(box)
    if (clipped === null) {
        return null
    }
    return {
        left: `${round(clipped.x * 100)}%`,
        top: `${round(clipped.y * 100)}%`,
        width: `${round(clipped.width * 100)}%`,
        height: `${round(clipped.height * 100)}%`,
    }
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000
}
