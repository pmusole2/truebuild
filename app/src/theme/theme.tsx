import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'
import { colorsFor, lightColors, type ColorScheme, type Colors } from './tokens'

export type Theme = {
    readonly scheme: ColorScheme
    readonly colors: Colors
}

// Light is the default when no provider is mounted, so every primitive renders on its own (previews, tests).
const ThemeContext = createContext<Theme>({ scheme: 'light', colors: lightColors })

/** Follows the system appearance unless a scheme is passed explicitly. */
export function ThemeProvider({
    scheme,
    children,
}: {
    readonly scheme?: ColorScheme
    readonly children: ReactNode
}): ReactElement {
    const system = useColorScheme()
    const resolved: ColorScheme = scheme ?? (system === 'dark' ? 'dark' : 'light')
    const value = useMemo((): Theme => ({ scheme: resolved, colors: colorsFor(resolved) }), [resolved])
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
    return useContext(ThemeContext)
}
