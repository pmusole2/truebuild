import sharp from 'sharp'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { MediaValidationError, validateAndNormalizeImages, type ObservationImage } from './media'

async function png(width = 8, height = 4): Promise<ObservationImage> {
    const bytes = await sharp({ create: { width, height, channels: 3, background: '#dfdfdf' } })
        .png()
        .toBuffer()

    return { bytes, mimeType: 'image/png', width, height }
}

function pngChunk(type: string, data: Uint8Array): Buffer {
    const name = Buffer.from(type)
    const payload = Buffer.concat([name, data])
    let crc = 0xffffffff

    for (const byte of payload) {
        crc ^= byte

        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
        }
    }

    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.byteLength)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)

    return Buffer.concat([length, payload, checksum])
}

function animatedPng(): Buffer {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(4, 0)
    header.writeUInt32BE(4, 4)
    header[8] = 8
    header[9] = 2
    const animation = Buffer.alloc(8)
    animation.writeUInt32BE(2)
    const frame = (sequence: number): Buffer => {
        const data = Buffer.alloc(26)
        data.writeUInt32BE(sequence)
        data.writeUInt32BE(4, 4)
        data.writeUInt32BE(4, 8)
        data.writeUInt16BE(1, 20)
        data.writeUInt16BE(10, 22)

        return pngChunk('fcTL', data)
    }
    const second = Buffer.alloc(4)
    second.writeUInt32BE(2)

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('acTL', animation),
        frame(0),
        pngChunk('IDAT', deflateSync(Buffer.alloc(4 * 13))),
        frame(1),
        pngChunk('fdAT', Buffer.concat([second, deflateSync(Buffer.alloc(4 * 13))])),
        pngChunk('IEND', Buffer.alloc(0)),
    ])
}

async function binaryNoiseImage(size: number): Promise<ObservationImage> {
    const pixels = Buffer.alloc(size * size)
    let state = 12345

    for (let index = 0; index < pixels.length; index += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        pixels[index] = (state >>> 31) * 255
    }

    const bytes = await sharp(pixels, { raw: { width: size, height: size, channels: 1 } })
        .png()
        .toBuffer()

    return { bytes, mimeType: 'image/png', width: size, height: size }
}

