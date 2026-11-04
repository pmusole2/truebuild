import type { TextStyle } from 'react-native'

// The platform's system sans keeps instructions, controls and status text in one legible family. No font download.

export type TypeRole =
    'largeTitle' | 'display' | 'title' | 'instruction' | 'heading' | 'body' | 'callout' | 'caption' | 'label' | 'button'

export type TypeStyle = {
    readonly fontFamily?: string
    readonly fontSize: number
    readonly lineHeight: number
    readonly fontWeight: '400' | '600'
    // Zero explicitly honours every system text size without inheriting a parent cap.
    readonly maxFontSizeMultiplier: number
}

// React Native defines zero as no maximum, including the largest accessibility category.
export const MAX_FONT_MULTIPLIER = 0

// Five sizes only (28, 22, 17, 15, 13) in two weights (400, 600). Labels are sentence case, never uppercase.
export const typeScale: Readonly<Record<TypeRole, TypeStyle>> = {
    largeTitle: { fontSize: 28, lineHeight: 36, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    display: { fontSize: 28, lineHeight: 36, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    title: { fontSize: 22, lineHeight: 28, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    // The one sentence a person acts on, set at heading size so it reads as a line of guidance, not a banner.
    instruction: { fontSize: 17, lineHeight: 24, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    heading: { fontSize: 17, lineHeight: 22, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    body: { fontSize: 17, lineHeight: 25, fontWeight: '400', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    callout: { fontSize: 15, lineHeight: 20, fontWeight: '400', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    caption: { fontSize: 13, lineHeight: 18, fontWeight: '400', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    label: { fontSize: 13, lineHeight: 18, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
    button: { fontSize: 17, lineHeight: 22, fontWeight: '600', maxFontSizeMultiplier: MAX_FONT_MULTIPLIER },
}

// maxFontSizeMultiplier is a Text prop, not a style key, so it is split out before the style reaches a Text node.
export function typeProps(role: TypeRole): { readonly style: TextStyle; readonly maxFontSizeMultiplier: number } {
    const { maxFontSizeMultiplier, ...style } = typeScale[role]
    return { style, maxFontSizeMultiplier }
}
