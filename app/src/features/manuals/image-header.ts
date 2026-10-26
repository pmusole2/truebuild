import { LIMITS } from '@truebuild/contracts'
import { ImportRejectedError } from './import-errors'

export type SourceFormat = 'image/jpeg' | 'image/png' | 'image/webp'

export type SourceImageInfo = {
    readonly mimeType: SourceFormat
    readonly width: number
    readonly height: number
}

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_START_OF_FRAME: ReadonlySet<number> = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

// Reads a byte without throwing, so signature checks can simply fail on short input.
function at(bytes: Uint8Array, index: number): number {
    return bytes[index] ?? -1
}

// Dimension reads require the bytes to exist; short or truncated headers are unreadable.
function need(bytes: Uint8Array, length: number): void {
    if (bytes.byteLength < length) {
        throw new ImportRejectedError('unreadable')
    }
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
    return [...text].every((char, index) => at(bytes, offset + index) === char.charCodeAt(0))
}

function u16be(bytes: Uint8Array, offset: number): number {
    return (at(bytes, offset) << 8) | at(bytes, offset + 1)
}

function u32be(bytes: Uint8Array, offset: number): number {
    return (
        at(bytes, offset) * 0x1000000 +
        (at(bytes, offset + 1) << 16) +
        (at(bytes, offset + 2) << 8) +
        at(bytes, offset + 3)
    )
}

function u16le(bytes: Uint8Array, offset: number): number {
    return at(bytes, offset) | (at(bytes, offset + 1) << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
    return at(bytes, offset) | (at(bytes, offset + 1) << 8) | (at(bytes, offset + 2) << 16)
}

type Dimensions = { readonly width: number; readonly height: number }

function readPng(bytes: Uint8Array): Dimensions | null {
    if (!PNG_SIGNATURE.every((byte, index) => at(bytes, index) === byte)) {
        return null
    }
    need(bytes, 24)
    if (!matchesAscii(bytes, 12, 'IHDR')) {
        throw new ImportRejectedError('unreadable')
    }
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

// Walks JPEG segments until the first frame header. Each step moves forward by at least two bytes.
function readJpeg(bytes: Uint8Array): Dimensions | null {
    if (at(bytes, 0) !== 0xff || at(bytes, 1) !== 0xd8) {
        return null
    }
    let offset = 2
    while (offset + 4 <= bytes.byteLength) {
        if (at(bytes, offset) !== 0xff) {
            throw new ImportRejectedError('unreadable')
        }
        const marker = at(bytes, offset + 1)
        if (marker === 0xff) {
            offset += 1
            continue
        }
        if (marker === 0xd9 || marker === 0xda) {
            throw new ImportRejectedError('unreadable')
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2
            continue
        }
        const length = u16be(bytes, offset + 2)
        if (length < 2) {
            throw new ImportRejectedError('unreadable')
        }
        if (JPEG_START_OF_FRAME.has(marker)) {
            need(bytes, offset + 9)
            return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) }
        }
        offset += 2 + length
    }
    throw new ImportRejectedError('unreadable')
}

function readWebp(bytes: Uint8Array): Dimensions | null {
    if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) {
        return null
    }
    need(bytes, 30)
    if (matchesAscii(bytes, 12, 'VP8 ')) {
        if (at(bytes, 23) !== 0x9d || at(bytes, 24) !== 0x01 || at(bytes, 25) !== 0x2a) {
            throw new ImportRejectedError('unreadable')
        }
        return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
    }
    if (matchesAscii(bytes, 12, 'VP8L')) {
        if (at(bytes, 20) !== 0x2f) {
            throw new ImportRejectedError('unreadable')
        }
        const word = at(bytes, 21) | (at(bytes, 22) << 8) | (at(bytes, 23) << 16) | (at(bytes, 24) << 24)
        return { width: (word & 0x3fff) + 1, height: ((word >>> 14) & 0x3fff) + 1 }
    }
    if (matchesAscii(bytes, 12, 'VP8X')) {
        return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
    }
    throw new ImportRejectedError('unreadable')
}

// Identifies the original file and its dimensions from headers only, before any decode.
// GIF, HEIC and other formats fail as unsupported and are never converted into JPEG.
export function inspectSourceImage(bytes: Uint8Array): SourceImageInfo {
    const detected: ReadonlyArray<readonly [SourceFormat, (input: Uint8Array) => Dimensions | null]> = [
        ['image/png', readPng],
        ['image/jpeg', readJpeg],
        ['image/webp', readWebp],
    ]
    for (const [mimeType, reader] of detected) {
        const dimensions = reader(bytes)
        if (dimensions === null) {
            continue
        }
        const { width, height } = dimensions
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
            throw new ImportRejectedError('unreadable')
        }
        if (width * height > LIMITS.imagePixels) {
            throw new ImportRejectedError('pixels')
        }
        return { mimeType, width, height }
    }
    throw new ImportRejectedError('unsupported')
}
