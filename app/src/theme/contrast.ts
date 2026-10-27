// WCAG 2.x relative luminance and contrast ratio for #RRGGBB colours. Used by the token tests to gate every text pair.

const HEX_COLOR = /^#([0-9A-Fa-f]{6})$/u

function channelLinear(channel: number): number {
    const srgb = channel / 255
    return srgb <= 0.039_28 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
    const match = HEX_COLOR.exec(hex)
    if (match === null) {
        throw new Error(`Expected a #RRGGBB colour, received ${hex}`)
    }
    const value = Number.parseInt(match[1] ?? '', 16)
    const red = channelLinear((value >> 16) & 0xff)
    const green = channelLinear((value >> 8) & 0xff)
    const blue = channelLinear(value & 0xff)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

export function contrastRatio(foreground: string, background: string): number {
    const first = relativeLuminance(foreground)
    const second = relativeLuminance(background)
    const lighter = Math.max(first, second)
    const darker = Math.min(first, second)
    return (lighter + 0.05) / (darker + 0.05)
}
