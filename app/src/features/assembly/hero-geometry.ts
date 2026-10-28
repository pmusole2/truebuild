import type { NormalizedBox } from '@truebuild/contracts'
import { containRect, type Rect, type Size } from './frame-geometry'

const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0 }
// Slack for floating point when a region exactly fills the visible window.
const EPSILON = 1e-9

function positive(value: number): boolean {
    return Number.isFinite(value) && value > 0
}

/** A box that lies wholly inside the image with a real area. Anything else cannot be protected, so it is not guessed at. */
function validBox(box: NormalizedBox): boolean {
    return (
        Number.isFinite(box.x) &&
        Number.isFinite(box.y) &&
        positive(box.width) &&
        positive(box.height) &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= 1 + EPSILON &&
        box.y + box.height <= 1 + EPSILON
    )
}

/** The offset that centres `centre` in a container, then keeps both image edges at or beyond the container's edges. */
function placeAxis(container: number, image: number, centre: number): number {
    return Math.min(0, Math.max(container - image, container / 2 - centre * image))
}

/**
 * Where the hero draws its picture inside the hero frame. The picture fills the frame (a cover crop), centred on the
 * union of the regions that must stay visible and clamped so no blank edge shows. If one cover crop cannot keep every
 * required region in view, or one of them is not a valid box, the whole picture is contained instead: evidence is never
 * cropped away. The same rect places the pixels and every overlay, so they cannot drift apart.
 *
 * Invalid sizes give an empty rect, like `containRect`. The full uncropped picture and its tap geometry stay in More.
 */
export function heroImageRect(container: Size, image: Size, protectedRegions: readonly NormalizedBox[] = []): Rect {
    if (
        !positive(container.width) ||
        !positive(container.height) ||
        !positive(image.width) ||
        !positive(image.height)
    ) {
        return ZERO
    }
    if (!protectedRegions.every(validBox)) {
        return containRect(container, image)
    }
    const scale = Math.max(container.width / image.width, container.height / image.height)
    const width = image.width * scale
    const height = image.height * scale
    if (protectedRegions.length === 0) {
        return { x: (container.width - width) / 2, y: (container.height - height) / 2, width, height }
    }
    const left = Math.min(...protectedRegions.map((box) => box.x))
    const top = Math.min(...protectedRegions.map((box) => box.y))
    const right = Math.max(...protectedRegions.map((box) => box.x + box.width))
    const bottom = Math.max(...protectedRegions.map((box) => box.y + box.height))
    if ((right - left) * width > container.width + EPSILON || (bottom - top) * height > container.height + EPSILON) {
        return containRect(container, image)
    }
    return {
        x: placeAxis(container.width, width, (left + right) / 2),
        y: placeAxis(container.height, height, (top + bottom) / 2),
        width,
        height,
    }
}
