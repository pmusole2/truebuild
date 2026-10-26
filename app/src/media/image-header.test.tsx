import { MediaRejectedError } from './media-errors'
import { inspectSourceImage } from './image-header'

function u32be(value: number): number[] {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function pngHeader(width: number, height: number): Uint8Array {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]
    return new Uint8Array([...signature, ...ihdr])
}

function jpegHeader(width: number, height: number): Uint8Array {
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff]
    return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array<number>(10).fill(0)])
}

function riff(chunk: string, payload: number[]): Uint8Array {
    const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))
    const size = [payload.length + 4, 0, 0, 0]
    return new Uint8Array([...ascii('RIFF'), ...size, ...ascii('WEBP'), ...ascii(chunk), 0, 0, 0, 0, ...payload])
}

function webpVp8x(width: number, height: number): Uint8Array {
    const w = width - 1
    const h = height - 1
    const payload = [
        0,
        0,
        0,
        0,
        w & 0xff,
        (w >> 8) & 0xff,
        (w >> 16) & 0xff,
        h & 0xff,
        (h >> 8) & 0xff,
        (h >> 16) & 0xff,
    ]
    return riff('VP8X', payload)
}

function webpVp8l(width: number, height: number): Uint8Array {
    const word = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
    const payload = [0x2f, word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >>> 24) & 0xff, 0, 0, 0, 0, 0]
    return riff('VP8L', payload)
}

function webpVp8(width: number, height: number): Uint8Array {
    const payload = [0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8]
    return riff('VP8 ', payload)
}

function isRejectedWith(bytes: Uint8Array, failure: string): boolean {
    try {
        inspectSourceImage(bytes)
        return false
    } catch (error: unknown) {
        return error instanceof MediaRejectedError && error.failure === failure
    }
}

describe('inspectSourceImage', () => {
    it.each([
        ['PNG', pngHeader(1200, 900), 'image/png', 1200, 900],
        ['JPEG', jpegHeader(800, 600), 'image/jpeg', 800, 600],
        ['WebP lossy', webpVp8(640, 480), 'image/webp', 640, 480],
        ['WebP lossless', webpVp8l(1000, 700), 'image/webp', 1000, 700],
        ['WebP extended', webpVp8x(2048, 1536), 'image/webp', 2048, 1536],
    ])('reads %s dimensions from headers without decoding pixels', (_label, bytes, mimeType, width, height) => {
        expect(inspectSourceImage(bytes)).toEqual({ mimeType, width, height })
    })

    it('rejects GIF and HEIC originals as unsupported instead of converting them', () => {
        const gif = new Uint8Array([...new TextEncoder().encode('GIF89a'), ...new Array<number>(30).fill(0)])
        const heic = new Uint8Array([
            0,
            0,
            0,
            0x18,
            0x66,
            0x74,
            0x79,
            0x70,
            0x68,
            0x65,
            0x69,
            0x63,
            ...new Array<number>(20).fill(0),
        ])
        expect(isRejectedWith(gif, 'unsupported')).toBe(true)
        expect(isRejectedWith(heic, 'unsupported')).toBe(true)
    })

    it('rejects a declared pixel count above the limit before any decode', () => {
        expect(isRejectedWith(pngHeader(60000, 60000), 'pixels')).toBe(true)
    })

    it('rejects zero or truncated dimensions as unreadable', () => {
        expect(isRejectedWith(pngHeader(0, 900), 'unreadable')).toBe(true)
        expect(isRejectedWith(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'unreadable')).toBe(
            true,
        )
    })
})
