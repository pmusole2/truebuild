import { LIMITS, PIECE_CUTOUT_MAX_CHARS } from '@truebuild/contracts'
import sharp from 'sharp'

import type { ObservationImage } from './media'

export interface PieceCropResult {
    uri: string
    image: ObservationImage
    box: [number, number, number, number]
    inkRatio: number
}

interface Blob {
    left: number
    top: number
    right: number
    bottom: number
    pixels: number
}

function inkMask(pixels: Uint8Array, width: number, height: number): Uint8Array {
    const stride = width + 1
    const sums = new Float64Array(stride * (height + 1))
    const mask = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
        let sum = 0
        for (let x = 0; x < width; x++) {
            sum += pixels[y * width + x]!
            sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1]! + sum
        }
    }
    // Local contrast keeps shaded paper out without dropping faint printed outlines.
    const radius = 12
    for (let y = 0; y < height; y++) {
        const top = Math.max(0, y - radius)
        const bottom = Math.min(height, y + radius + 1)
        for (let x = 0; x < width; x++) {
            const left = Math.max(0, x - radius)
            const right = Math.min(width, x + radius + 1)
            const mean =
                (sums[bottom * stride + right]! -
                    sums[top * stride + right]! -
                    sums[bottom * stride + left]! +
                    sums[top * stride + left]!) /
                ((bottom - top) * (right - left))
            const value = pixels[y * width + x]!
            mask[y * width + x] = value < 185 && value < mean - 13 ? 1 : 0
        }
    }

    return mask
}

function removeRules(mask: Uint8Array, width: number, height: number, boxWidth: number, boxHeight: number): void {
    const removed = new Uint8Array(mask.length)
    // Slightly sloping rules occur on photographed pages. Scan both axes with bounded slopes.
    for (const vertical of [false, true]) {
        const length = vertical ? height : width
        const breadth = vertical ? width : height
        const minimum = Math.max(48, 0.9 * (vertical ? boxHeight : boxWidth))
        for (let slopeStep = -8; slopeStep <= 8; slopeStep++) {
            const slope = slopeStep / 100
            const overshoot = Math.ceil(length * Math.abs(slope))
            for (let intercept = -overshoot; intercept < breadth + overshoot; intercept++) {
                let start = -1
                let last = -1
                let count = 0
                const finish = (): void => {
                    if (last - start + 1 >= minimum && count / (last - start + 1) >= 0.75) {
                        for (let along = start; along <= last; along++) {
                            const across = Math.round(intercept + along * slope)
                            for (let offset = -1; offset <= 1; offset++) {
                                const position = across + offset
                                if (position >= 0 && position < breadth) {
                                    removed[vertical ? along * width + position : position * width + along] = 1
                                }
                            }
                        }
                    }
                    start = -1
                    count = 0
                }
                for (let along = 0; along < length; along++) {
                    const across = Math.round(intercept + along * slope)
                    const index = vertical ? along * width + across : across * width + along
                    if (across >= 0 && across < breadth && mask[index]) {
                        if (start < 0) start = along
                        last = along
                        count++
                    } else if (start >= 0 && along - last > 3) {
                        finish()
                    }
                }
                if (start >= 0) finish()
            }
        }
    }
    for (let index = 0; index < mask.length; index++) {
        if (removed[index]) mask[index] = 0
    }
}

function blobs(mask: Uint8Array, width: number, height: number): Blob[] {
    const queue = new Uint32Array(mask.length)
    const results: Blob[] = []
    for (let index = 0; index < mask.length; index++) {
        if (!mask[index]) continue
        let head = 0
        let tail = 1
        queue[0] = index
        mask[index] = 0
        const blob: Blob = { left: width, top: height, right: 0, bottom: 0, pixels: 0 }
        while (head < tail) {
            const point = queue[head++]!
            const x = point % width
            const y = Math.floor(point / width)
            blob.left = Math.min(blob.left, x)
            blob.top = Math.min(blob.top, y)
            blob.right = Math.max(blob.right, x)
            blob.bottom = Math.max(blob.bottom, y)
            blob.pixels++
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx
                    const ny = y + dy
                    const next = ny * width + nx
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[next]) {
                        mask[next] = 0
                        queue[tail++] = next
                    }
                }
            }
        }
        if (blob.pixels >= 8) results.push(blob)
    }

    return results
}

