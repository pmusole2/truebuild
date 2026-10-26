// Synthetic header-only image bytes shared by media and demo tests. Not real photos.
export function u32be(value: number): number[] {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

export function pngHeader(width: number, height: number): Uint8Array {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]
    return new Uint8Array([...signature, ...ihdr])
}

export function jpegHeader(width: number, height: number): Uint8Array {
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff]
    return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array<number>(10).fill(0)])
}
