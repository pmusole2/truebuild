import { LIMITS, type ManualPage } from '@truebuild/contracts'
import * as Crypto from 'expo-crypto'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { AssetValidationError, validateImportAsset } from '../../domain/manual-session'
import type { StoredPageAsset } from '../../storage/manual-store.types'
import { readCappedResponse } from './capped-read'
import { ImportRejectedError, type ImportFailure } from './import-errors'
import { inspectSourceImage } from './image-header'

/** The fields picker and camera results share. `fileSize` is advisory and may be absent. */
export type SourceImageAsset = {
    readonly uri: string
    readonly width: number
    readonly height: number
    readonly fileSize?: number
}

export type NormalizedImage = {
    readonly bytes: Uint8Array<ArrayBuffer>
    readonly width: number
    readonly height: number
    readonly uri: string
}

export type ImportedPage = {
    readonly page: ManualPage
    readonly asset: StoredPageAsset
}

const NORMALIZED_MIME_TYPE = 'image/jpeg' as const
const JPEG_QUALITY = 0.92

const FAILURE_BY_VALIDATION_CODE: Record<AssetValidationError['code'], ImportFailure> = {
    unsupported_mime_type: 'unsupported',
    oversized_file: 'oversize',
    oversized_pixels: 'pixels',
    too_many_pages: 'pageCount',
    invalid_input: 'unreadable',
}

// Picker metadata is advisory. Missing or zero values mean unknown, so the byte-level checks below still run.
function assertPickerMetadata(asset: SourceImageAsset): void {
    if (asset.fileSize !== undefined && asset.fileSize > LIMITS.imageBytes) {
        throw new ImportRejectedError('oversize')
    }
    if (asset.width > 0 && asset.height > 0 && asset.width * asset.height > LIMITS.imagePixels) {
        throw new ImportRejectedError('pixels')
    }
}

function asImportRejection(error: unknown): ImportRejectedError {
    if (error instanceof ImportRejectedError) {
        return error
    }
    if (error instanceof AssetValidationError) {
        return new ImportRejectedError(FAILURE_BY_VALIDATION_CODE[error.code])
    }
    return new ImportRejectedError('generic')
}

function hexDigest(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Original JPEG/PNG/WebP bytes are read with a cap, header-checked, then re-rendered to a normalized JPEG (which also
 * applies EXIF orientation). Unsupported originals are rejected, never converted. Used for manual pages and for
 * observations alike; callers apply their own count and identity rules.
 */
export async function normalizeImage(asset: SourceImageAsset): Promise<NormalizedImage> {
    assertPickerMetadata(asset)
    const source = await readCappedResponse(await fetch(asset.uri), LIMITS.imageBytes)
    inspectSourceImage(source)

    const rendered = await ImageManipulator.manipulate(asset.uri).renderAsync()
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY })
    const bytes = await readCappedResponse(await fetch(saved.uri), LIMITS.imageBytes)
    return { bytes, width: saved.width, height: saved.height, uri: saved.uri }
}

// Order matters: count and metadata gates, then normalization, then the domain page rules (pixel, size, count).
async function normalizePage(asset: SourceImageAsset, existingPageCount: number): Promise<ImportedPage> {
    const normalized = await normalizeImage(asset)
    try {
        validateImportAsset(
            {
                mimeType: NORMALIZED_MIME_TYPE,
                byteLength: normalized.bytes.byteLength,
                width: normalized.width,
                height: normalized.height,
            },
            existingPageCount,
        )
    } catch (error: unknown) {
        throw asImportRejection(error)
    }

    const contentHash = hexDigest(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, normalized.bytes))
    const id = Crypto.randomUUID()
    return {
        page: {
            pageId: `page-${id}`,
            assetId: `asset-${id}`,
            width: normalized.width,
            height: normalized.height,
            mimeType: NORMALIZED_MIME_TYPE,
            contentHash,
        },
        asset: { assetId: `asset-${id}`, mimeType: NORMALIZED_MIME_TYPE, bytes: normalized.bytes },
    }
}

// Returns null when the user cancels. Any rejection throws before anything is saved, so no partial import is written.
export async function pickAndNormalizePages(): Promise<readonly ImportedPage[] | null> {
    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: LIMITS.manualPages,
    })
    if (result.canceled || result.assets.length === 0) {
        return null
    }
    if (result.assets.length > LIMITS.manualPages) {
        throw new ImportRejectedError('pageCount')
    }

    const imported: ImportedPage[] = []
    // Sequential processing keeps decoded bytes bounded to one page at a time.
    for (const asset of result.assets) {
        imported.push(await normalizePage(asset, imported.length))
    }
    return imported
}
