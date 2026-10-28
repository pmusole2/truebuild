import type { ReactElement } from 'react'
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/theme'
import { space } from '../theme/tokens'
import { AppButton, IconButton } from './button'
import type { IconName } from './icons'
import { useLargeText } from './large-text'
import { Callout } from './text'

export type BarAction = {
    readonly label: string
    readonly onPress: () => void
    readonly disabled?: boolean
    readonly busy?: boolean
    readonly testID?: string
    readonly icon?: IconName
    // Full name for assistive tech. It is kept at every text size; only the visible words get shorter.
    readonly accessibilityLabel?: string
    // The short visible verb at accessibility text sizes (for example "Start" for "Start building").
    readonly compactLabel?: string
}

// At accessibility text sizes a long reason scrolls inside this share of the window instead of pushing the bar up.
const REASON_MAX_RATIO = 0.2

/**
 * The fixed bottom bar: one 56 point primary above the safe area, at most one quiet secondary, and an optional
 * one-line reason that explains a disabled primary. It sits outside every scroll view, so the primary never moves.
 *
 * At accessibility text sizes the primary shows one short verb and a secondary becomes a 44 point icon in the same row,
 * so the bar stays one row tall and the screen's own text keeps the room. Every action keeps its full accessible name
 * and test ID; the visible words are the only thing that shortens.
 */
export function FixedBottomBar({
    primary,
    secondary,
    reason,
    testID = 'bottom-bar',
}: {
    readonly primary: BarAction | null
    readonly secondary?: BarAction
    readonly reason?: string | null
    readonly testID?: string
}): ReactElement {
    const { colors } = useTheme()
    const insets = useSafeAreaInsets()
    const large = useLargeText()
    const { height } = useWindowDimensions()
    const shown = (action: BarAction): BarAction =>
        large && action.compactLabel !== undefined
            ? { ...action, label: action.compactLabel, accessibilityLabel: action.accessibilityLabel ?? action.label }
            : action
    const iconSecondary = large && secondary !== undefined && secondary.icon !== undefined
    return (
        <View
            testID={testID}
            style={[styles.bar, { backgroundColor: colors.canvas, paddingBottom: space.sm + insets.bottom }]}
        >
            {reason === undefined || reason === null ? null : large ? (
                <ScrollView
                    accessibilityLiveRegion="polite"
                    style={{ maxHeight: Math.round(height * REASON_MAX_RATIO) }}
                    contentContainerStyle={styles.reason}
                >
                    <Callout tone="muted">{reason}</Callout>
                </ScrollView>
            ) : (
                <View accessibilityLiveRegion="polite" style={styles.reason}>
                    <Callout tone="muted">{reason}</Callout>
                </View>
            )}
            {iconSecondary && secondary !== undefined ? (
                <View style={styles.row}>
                    {primary === null ? null : (
                        <View style={styles.grow}>
                            <AppButton variant="accent" size="primary" {...shown(primary)} />
                        </View>
                    )}
                    <IconButton
                        label={secondary.accessibilityLabel ?? secondary.label}
                        icon={secondary.icon!}
                        disabled={secondary.disabled === true || secondary.busy === true}
                        testID={secondary.testID}
                        onPress={secondary.onPress}
                    />
                </View>
            ) : (
                <>
                    {primary === null ? null : <AppButton variant="accent" size="primary" {...shown(primary)} />}
                    {secondary === undefined ? null : <AppButton variant="quiet" {...shown(secondary)} />}
                </>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    bar: { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.xs, flexShrink: 0 },
    reason: { alignItems: 'center' },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
    grow: { flex: 1 },
})
