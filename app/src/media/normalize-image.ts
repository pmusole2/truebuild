import { LIMITS, type ManualPage } from '@truebuild/contracts'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { MediaRejectedError } from './media-errors'
import { inspectSourceImage } from './image-header'
import { readImage } from './read-image'
import {
    normalizedSize,
    NORMALIZED_MAX_EDGE,
    NORMALIZED_TARGET_BYTES,
    RAW_IMAGE_MAX_BYTES,
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

/** Decode through Expo's EXIF-aware loader, then resize without cropping and encode JPEG, stripping source metadata.
 * Full-resolution phone photos may exceed upload ceilings: those ceilings apply only AFTER normalization.
 * HEIC supported by the native loader is converted locally; only the final JPEG goes to the backend.
 */
export async function normalizeImage(asset: SourceImageAsset): Promise<NormalizedImage> {
    if (asset.fileSize !== undefined && asset.fileSize > RAW_IMAGE_MAX_BYTES) {
        throw new MediaRejectedError('oversize')
    }
    try {
        normalizedSize(asset.width, asset.height)
    } catch {
        throw new MediaRejectedError('pixels')
    }
    // Raw input has its own read cap. SDK 58 downsamples during EXIF-aware decode, before allocating full-resolution pixels.
    await readImage(asset.uri, RAW_IMAGE_MAX_BYTES)
    const context = ImageManipulator.manipulate(asset.uri, {
        maxWidth: NORMALIZED_MAX_EDGE,
        maxHeight: NORMALIZED_MAX_EDGE,
    })
    let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined
    try {
        rendered = await context.renderAsync()
        for (const quality of [0.8, 0.6, 0.4]) {
            const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: quality })
            let bytes: Uint8Array<ArrayBuffer>
            try {
                bytes = await readImage(saved.uri, LIMITS.imageBytes)
            } catch (error: unknown) {
                if (error instanceof MediaRejectedError && error.failure === 'oversize') {
                    continue
                }
                throw error
            }
            const info = inspectSourceImage(bytes)
            if (bytes.length <= NORMALIZED_TARGET_BYTES) {
                return { bytes, mimeType: 'image/jpeg', width: info.width, height: info.height, uri: saved.uri }
            }
            const reduced = ImageManipulator.manipulate(saved.uri).resize({
                width: Math.max(1, Math.round(saved.width * 0.8)),
            })
            const next = await reduced.renderAsync()
            reduced.release?.()
            rendered.release?.()
            rendered = next
        }
        throw new MediaRejectedError('oversize')
    } finally {
        rendered?.release?.()
        context.release?.()
    }
}
