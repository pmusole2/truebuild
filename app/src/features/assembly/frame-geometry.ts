import type { NormalizedBox } from '@truebuild/contracts'

export type Size = { readonly width: number; readonly height: number }
export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export type Point = { readonly x: number; readonly y: number }

/** Where a whole image lands when contain-fitted and centred in a container. Letterbox bands fall outside this rect. */
export function containRect(container: Size, image: Size): Rect {
    if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
        return { x: 0, y: 0, width: 0, height: 0 }
    }
    const scale = Math.min(container.width / image.width, container.height / image.height)
    const width = image.width * scale
    const height = image.height * scale
    return {
        x: (container.width - width) / 2,
        y: (container.height - height) / 2,
        width,
        height,
    }
}

/**
 * Maps a tap inside the container to normalized image coordinates. Taps on letterbox bands return null: they do not
 * point at the photo, so no question target is created from them.
 */
export function normalizedPointFromTap(tap: Point, container: Size, image: Size): Point | null {
    const rect = containRect(container, image)
    if (rect.width <= 0 || rect.height <= 0) {
        return null
    }
    const inside = tap.x >= rect.x && tap.x <= rect.x + rect.width && tap.y >= rect.y && tap.y <= rect.y + rect.height
    if (!inside) {
        return null
    }
    return {
        x: clamp01((tap.x - rect.x) / rect.width),
        y: clamp01((tap.y - rect.y) / rect.height),
    }
}

/** Places a normalized box (relative to the whole image) onto the photo's displayed rect. */
export function boxOnDisplay(box: NormalizedBox, displayed: Rect): Rect {
    return {
        x: displayed.x + box.x * displayed.width,
        y: displayed.y + box.y * displayed.height,
        width: box.width * displayed.width,
        height: box.height * displayed.height,
    }
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value))
}
