import { LIMITS, type ManualPage } from '@truebuild/contracts'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { MediaRejectedError } from './media-errors'
import { inspectSourceImage } from './image-header'
import { ownTemporaryImage, releaseTemporaryImage } from './owned-temporary-images'
import { readImage, probeImage } from './read-image'
import {
    normalizedSize,
    NORMALIZED_TARGET_BYTES,
    NORMALIZED_MAX_PIXELS,
    NORMALIZED_MAX_DIMENSION,
    RAW_IMAGE_MAX_BYTES,
    shortEdgeFloor,
    shrunkSize,
    type PixelSize,
} from './normalization-policy'

export type SourceImageAsset = {
    readonly uri: string
    readonly width: number
    readonly height: number
    readonly fileSize?: number
}
export type NormalizedImage = {
    readonly bytes: Uint8Array<ArrayBuffer>
    readonly mimeType: ManualPage['mimeType']
    readonly width: number
    readonly height: number
    readonly uri: string
}

/** Decode through Expo's EXIF-aware loader at the policy's target size, then encode JPEG, stripping source metadata.
 * Quality retries lower the encoding first and shrink only while the readability floor allows it.
 * Full-resolution phone photos may exceed upload ceilings: those ceilings apply only AFTER normalization.
 * HEIC supported by the native loader is converted locally; only the final JPEG goes to the backend.
 */
export async function normalizeImage(asset: SourceImageAsset): Promise<NormalizedImage> {
    if (asset.fileSize !== undefined && asset.fileSize > RAW_IMAGE_MAX_BYTES) {
        throw new MediaRejectedError('oversize')
    }
    let target: PixelSize
    try {
        target = normalizedSize(asset.width, asset.height)
    } catch {
        throw new MediaRejectedError('pixels')
    }
    const floor = shortEdgeFloor(asset.width, asset.height)
    // Raw input has its own read cap. SDK 58 downsamples during EXIF-aware decode, before allocating full-resolution pixels.
    await probeImage(asset.uri, RAW_IMAGE_MAX_BYTES)
    // A symmetric decode box preserves EXIF swaps and the existing normal-page decode path.
    const edge = Math.max(target.width, target.height)
    const context = ImageManipulator.manipulate(asset.uri, { maxWidth: edge, maxHeight: edge })
    const outputs = new Set<string>()
    let finalUri: string | undefined
    let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined
    try {
        rendered = await context.renderAsync()
        const qualities = [0.8, 0.6, 0.4]
        for (const [index, quality] of qualities.entries()) {
            const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: quality })
            ownTemporaryImage(saved.uri)
            outputs.add(saved.uri)
            let bytes: Uint8Array<ArrayBuffer>
            try {
                bytes = await readImage(saved.uri, LIMITS.imageBytes)
            } catch (error: unknown) {
                if (error instanceof MediaRejectedError && error.failure === 'oversize') {
                    await releaseTemporaryImage(saved.uri)
                    continue
                }
                throw error
            }
            const info = inspectSourceImage(bytes)
            if (
                info.width * info.height > NORMALIZED_MAX_PIXELS ||
                Math.max(info.width, info.height) > NORMALIZED_MAX_DIMENSION
            ) {
                throw new MediaRejectedError('pixels')
            }
            if (bytes.length <= NORMALIZED_TARGET_BYTES) {
                finalUri = saved.uri
                if (asset.uri !== finalUri) {
                    await releaseTemporaryImage(asset.uri)
                }
                return { bytes, mimeType: 'image/jpeg', width: info.width, height: info.height, uri: saved.uri }
            }
            if (index === qualities.length - 1) {
                break
            }
            const size = { width: info.width, height: info.height }
            const next = shrunkSize(size, floor)
            if (next.width === size.width && next.height === size.height) {
                // The readability floor binds: this retry only lowers quality, and the superseded file goes now.
                await releaseTemporaryImage(saved.uri)
                continue
            }
            const reduced = ImageManipulator.manipulate(saved.uri).resize(
                floor === 0 ? { width: next.width } : { width: next.width, height: next.height },
            )
            try {
                const resized = await reduced.renderAsync()
                rendered.release?.()
                rendered = resized
            } finally {
                reduced.release?.()
                await releaseTemporaryImage(saved.uri)
            }
        }
        throw new MediaRejectedError('oversize')
    } finally {
        for (const uri of outputs) {
            if (uri !== finalUri) {
                await releaseTemporaryImage(uri)
            }
        }
        rendered?.release?.()
        context.release?.()
    }
}
