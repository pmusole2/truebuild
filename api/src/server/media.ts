import { LIMITS, type ManualPage } from '@truebuild/contracts'
import sharp from 'sharp'

export interface SourceImage {
    page: ManualPage
    bytes: Uint8Array
}

export interface ObservationImage {
    mimeType: ManualPage['mimeType']
    bytes: Uint8Array
    width: number
    height: number
}

export interface ValidatedImage {
    mimeType: 'image/jpeg'
    bytes: Uint8Array
    width: number
    height: number
}

export class MediaValidationError extends Error {
    constructor(readonly code: 'invalid_input' | 'cancelled') {
        super(code)
        this.name = 'MediaValidationError'
    }
}

function checkpoint(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new MediaValidationError('cancelled')
    }
}

function validDimensions(width: number, height: number): boolean {
    return (
        Number.isSafeInteger(width) &&
        width > 0 &&
        Number.isSafeInteger(height) &&
        height > 0 &&
        width * height <= LIMITS.imagePixels
    )
}

function magicType(bytes: Uint8Array): ObservationImage['mimeType'] | null {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg'
    }

    if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) {
        return 'image/png'
    }

    if (
        [0x52, 0x49, 0x46, 0x46].every((value, index) => bytes[index] === value) &&
        [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value)
    ) {
        return 'image/webp'
    }

    return null
}

function rejectAnimation(bytes: Uint8Array, mimeType: ObservationImage['mimeType']): void {
    if (mimeType === 'image/jpeg') {
        return
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = mimeType === 'image/png' ? 8 : 12

    while (offset + 8 <= bytes.byteLength) {
        const png = mimeType === 'image/png'
        const size = view.getUint32(png ? offset : offset + 4, !png)
        const typeOffset = png ? offset + 4 : offset
        const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4))

        // libvips can expose only the first APNG frame; container markers are independently rejected.
        if ((png && ['acTL', 'fcTL', 'fdAT'].includes(type)) || (!png && ['ANIM', 'ANMF'].includes(type))) {
            throw new MediaValidationError('invalid_input')
        }

        offset += png ? size + 12 : size + 8 + (size % 2)
    }
}

/** Sequential native work is bounded but not physically interrupted by AbortSignal. Checkpoints prevent late publication. */
export async function validateAndNormalizeImages(
    images: readonly ObservationImage[],
    signal?: AbortSignal,
    maxImages: number = LIMITS.requestImages,
): Promise<ValidatedImage[]> {
    checkpoint(signal)

    if (images.length === 0 || images.length > maxImages || maxImages > LIMITS.requestImages) {
        throw new MediaValidationError('invalid_input')
    }

    let inboundBytes = 0

    for (const image of images) {
        if (
            !(image.bytes instanceof Uint8Array) ||
            image.bytes.byteLength === 0 ||
            image.bytes.byteLength > LIMITS.imageBytes ||
            !validDimensions(image.width, image.height)
        ) {
            throw new MediaValidationError('invalid_input')
        }

        inboundBytes += image.bytes.byteLength
    }

    if (inboundBytes > LIMITS.requestBytes) {
        throw new MediaValidationError('invalid_input')
    }

    // Own the bytes before the first codec await; callers cannot mutate images while validation is in progress.
    const owned = images.map((image): ObservationImage => ({ ...image, bytes: new Uint8Array(image.bytes) }))
    const results: ValidatedImage[] = []
    let outputBytes = 0

    try {
        for (const image of owned) {
            checkpoint(signal)
            const mimeType = magicType(image.bytes)

            if (mimeType !== image.mimeType) {
                throw new MediaValidationError('invalid_input')
            }

            rejectAnimation(image.bytes, image.mimeType)

            const pipeline = sharp(image.bytes, { limitInputPixels: LIMITS.imagePixels, failOn: 'warning' })
            const metadata = await pipeline.metadata()
            checkpoint(signal)

            if (
                `image/${metadata.format}` !== image.mimeType ||
                (metadata.pages ?? 1) !== 1 ||
                !validDimensions(metadata.width, metadata.height) ||
                metadata.autoOrient.width !== image.width ||
                metadata.autoOrient.height !== image.height
            ) {
                throw new MediaValidationError('invalid_input')
            }

            const { data, info } = await pipeline
                .autoOrient()
                .jpeg({ quality: 85 })
                .toBuffer({ resolveWithObject: true })
            checkpoint(signal)

            if (info.width !== image.width || info.height !== image.height || data.byteLength > LIMITS.imageBytes) {
                throw new MediaValidationError('invalid_input')
            }

            outputBytes += data.byteLength

            if (outputBytes > LIMITS.requestBytes) {
                throw new MediaValidationError('invalid_input')
            }

            results.push({
                mimeType: 'image/jpeg',
                bytes: new Uint8Array(data),
                width: info.width,
                height: info.height,
            })
        }

        checkpoint(signal)

        return results
    } catch (error: unknown) {
        checkpoint(signal)

        if (error instanceof MediaValidationError) {
            throw error
        }

        throw new MediaValidationError('invalid_input')
    }
}
