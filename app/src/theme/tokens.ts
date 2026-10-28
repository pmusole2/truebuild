// Neutral surfaces keep attention on the manual and assembly photo. Blue marks the primary action; status colours
// always carry an icon and text, so a verdict never depends on colour alone.

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
    canvas: '#F6F7F8',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#ECEEF0',
    ink: '#171A1D',
    inkMuted: '#4A5560',
    inkInverse: '#FFFFFF',
    border: '#C9CED4',
    borderStrong: '#6B7480',
    focus: '#0057C2',
    fillStrong: '#171A1D',
    fillStrongInk: '#FFFFFF',
    accent: '#0057C2',
    accentInk: '#004A9E',
    accentFillInk: '#FFFFFF',
    pass: '#1B6B3A',
    passSurface: '#E6F2E9',
    refuse: '#B42318',
    refuseSurface: '#FDECEA',
    caution: '#7A4A00',
    cautionSurface: '#FFF1D6',
}

export const darkColors: Colors = {
    canvas: '#0F1113',
    surface: '#171A1D',
    surfaceRaised: '#1F2328',
    surfaceSunken: '#0B0D0F',
    ink: '#F2F4F6',
    inkMuted: '#B8C0C8',
    inkInverse: '#171A1D',
    border: '#343B42',
    borderStrong: '#8A95A1',
    focus: '#7AB8FF',
    fillStrong: '#F2F4F6',
    fillStrongInk: '#171A1D',
    accent: '#8AB6FF',
    accentInk: '#A9C9FF',
    accentFillInk: '#071426',
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
    sheet: 16,
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
    pulse: 900,
} as const
