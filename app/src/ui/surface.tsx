import type { ReactElement, ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView, type Edge } from 'react-native-safe-area-context'
import { elevationStyle, type ElevationLevel } from '../theme/elevation'
import { useTheme } from '../theme/theme'
import { radius, space, type ColorToken } from '../theme/tokens'

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
}: {
    readonly gap?: keyof typeof GAPS
    readonly children: ReactNode
}): ReactElement {
    return <View style={{ gap: GAPS[gap] }}>{children}</View>
}

// `result` is the hero card: raised, strongly bordered and lifted, so a verdict reads before the facts around it.
export type CardTone = 'surface' | 'raised' | 'result'

// The status bar width on a hero card. It sits inside the border and follows the rounded corners.
const CARD_BAR_WIDTH = 4

export function Card({
    children,
    elevation = 0,
    tone = 'surface',
    bar,
    testID,
}: {
    readonly children: ReactNode
    readonly elevation?: ElevationLevel
    readonly tone?: CardTone
    // Status colour drawn as a bar down the left edge, always accompanied by text and an icon inside the card.
    readonly bar?: ColorToken
    readonly testID?: string
}): ReactElement {
    const { colors, scheme } = useTheme()
    // In the dark scheme the plain surface sits too close to the canvas, so every card uses the raised surface.
    const raised = tone !== 'surface' || scheme === 'dark'
    const lift: ElevationLevel = tone === 'result' ? (Math.max(elevation, 1) as ElevationLevel) : elevation
    return (
        <View
            testID={testID}
            style={[
                styles.card,
                {
                    backgroundColor: raised ? colors.surfaceRaised : colors.surface,
                    borderColor: tone === 'result' ? colors.borderStrong : colors.border,
                },
                elevationStyle(lift),
            ]}
        >
            {bar === undefined ? null : (
                <View
                    testID="card-bar"
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no"
                    style={[styles.bar, { backgroundColor: colors[bar] }]}
                />
            )}
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
    const { colors, scheme } = useTheme()
    // A full rule, strong in light where the canvas is pale, so the dock never melts into the scrolling result.
    return (
        <View
            testID={testID}
            style={[
                styles.dock,
                {
                    backgroundColor: colors.surface,
                    borderColor: scheme === 'light' ? colors.borderStrong : colors.border,
                },
            ]}
        >
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
        borderTopWidth: 1,
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        paddingBottom: space.md,
        gap: space.xs,
        flexShrink: 0,
    },
    card: {
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: space.md,
        gap: space.sm,
    },
    bar: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: CARD_BAR_WIDTH,
        borderTopLeftRadius: radius.lg - 1,
        borderBottomLeftRadius: radius.lg - 1,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
    },
})
