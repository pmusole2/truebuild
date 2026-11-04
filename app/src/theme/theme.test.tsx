import { describe, expect, it } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import { Platform, Text, useColorScheme } from 'react-native'
import type { ReactElement } from 'react'
import { elevationStyle, type ElevationLevel } from './elevation'
import { ThemeProvider, useTheme } from './theme'
import { typeScale, type TypeRole } from './typography'
import { darkColors, lightColors } from './tokens'

// Only the system appearance hook is replaced; the rest of react-native stays real.
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
    __esModule: true,
    default: jest.fn(() => 'light'),
}))

const systemScheme = useColorScheme as unknown as jest.Mock

function SchemeProbe(): ReactElement {
    const { scheme } = useTheme()
    return <Text>{scheme}</Text>
}

describe('ThemeProvider', () => {
    it('falls back to the light palette when no provider is mounted', async () => {
        await render(<SchemeProbe />)
        expect(screen.getByText('light')).toBeTruthy()
    })

    it('follows the system appearance when no scheme is passed', async () => {
        systemScheme.mockReturnValue('dark')
        await render(
            <ThemeProvider>
                <SchemeProbe />
            </ThemeProvider>,
        )
        expect(screen.getByText('dark')).toBeTruthy()
        systemScheme.mockReturnValue('light')
    })

    it('an explicit scheme overrides the system appearance', async () => {
        systemScheme.mockReturnValue('dark')
        await render(
            <ThemeProvider scheme="light">
                <SchemeProbe />
            </ThemeProvider>,
        )
        expect(screen.getByText('light')).toBeTruthy()
        systemScheme.mockReturnValue('light')
    })

    it('exposes the palette that matches the resolved scheme', async () => {
        function ColourProbe(): ReactElement {
            const { colors } = useTheme()
            return <Text>{colors.canvas}</Text>
        }
        await render(
            <ThemeProvider scheme="dark">
                <ColourProbe />
            </ThemeProvider>,
        )
        expect(screen.getByText(darkColors.canvas)).toBeTruthy()
        expect(darkColors.canvas).not.toBe(lightColors.canvas)
    })
})

const ROLES = Object.keys(typeScale) as TypeRole[]

describe('type scale', () => {
    it.each(ROLES)('%s has a line height of at least 1.25 times its font size', (role) => {
        const style = typeScale[role]
        expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize * 1.25)
    })

    it.each(ROLES)('%s honours the complete system text-size range without a cap', (role) => {
        expect(typeScale[role].maxFontSizeMultiplier).toBe(0)
    })

    it('uses exactly five sizes, 28, 22, 17, 15 and 13, in the 400 and 600 weights only', () => {
        const sizes = new Set(ROLES.map((role) => typeScale[role].fontSize))
        expect([...sizes].sort((a, b) => b - a)).toEqual([28, 22, 17, 15, 13])
        for (const role of ROLES) {
            expect(['400', '600']).toContain(typeScale[role].fontWeight)
        }
    })

    it('keeps the named roles on their approved size and weight', () => {
        expect(typeScale.largeTitle).toMatchObject({ fontSize: 28, fontWeight: '600' })
        expect(typeScale.display).toMatchObject({ fontSize: 28, fontWeight: '600' })
        expect(typeScale.title).toMatchObject({ fontSize: 22, fontWeight: '600' })
        expect(typeScale.instruction).toMatchObject({ fontSize: 17, fontWeight: '600' })
        expect(typeScale.heading).toMatchObject({ fontSize: 17, fontWeight: '600' })
        expect(typeScale.callout).toMatchObject({ fontSize: 15, fontWeight: '400' })
        expect(typeScale.label).toMatchObject({ fontSize: 13, fontWeight: '600' })
    })

    it('uses the platform system sans consistently for every type role', () => {
        expect(typeScale.title.fontFamily).toBe(typeScale.display.fontFamily)
        expect(typeScale.body.fontFamily).toBeUndefined()
        for (const role of ROLES) {
            expect(typeScale[role].fontFamily).toBeUndefined()
        }
    })
})

describe('elevation', () => {
    it('is flat at level 0 on every platform', () => {
        expect(elevationStyle(0)).toEqual({})
    })

    it('uses native shadow props on iOS and Android', () => {
        const levels: ElevationLevel[] = [1, 2]
        for (const level of levels) {
            const style = elevationStyle(level)
            expect(style).toHaveProperty('shadowOpacity')
            expect(style).toHaveProperty('elevation')
            expect(style).not.toHaveProperty('boxShadow')
        }
    })

    it('uses boxShadow on web so react-native-web does not warn about legacy shadow props', () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'web')
        try {
            expect(elevationStyle(1)).toEqual({ boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)' })
            expect(elevationStyle(2)).toEqual({ boxShadow: '0 -4px 16px rgba(0, 0, 0, 0.18)' })
        } finally {
            platform.restore()
        }
    })
})
