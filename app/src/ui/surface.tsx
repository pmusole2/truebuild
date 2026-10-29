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
    padded = true,
    testID,
}: {
    readonly children: ReactNode
    readonly scroll?: boolean
    readonly header?: 'native' | 'hidden'
    // Camera and guide layouts supply their own insets while retaining the safe-area boundary.
    readonly padded?: boolean
    readonly testID?: string
}): ReactElement {
    const { colors } = useTheme()
    const edges = header === 'hidden' ? EDGES_FULL_BLEED : EDGES_UNDER_HEADER
    if (!scroll) {
        return (
            <SafeAreaView edges={edges} style={[styles.root, { backgroundColor: colors.canvas }]} testID={testID}>
                <View style={[styles.fill, padded && styles.padding]}>{children}</View>
            </SafeAreaView>
        )
    }
    return (
        <SafeAreaView edges={edges} style={[styles.root, { backgroundColor: colors.canvas }]} testID={testID}>
            <ScrollView
                contentContainerStyle={[styles.content, padded && styles.padding]}
                keyboardShouldPersistTaps="handled"
            >
                {children}
            </ScrollView>
        </SafeAreaView>
    )
}

const GAPS = { xs: space.xs, sm: space.sm, md: space.md, lg: space.lg } as const

export function Stack({
    gap = 'md',
    children,
    nativeID,
}: {
    readonly gap?: keyof typeof GAPS
    readonly children: ReactNode
    readonly nativeID?: string
}): ReactElement {
    return (
        <View nativeID={nativeID} style={{ gap: GAPS[gap] }}>
            {children}
        </View>
    )
}

// Cards are filled shapes with no outline: `result` is lifted and `raised` sits one step above the canvas, so a verdict
// reads before the facts around it without borders or accent bars.
export type CardTone = 'surface' | 'raised' | 'result'

export function Card({
    children,
    elevation = 0,
    tone = 'surface',
    testID,
    nativeID,
}: {
    readonly children: ReactNode
    readonly elevation?: ElevationLevel
    readonly tone?: CardTone
    readonly testID?: string
    readonly nativeID?: string
}): ReactElement {
    const { colors, scheme } = useTheme()
    // In the dark scheme the plain surface sits too close to the canvas, so every card uses the raised surface.
    const raised = tone !== 'surface' || scheme === 'dark'
    const lift: ElevationLevel = tone === 'result' ? (Math.max(elevation, 1) as ElevationLevel) : elevation
    return (
        <View
            testID={testID}
            nativeID={nativeID}
            style={[
                styles.card,
                { backgroundColor: raised ? colors.surfaceRaised : colors.surface },
                elevationStyle(lift),
            ]}
        >
            {children}
        </View>
    )
}

export function Divider({ testID }: { readonly testID?: string }): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            testID={testID}
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={[styles.divider, { backgroundColor: colors.border }]}
        />
    )
}

/** Wrapping secondary controls stay readable at narrow widths and with larger system text. */
export function ActionGroup({ children }: { readonly children: ReactNode }): ReactElement {
    return <View style={styles.actions}>{children}</View>
}

/** Kept outside a screen's scroll content so its primary action remains available beside a long result. */
export function ActionDock({
    children,
    testID,
}: {
    readonly children: ReactNode
    readonly testID?: string
}): ReactElement {
    const { colors } = useTheme()
    return (
        <View testID={testID} style={[styles.dock, { backgroundColor: colors.surface }]}>
            {children}
        </View>
    )
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
    },
    fill: {
        flex: 1,
        minHeight: 0,
    },
    content: {
        gap: space.md,
    },
    padding: { padding: space.md },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    dock: {
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        paddingBottom: space.md,
        gap: space.xs,
        flexShrink: 0,
    },
    card: {
        borderRadius: radius.lg,
        borderCurve: 'continuous',
        padding: space.md,
        gap: space.sm,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
    },
})
