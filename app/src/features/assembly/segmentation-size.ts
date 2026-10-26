/** Largest SAM input in pixels, matching the frozen downsample ceiling. */
export const SEGMENTATION_MAX_PIXELS = 1_048_576

/** Target dimensions for segmentation: at most the ceiling, aspect kept, both sides at least one pixel. */
export function segmentationSize(width: number, height: number): { width: number; height: number } {
    if (width * height <= SEGMENTATION_MAX_PIXELS) {
        return { width, height }
    }
    const scale = Math.sqrt(SEGMENTATION_MAX_PIXELS / (width * height))
    return {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
    }
}