/** Locate printed ink near a parse box; all analysis stays local and uses no model calls. */
export async function refinePieceCrop(
    image: ObservationImage,
    drawingBox: readonly [number, number, number, number],
): Promise<PieceCropResult | null> {
    const [x, y, w, h] = drawingBox
    if (
        drawingBox.length !== 4 ||
        !drawingBox.every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        w <= 0 ||
        h <= 0 ||
        x + w > 1 ||
        y + h > 1 ||
        !Number.isSafeInteger(image.width) ||
        !Number.isSafeInteger(image.height) ||
        image.width <= 0 ||
        image.height <= 0 ||
        image.width * image.height > LIMITS.imagePixels ||
        !(image.bytes instanceof Uint8Array) ||
        !image.bytes.length ||
        image.bytes.length > LIMITS.imageBytes
    )
        return null

    try {
        const source = sharp(image.bytes, { limitInputPixels: LIMITS.imagePixels, failOn: 'warning' }).autoOrient()
        const metadata = await source.metadata()
        if (metadata.autoOrient.width !== image.width || metadata.autoOrient.height !== image.height) return null
        // Padding recovers ink that a parse box clips; only the page edge limits it.
        const expansion = 1.1
        const left = Math.max(0, Math.floor((x - expansion * w) * image.width))
        const top = Math.max(0, Math.floor((y - expansion * h) * image.height))
        const right = Math.min(image.width, Math.ceil((x + (1 + expansion) * w) * image.width))
        const bottom = Math.min(image.height, Math.ceil((y + (1 + expansion) * h) * image.height))
        const region = { left, top, width: right - left, height: bottom - top }
        const scale = Math.min(
            1,
            1200 / Math.max(region.width, region.height),
            Math.sqrt(600_000 / (region.width * region.height)),
        )
        const { data, info } = await source
            .clone()
            .extract(region)
            .resize(Math.max(1, Math.round(region.width * scale)), Math.max(1, Math.round(region.height * scale)))
            .flatten({ background: '#ffffff' })
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true })
        const sx = info.width / region.width
        const sy = info.height / region.height
        const boxWidth = w * image.width * sx
        const boxHeight = h * image.height * sy
        const centerX = ((x + w / 2) * image.width - left) * sx
        const centerY = ((y + h / 2) * image.height - top) * sy
        const hintLeft = (x * image.width - left) * sx
        const hintTop = (y * image.height - top) * sy
        const hintRight = ((x + w) * image.width - left) * sx
        const hintBottom = ((y + h) * image.height - top) * sy
        const mask = inkMask(data, info.width, info.height)
        removeRules(mask, info.width, info.height, boxWidth, boxHeight)
        const candidates = blobs(mask, info.width, info.height).filter((blob) => {
            const width = blob.right - blob.left + 1
            const height = blob.bottom - blob.top + 1
            const clipped =
                blob.left === 0 || blob.top === 0 || blob.right === info.width - 1 || blob.bottom === info.height - 1
            // Broken or gently curved table rules can survive the straight-run pass.
            return !(
                (width >= Math.max(48, boxWidth * 0.9) && height < width * 0.12) ||
                (height >= Math.max(48, boxHeight * 0.9) && width < height * 0.12) ||
                (clipped && (width > boxWidth || height > boxHeight) && blob.pixels / (width * height) < 0.1)
            )
        })
        const score = (blob: Blob): number => {
            const distance = Math.hypot(
                ((blob.left + blob.right) / 2 - centerX) / boxWidth,
                ((blob.top + blob.bottom) / 2 - centerY) / boxHeight,
            )
            const extent = Math.max(blob.right - blob.left + 1, blob.bottom - blob.top + 1)
            return (Math.pow(blob.pixels, 0.45) * Math.pow(extent, 0.6)) / Math.pow(0.5 + distance, 2)
        }
        candidates.sort((a, b) => score(b) - score(a))
        const selected = candidates[0]
        if (
            !selected ||
            selected.pixels < Math.max(16, boxWidth * boxHeight * 0.002) ||
            Math.max(selected.right - selected.left + 1, selected.bottom - selected.top + 1) <
                Math.max(5, Math.min(boxWidth, boxHeight) * 0.08)
        )
            return null

        const seed = { ...selected }
        const seedWidth = seed.right - seed.left + 1
        const seedHeight = seed.bottom - seed.top + 1
        const verticalGap = Math.max(3, Math.min(boxHeight, seed.bottom - seed.top + 1) * 0.12)
        // Group detached detail strokes using the seed's extent, never an expanding chain of neighbouring text.
        for (const blob of candidates.slice(1)) {
            // Padding can expose a neighbouring drawing; only strokes centred inside the parse box may join the seed.
            const blobX = (blob.left + blob.right) / 2
            const blobY = (blob.top + blob.bottom) / 2
            if (blobX < hintLeft || blobX > hintRight || blobY < hintTop || blobY > hintBottom) continue
            const dx = Math.max(0, seed.left - blob.right, blob.left - seed.right)
            const dy = Math.max(0, seed.top - blob.bottom, blob.top - seed.bottom)
            const peer =
                blob.pixels >= seed.pixels * 0.15 &&
                Math.max(blob.right - blob.left + 1, blob.bottom - blob.top + 1) >=
                    Math.max(seedWidth, seedHeight) * 0.25
            const horizontalGap = Math.max(4, Math.min(boxWidth, seedWidth) * (peer ? 0.5 : 0.12))
            if (Math.hypot(dx / horizontalGap, dy / verticalGap) > 1) continue
            selected.left = Math.min(selected.left, blob.left)
            selected.top = Math.min(selected.top, blob.top)
            selected.right = Math.max(selected.right, blob.right)
            selected.bottom = Math.max(selected.bottom, blob.bottom)
            selected.pixels += blob.pixels
        }
        const margin = Math.max(
            3,
            Math.ceil(Math.max(selected.right - selected.left, selected.bottom - selected.top) * 0.04),
        )
        const cropLeft = Math.max(left, left + Math.floor((selected.left - margin) / sx))
        const cropTop = Math.max(top, top + Math.floor((selected.top - margin) / sy))
        const cropRight = Math.min(right, left + Math.ceil((selected.right + margin + 1) / sx))
        const cropBottom = Math.min(bottom, top + Math.ceil((selected.bottom + margin + 1) / sy))
        const crop = { left: cropLeft, top: cropTop, width: cropRight - cropLeft, height: cropBottom - cropTop }
        const inkRatio = selected.pixels / (crop.width * sx * crop.height * sy)
        if (inkRatio < 0.005) return null
        const { data: bytes, info: output } = await source
            .clone()
            .extract(crop)
            .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
            .png({ compressionLevel: 9 })
            .toBuffer({ resolveWithObject: true })
        const uri = `data:image/png;base64,${bytes.toString('base64')}`
        if (uri.length > PIECE_CUTOUT_MAX_CHARS) return null

        return {
            uri,
            image: { mimeType: 'image/png', bytes, width: output.width, height: output.height },
            box: [cropLeft / image.width, cropTop / image.height, crop.width / image.width, crop.height / image.height],
            inkRatio,
        }
    } catch {
        return null
    }
}
