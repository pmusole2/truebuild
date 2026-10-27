import { Platform, type TextStyle } from 'react-native'

// Platform-installed families only; no remote or bundled font files. Display is a serif for titles, body is the system
// sans for reading, and labels use a mono stamp like a part tag.
export const fontFamily = {
    display: Platform.select({ ios: 'Charter', android: 'serif', default: 'Georgia, serif' }),
    mono: Platform.select({
        ios: 'Menlo',
        android: 'monospace',
        default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }),
} as const

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
        fontFamily: fontFamily.display,
        fontSize: 30,
        lineHeight: 38,
        fontWeight: '700',
        maxFontSizeMultiplier: 2,
    },
    title: {
        fontFamily: fontFamily.display,
        fontSize: 22,
        lineHeight: 30,
        fontWeight: '700',
        maxFontSizeMultiplier: 2,
    },
    heading: { fontSize: 18, lineHeight: 24, fontWeight: '600', maxFontSizeMultiplier: 2 },
    body: { fontSize: 16, lineHeight: 24, fontWeight: '400', maxFontSizeMultiplier: 2 },
    callout: { fontSize: 15, lineHeight: 22, fontWeight: '400', maxFontSizeMultiplier: 2 },
    caption: { fontSize: 13, lineHeight: 18, fontWeight: '400', maxFontSizeMultiplier: 2 },
    label: {
        fontFamily: fontFamily.mono,
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '700',
        letterSpacing: 0.8,
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
