import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/theme'
import { space } from '../theme/tokens'
import { AppButton } from './button'
import type { IconName } from './icons'
import { Callout } from './text'

export type BarAction = {
    readonly label: string
    readonly onPress: () => void
    readonly disabled?: boolean
    readonly busy?: boolean
    readonly testID?: string
    readonly icon?: IconName
    readonly accessibilityLabel?: string
}

/**
 * The fixed bottom bar: one 56 point primary above the safe area, at most one quiet secondary, and an optional
 * one-line reason that explains a disabled primary. It sits outside every scroll view, so the primary never moves.
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
    return (
        <View
            testID={testID}
            style={[styles.bar, { backgroundColor: colors.canvas, paddingBottom: space.sm + insets.bottom }]}
        >
            {reason === undefined || reason === null ? null : (
                <View accessibilityLiveRegion="polite" style={styles.reason}>
                    <Callout tone="muted">{reason}</Callout>
                </View>
            )}
            {primary === null ? null : <AppButton variant="accent" size="primary" {...primary} />}
            {secondary === undefined ? null : <AppButton variant="quiet" {...secondary} />}
        </View>
    )
}

const styles = StyleSheet.create({
    bar: { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.xs, flexShrink: 0 },
    reason: { alignItems: 'center' },
})
