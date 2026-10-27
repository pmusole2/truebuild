// Workshop-tool identity: graphite ink on warm bench neutrals, with one safety-amber accent. Status colours are always
// paired with an icon and a text label, so no verdict is conveyed by colour alone.

export type ColorScheme = 'light' | 'dark'

export type ColorToken =
    | 'canvas'
    | 'surface'
    | 'surfaceRaised'
    | 'surfaceSunken'
    | 'ink'
    | 'inkMuted'
    | 'inkInverse'
    | 'border'
    | 'borderStrong'
    | 'focus'
    | 'fillStrong'
    | 'fillStrongInk'
    | 'accent'
    | 'accentInk'
    | 'accentFillInk'
    | 'pass'
    | 'passSurface'
    | 'refuse'
    | 'refuseSurface'
    | 'caution'
    | 'cautionSurface'

export type Colors = Readonly<Record<ColorToken, string>>

export const lightColors: Colors = {
    canvas: '#EEE8DB',
    surface: '#FAF6EC',
    surfaceRaised: '#FFFDF7',
    surfaceSunken: '#E2D9C6',
    ink: '#1E2225',
    inkMuted: '#4F4A40',
    inkInverse: '#F7F2E6',
    border: '#CBBFA6',
    borderStrong: '#7A7262',
    focus: '#9A4B07',
    fillStrong: '#262B2F',
    fillStrongInk: '#F7F2E6',
    accent: '#EB8E1F',
    accentInk: '#8A4A06',
    accentFillInk: '#1E2225',
    pass: '#2D6A3E',
    passSurface: '#DFEBD8',
    refuse: '#A3331A',
    refuseSurface: '#F5DED6',
    caution: '#6F5110',
    cautionSurface: '#F1E4BF',
}

export const darkColors: Colors = {
    canvas: '#15191C',
    surface: '#1F2529',
    surfaceRaised: '#283036',
    surfaceSunken: '#0F1316',
    ink: '#F1ECDF',
    inkMuted: '#B7B0A1',
    inkInverse: '#15191C',
    border: '#3E474E',
    borderStrong: '#8E877A',
    focus: '#F4B25C',
    fillStrong: '#F1ECDF',
    fillStrongInk: '#15191C',
    accent: '#F0A03A',
    accentInk: '#F5B862',
    accentFillInk: '#15191C',
    pass: '#97D3A4',
    passSurface: '#1E3324',
    refuse: '#F4A08A',
    refuseSurface: '#3B2119',
    caution: '#E9C46F',
    cautionSurface: '#3A3118',
}

export function colorsFor(scheme: ColorScheme): Colors {
    return scheme === 'dark' ? darkColors : lightColors
}

export const space = {
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 24,
    xl: 32,
} as const

export const radius = {
    sm: 4,
    md: 8,
    lg: 12,
    pill: 999,
} as const

// Every control, including icon-only buttons and segmented options, keeps at least this interactive size.
export const touchTarget = 44

export const iconSize = {
    sm: 20,
    md: 24,
} as const

// Durations for the shared motion helper. Under reduced motion every transition resolves immediately.
export const motion = {
    instant: 0,
    quick: 150,
    standard: 240,
    sheet: 320,
} as const
