/** App limits, not Meta provider limits. Originals get a separate read/decode ceiling before safe downsampling. */
export const RAW_IMAGE_MAX_BYTES = 32 * 1_048_576
export const RAW_IMAGE_MAX_PIXELS = 80_000_000
export const NORMALIZED_TARGET_BYTES = 262_144
export const NORMALIZED_MAX_EDGE = 1280

export function normalizedSize(
    width: number,
    height: number,
    edge = NORMALIZED_MAX_EDGE,
): { width: number; height: number } {
    if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        width * height > RAW_IMAGE_MAX_PIXELS
    ) {
        throw new Error('Invalid image dimensions')
    }
    const scale = Math.min(1, edge / Math.max(width, height))
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
