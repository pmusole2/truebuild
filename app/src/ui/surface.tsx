import type { ReactElement, ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView, type Edge } from 'react-native-safe-area-context'
import { elevationStyle, type ElevationLevel } from '../theme/elevation'
import { useTheme } from '../theme/theme'
import { radius, space } from '../theme/tokens'

// With the native header shown, the header already clears the top inset. With it hidden (full-bleed camera), the shell
// must clear the top inset itself.
const EDGES_UNDER_HEADER: Edge[] = ['left', 'right', 'bottom']
const EDGES_FULL_BLEED: Edge[] = ['top', 'left', 'right', 'bottom']

export function Screen({
    children,
    scroll = true,
    header = 'native',
    testID,
}: {
    readonly children: ReactNode
    readonly scroll?: boolean
    readonly header?: 'native' | 'hidden'
    readonly testID?: string
}): ReactElement {
    const { colors } = useTheme()
    const edges = header === 'hidden' ? EDGES_FULL_BLEED : EDGES_UNDER_HEADER
    if (!scroll) {
        return (
            <SafeAreaView edges={edges} style={[styles.root, { backgroundColor: colors.canvas }]} testID={testID}>
                <View style={styles.fill}>{children}</View>
            </SafeAreaView>
        )
    }
    return (
        <SafeAreaView edges={edges} style={[styles.root, { backgroundColor: colors.canvas }]} testID={testID}>
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
