import type { ReactElement, ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView, type Edge } from 'react-native-safe-area-context'
import { elevationStyle, type ElevationLevel } from '../theme/elevation'
import { useTheme } from '../theme/theme'
import { radius, space } from '../theme/tokens'

const EDGES: Edge[] = ['left', 'right', 'bottom']

// The navigation header already covers the top inset; the shell keeps content clear of the home indicator and sides.
export function Screen({
    children,
    scroll = true,
    testID,
}: {
    readonly children: ReactNode
    readonly scroll?: boolean
    readonly testID?: string
}): ReactElement {
    const { colors } = useTheme()
    if (!scroll) {
        return (
            <SafeAreaView edges={EDGES} style={[styles.root, { backgroundColor: colors.canvas }]} testID={testID}>
                <View style={styles.fill}>{children}</View>
            </SafeAreaView>
        )
    }
    return (
        <SafeAreaView edges={EDGES} style={[styles.root, { backgroundColor: colors.canvas }]} testID={testID}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                {children}
            </ScrollView>
        </SafeAreaView>
    )
}

const GAPS = { xs: space.xs, sm: space.sm, md: space.md, lg: space.lg } as const

export function Stack({
    gap = 'md',
    children,
}: {
    readonly gap?: keyof typeof GAPS
    readonly children: ReactNode
}): ReactElement {
    return <View style={{ gap: GAPS[gap] }}>{children}</View>
}

export function Card({
    children,
    elevation = 0,
    tone = 'surface',
}: {
    readonly children: ReactNode
    readonly elevation?: ElevationLevel
    readonly tone?: 'surface' | 'raised'
}): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            style={[
                styles.card,
                {
                    backgroundColor: tone === 'raised' ? colors.surfaceRaised : colors.surface,
                    borderColor: colors.border,
                },
                elevationStyle(elevation),
            ]}
        >
            {children}
        </View>
    )
}

export function Divider(): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={[styles.divider, { backgroundColor: colors.border }]}
        />
    )
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
    },
    fill: {
        flex: 1,
        padding: space.md,
    },
    content: {
        padding: space.md,
        gap: space.md,
    },
    card: {
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: space.md,
        gap: space.sm,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
    },
})
