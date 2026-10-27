import { Platform, type ViewStyle } from 'react-native'

// Flat by default: rules and borders carry structure. Shadows appear only for surfaces that float over content.
export type ElevationLevel = 0 | 1 | 2

const NATIVE: Readonly<Record<ElevationLevel, ViewStyle>> = {
    0: {},
    1: {
        shadowColor: '#000000',
        shadowOpacity: 0.08,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
        elevation: 2,
    },
    2: {
        shadowColor: '#000000',
        shadowOpacity: 0.18,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: -4 },
        elevation: 8,
    },
}

// react-native-web warns about the legacy shadow* props, so the web build uses boxShadow instead.
const WEB: Readonly<Record<ElevationLevel, string>> = {
    0: 'none',
    1: '0 2px 6px rgba(0, 0, 0, 0.08)',
    2: '0 -4px 16px rgba(0, 0, 0, 0.18)',
}

export function elevationStyle(level: ElevationLevel): ViewStyle {
    return Platform.OS === 'web' ? { boxShadow: WEB[level] } : NATIVE[level]
}
