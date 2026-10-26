import { LIMITS, type ManualPage } from '@truebuild/contracts'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { readCappedResponse } from './capped-read'
import { MediaRejectedError } from './media-errors'
import { inspectSourceImage } from './image-header'

/** Fields a picker or camera result provides. `fileSize` is advisory and may be absent. */
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

const NORMALIZED_MIME_TYPE = 'image/jpeg' as const
const JPEG_QUALITY = 0.92

/**
 * Original JPEG/PNG/WebP bytes are read with a cap, header-checked, then re-rendered to a normalized JPEG (which also
 * applies EXIF orientation). Unsupported originals are rejected, never converted. Picker metadata is advisory: missing
 * or zero values mean unknown, so the byte-level checks still run.
 */
export async function normalizeImage(asset: SourceImageAsset): Promise<NormalizedImage> {
    if (asset.fileSize !== undefined && asset.fileSize > LIMITS.imageBytes) {
        throw new MediaRejectedError('oversize')
    }
    if (asset.width > 0 && asset.height > 0 && asset.width * asset.height > LIMITS.imagePixels) {
        throw new MediaRejectedError('pixels')
    }
    const source = await readCappedResponse(await fetch(asset.uri), LIMITS.imageBytes)
    inspectSourceImage(source)

    const rendered = await ImageManipulator.manipulate(asset.uri).renderAsync()
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY })
    const bytes = await readCappedResponse(await fetch(saved.uri), LIMITS.imageBytes)
    return { bytes, mimeType: NORMALIZED_MIME_TYPE, width: saved.width, height: saved.height, uri: saved.uri }
}
