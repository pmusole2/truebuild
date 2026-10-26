import { Platform } from 'react-native'

// Industrial assembly-workbench palette: warm paper, charcoal ink and one restrained signal colour for actions.
export const palette = {
    paper: '#F2EBDD',
    paperRaised: '#FBF7EF',
    paperDeep: '#E5DBC6',
    charcoal: '#262A2E',
    charcoalSoft: '#3D4247',
    graphite: '#5E5B54',
    rule: '#C9BDA5',
    signal: '#E0561F',
    signalInk: '#A93C12',
    passInk: '#2F6B3F',
    cautionInk: '#7A5A0E',
} as const

// Platform-installed families only; no remote or bundled font files.
export const fonts = {
    display: Platform.select({ ios: 'Charter', android: 'serif', default: 'Georgia, serif' }),
    mono: Platform.select({
        ios: 'Menlo',
        android: 'monospace',
        default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }),
} as const

export const space = {
    xs: 6,
    sm: 10,
    md: 16,
    lg: 24,
} as const

export const radius = 4

// Minimum touch target for controls on phones and desktop pointers.
export const touchTarget = 44

export const contentMaxWidth = 1120
