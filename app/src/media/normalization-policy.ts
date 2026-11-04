/** App limits, not Meta provider limits. Originals get a separate read/decode ceiling before safe downsampling. */
export const RAW_IMAGE_MAX_BYTES = 32 * 1_048_576
export const RAW_IMAGE_MAX_PIXELS = 80_000_000
/** Per-page encoded target. Twelve pages plus metadata stay inside the 8 MiB multipart ceiling below. */
export const NORMALIZED_TARGET_BYTES = 262_144
export const NORMALIZED_MAX_EDGE = 1280
/** Readability floor for the short side. A source below it keeps its own short side: no upscaling. */
export const NORMALIZED_MIN_SHORT_EDGE = 768
/** Output pixel ceiling; bounds the growth the readability floor can cause on extreme aspect ratios. */
export const NORMALIZED_MAX_PIXELS = 4_194_304
const EXTREME_ASPECT_RATIO = 2
export const NORMALIZED_MAX_DIMENSION = 16_384

export type PixelSize = { readonly width: number; readonly height: number }

/**
 * Target dimensions for decode and encode. Normal pages keep the 1280 long-edge scale; the short-side floor only
 * applies only at aspect ratios of 2:1 or longer, and the pixel ceiling bounds what the floor can grow. Never upscales.
 */
export function normalizedSize(width: number, height: number, edge = NORMALIZED_MAX_EDGE): PixelSize {
    if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        width * height > RAW_IMAGE_MAX_PIXELS
    ) {
        throw new Error('Invalid image dimensions')
    }
    const edgeScale = Math.min(1, edge / Math.max(width, height))
    const floorScale = Math.min(1, shortEdgeFloor(width, height) / Math.min(width, height))
    const pixelScale = Math.min(1, Math.sqrt(NORMALIZED_MAX_PIXELS / (width * height)))
    const scale = Math.min(
        Math.max(edgeScale, floorScale),
        pixelScale,
        NORMALIZED_MAX_DIMENSION / Math.max(width, height),
    )
    const atEdge = (longEdge: number): PixelSize => {
        const boundedScale = Math.min(1, longEdge / Math.max(width, height))
        return {
            width: Math.max(1, Math.round(width * boundedScale)),
            height: Math.max(1, Math.round(height * boundedScale)),
        }
    }
    let high = Math.max(1, Math.round(Math.max(width, height) * scale))
    let low = 1
    // The SDK rounds proportional dimensions from a symmetric decode box. Bound that result, not an independent axis.
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const candidate = atEdge(middle)
        if (candidate.width * candidate.height <= NORMALIZED_MAX_PIXELS) low = middle
        else high = middle - 1
    }
    return atEdge(low)
}

/**
 * Next quality-retry size: 80% of the current size, but never a short side below the floor.
 * Returns the same size when the floor already binds, so a retry then lowers quality only.
 */
export function shrunkSize(size: PixelSize, floor: number): PixelSize {
    const short = Math.min(size.width, size.height)
    const scale = Math.max(0.8, floor / short)
    if (scale >= 1) {
        return size
    }
    return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

/** Readability floor for a source: the readable short side, capped at the source's own short side (no upscaling). */
export function shortEdgeFloor(width: number, height: number): number {
    return Math.max(width, height) / Math.min(width, height) >= EXTREME_ASPECT_RATIO
        ? Math.min(NORMALIZED_MIN_SHORT_EDGE, width, height)
        : 0
}
