import type { TextStyle } from 'react-native'

// The platform's system sans keeps instructions, controls and status text in one legible family. No font download.

export type TypeRole = 'display' | 'title' | 'heading' | 'body' | 'callout' | 'caption' | 'label' | 'button'

export type TypeStyle = {
    readonly fontFamily?: string
    readonly fontSize: number
    readonly lineHeight: number
    readonly fontWeight: '400' | '600' | '700'
    readonly letterSpacing?: number
    readonly textTransform?: 'uppercase'
    // Dynamic Type is honoured up to this multiplier. Controls grow in height rather than clipping their labels.
    readonly maxFontSizeMultiplier: number
}

export const typeScale: Readonly<Record<TypeRole, TypeStyle>> = {
    display: {
        fontSize: 28,
        lineHeight: 36,
        fontWeight: '700',
        maxFontSizeMultiplier: 2,
    },
    title: {
        fontSize: 22,
        lineHeight: 28,
        fontWeight: '700',
        maxFontSizeMultiplier: 2,
    },
    heading: { fontSize: 17, lineHeight: 22, fontWeight: '600', maxFontSizeMultiplier: 2 },
    body: { fontSize: 16, lineHeight: 24, fontWeight: '400', maxFontSizeMultiplier: 2 },
    callout: { fontSize: 15, lineHeight: 22, fontWeight: '400', maxFontSizeMultiplier: 2 },
    caption: { fontSize: 13, lineHeight: 18, fontWeight: '400', maxFontSizeMultiplier: 2 },
    label: {
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '600',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        maxFontSizeMultiplier: 2,
    },
    button: { fontSize: 16, lineHeight: 20, fontWeight: '600', maxFontSizeMultiplier: 2 },
}

// maxFontSizeMultiplier is a Text prop, not a style key, so it is split out before the style reaches a Text node.
export function typeProps(role: TypeRole): { readonly style: TextStyle; readonly maxFontSizeMultiplier: number } {
    const { maxFontSizeMultiplier, ...style } = typeScale[role]
    return { style, maxFontSizeMultiplier }
}