describe('actual image normalization', (): void => {
    it('decodes a generated PNG and strips metadata when encoding JPEG', async (): Promise<void> => {
        const input = await png()
        const results = await validateAndNormalizeImages([input])
        const image = results[0]

        expect(image).toBeDefined()

        if (!image) {
            throw new Error('Missing normalized image')
        }

        const metadata = await sharp(image.bytes).metadata()

        expect(image).toMatchObject({ mimeType: 'image/jpeg', width: 8, height: 4 })
        expect(metadata.format).toBe('jpeg')
        expect(metadata.exif).toBeUndefined()
        expect(metadata.icc).toBeUndefined()
        expect(metadata.orientation).toBeUndefined()
    })

    it('auto-orients EXIF bytes only when declared metadata matches normalized geometry', async (): Promise<void> => {
        const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#454545' } })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer()
        const [normalized] = await validateAndNormalizeImages([{ bytes, mimeType: 'image/jpeg', width: 4, height: 8 }])

        expect(normalized).toMatchObject({ width: 4, height: 8 })
        expect(await sharp(normalized?.bytes).metadata()).toMatchObject({ width: 4, height: 8 })
        await expect(
            validateAndNormalizeImages([{ bytes, mimeType: 'image/jpeg', width: 8, height: 4 }]),
        ).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('rejects actual MIME lies, corrupt data, GIF magic and dimension lies', async (): Promise<void> => {
        const input = await png()

        for (const image of [
            { ...input, mimeType: 'image/jpeg' as const },
            { ...input, width: 9 },
            { ...input, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
            { ...input, bytes: new TextEncoder().encode('GIF89a') },
        ]) {
            await expect(validateAndNormalizeImages([image])).rejects.toBeInstanceOf(MediaValidationError)
        }
    })

    it('rejects image count, byte, pixel and finite integer boundaries before decoding', async (): Promise<void> => {
        const input = await png()

        for (const images of [
            [],
            Array.from({ length: 22 }, () => input),
            [{ ...input, bytes: new Uint8Array(4_194_305) }],
            [0, 1, 2].map(() => ({ ...input, bytes: new Uint8Array(3_000_000) })),
            [{ ...input, width: 6_001, height: 4_000 }],
            [{ ...input, width: Number.NaN }],
            [{ ...input, height: 0 }],
            [{ ...input, width: 1.5 }],
        ]) {
            await expect(validateAndNormalizeImages(images)).rejects.toMatchObject({ code: 'invalid_input' })
        }
    })

    it('rejects actual decoded pixel bombs despite a small declared geometry', async (): Promise<void> => {
        const bytes = await sharp({
            create: { width: 6_001, height: 4_000, channels: 3, background: '#000000' },
        })
            .png()
            .toBuffer()

        await expect(
            validateAndNormalizeImages([{ bytes, mimeType: 'image/png', width: 8, height: 4 }]),
        ).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('caps actual normalized JPEG bytes per image and across a three-image request', async (): Promise<void> => {
        const perImage = await binaryNoiseImage(3000)
        const perRequest = await binaryNoiseImage(2100)
        const perImageEncoded = await sharp(perImage.bytes).jpeg({ quality: 85 }).toBuffer()
        const [oneAccepted] = await validateAndNormalizeImages([perRequest])

        expect(perImageEncoded.byteLength).toBeGreaterThan(4_194_304)
        expect((oneAccepted?.bytes.byteLength ?? 0) * 3).toBeGreaterThan(8_388_608)

        for (const images of [[perImage], [perRequest, perRequest, perRequest]]) {
            expect(images.reduce((total, image): number => total + image.bytes.byteLength, 0)).toBeLessThan(8_388_608)
            const outcome = await validateAndNormalizeImages(images).then(
                (): string => 'unexpected_success',
                (error: unknown): string => (error instanceof MediaValidationError ? error.code : 'unexpected_error'),
            )

            expect(outcome).toBe('invalid_input')
        }
    })

    it('rejects animation rather than silently accepting a single frame', async (): Promise<void> => {
        const bytes = new Uint8Array(4 * 8 * 3).fill(255)
        bytes.fill(0, 0, 4 * 4 * 3)
        const animated = await sharp(bytes, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } })
            .webp({ loop: 0, delay: [100, 100] })
            .toBuffer()

        expect((await sharp(animated).metadata()).pages).toBe(2)
        await expect(
            validateAndNormalizeImages([{ bytes: animated, mimeType: 'image/webp', width: 4, height: 4 }]),
        ).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('rejects APNG even when the decoder exposes only its first frame', async (): Promise<void> => {
        const bytes = animatedPng()
        expect((await sharp(bytes).metadata()).format).toBe('png')
        const outcome = await validateAndNormalizeImages([{ bytes, mimeType: 'image/png', width: 4, height: 4 }]).then(
            (): string => 'unexpected_success',
            (error: unknown): string => (error instanceof MediaValidationError ? error.code : 'unexpected_error'),
        )

        expect(outcome).toBe('invalid_input')
    })

    it('rejects pre-cancelled and in-progress results without publishing normalized images', async (): Promise<void> => {
        const input = await png()
        const already = new AbortController()
        already.abort('private reason')

        await expect(validateAndNormalizeImages([input], already.signal)).rejects.toMatchObject({ code: 'cancelled' })
        const inflight = new AbortController()
        const work = validateAndNormalizeImages([input], inflight.signal)
        inflight.abort('private reason')

        await expect(work).rejects.toMatchObject({ code: 'cancelled' })
    })
})
