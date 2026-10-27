import type { NormalizedBox } from '@truebuild/contracts'
import { boxOnDisplay, containRect, type Rect, type Size } from '../features/assembly/frame-geometry'

// Clips a normalised region to the image. Left and right, and top and bottom, are clipped separately, so an overhanging
// box keeps only its visible part. Non-finite or empty results are rejected rather than drawn.
export function clampBox(box: NormalizedBox): NormalizedBox | null {
    if (![box.x, box.y, box.width, box.height].every((value) => Number.isFinite(value))) {
        return null
    }
    const left = Math.max(box.x, 0)
    const right = Math.min(box.x + box.width, 1)
    const top = Math.max(box.y, 0)
    const bottom = Math.min(box.y + box.height, 1)
    if (right <= left || bottom <= top) {
        return null
    }
    return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Places a normalised region of an image onto the frame, using the image's own size to find where it is letterboxed.
 * Reuses the assembly frame geometry, so the photo and manual diagram share one coordinate system with the check flow.
 */
export function regionOnFrame(box: NormalizedBox, frame: Size, media: Size): Rect | null {
    const clipped = clampBox(box)
    if (clipped === null) {
        return null
    }
    const displayed = containRect(frame, media)
    if (displayed.width <= 0 || displayed.height <= 0) {
        return null
    }
    return boxOnDisplay(clipped, displayed)
}
