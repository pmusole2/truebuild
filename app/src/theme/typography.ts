import type { TextStyle } from 'react-native'

// The platform's system sans keeps instructions, controls and status text in one legible family. No font download.

export type TypeRole =
    'largeTitle' | 'display' | 'title' | 'instruction' | 'heading' | 'body' | 'callout' | 'caption' | 'label' | 'button'

export type TypeStyle = {
    readonly fontFamily?: string
    readonly fontSize: number
    readonly lineHeight: number
    readonly fontWeight: '400' | '600' | '700'
    readonly letterSpacing?: number
    readonly textTransform?: 'uppercase'
    // Dynamic Type is honoured up to this multiplier, which reaches the accessibility sizes. Containers grow, never clip.
    readonly maxFontSizeMultiplier: number
}

// Largest Dynamic Type stays usable: no role is capped at 2x. 3x covers the accessibility sizes.
export const MAX_FONT_MULTIPLIER = 3

export const typeScale: Readonly<Record<TypeRole, TypeStyle>> = {
    largeTitle: { fontSize: 34, lineHeight: 43, fontWeight: '700', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    display: { fontSize: 28, lineHeight: 36, fontWeight: '700', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    title: { fontSize: 22, lineHeight: 28, fontWeight: '700', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    // The one sentence a person acts on: the largest text on a working screen.
    instruction: { fontSize: 22, lineHeight: 30, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    heading: { fontSize: 17, lineHeight: 22, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    body: { fontSize: 17, lineHeight: 25, fontWeight: '400', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    callout: { fontSize: 17, lineHeight: 24, fontWeight: '400', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    caption: { fontSize: 13, lineHeight: 18, fontWeight: '400', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    label: {
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '600',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        maxFontSizeMultiplier: MAX_FONT_MULTIPLIER,
    },
    button: { fontSize: 17, lineHeight: 22, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
}

// maxFontSizeMultiplier is a Text prop, not a style key, so it is split out before the style reaches a Text node.
export function typeProps(role: TypeRole): { readonly style: TextStyle; readonly maxFontSizeMultiplier: number } {
    const { maxFontSizeMultiplier, ...style } = typeScale[role]
    return { style, maxFontSizeMultiplier }
}
