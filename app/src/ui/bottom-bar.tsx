import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CoachTarget } from '../features/onboarding/coach-provider'
import { useTheme } from '../theme/theme'
import { space } from '../theme/tokens'
import { AppButton, IconButton } from './button'
import type { IconName } from './icons'
import { useLargeText } from './large-text'
import { Caption } from './text'
import { useOriginNativeId } from './render-origin'

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
    // Render-origin marker when this action's label, icon and behaviour were composed from a screen document.
    readonly nativeID?: string
}

// At accessibility text sizes a long reason scrolls inside this share of the window instead of pushing the bar up.
const REASON_MAX_RATIO = 0.2

/**
 * The fixed bottom bar: one 56 point primary above the safe area, at most one quiet secondary, and an optional
 * one-line reason that explains a disabled primary. It sits outside every scroll view, so the primary never moves.
 *
 * At accessibility text sizes the primary shows one short verb and a secondary becomes a 44 point icon in the same row
 * (a secondary with no primary keeps its words), so the bar stays one row tall and the screen's own text keeps the room. Every action keeps its full accessible name
 * and test ID; the visible words are the only thing that shortens.
 */
export function FixedBottomBar({
    primary,
    secondary,
    reason,
    testID = 'bottom-bar',
    nativeID,
    reasonNativeID,
    placement = 'flow',
    onHeight,
    navigation,
    secondaryVariant = 'secondary',
}: {
    readonly navigation?: ReactElement<{ primary?: ReactNode; secondary?: ReactNode }>
    readonly secondaryVariant?: 'quiet' | 'secondary'
    readonly primary: BarAction | null
    readonly secondary?: BarAction
    readonly reason?: string | null
    readonly testID?: string
    /** Render-origin marker for the bar as a whole, when a document composed it. */
    readonly nativeID?: string
    /** A press-time guard's explanation may have a different source than the composed action. */
    readonly reasonNativeID?: string
    // 'overlay' floats the bar over the bottom edge so a scroll view above can fill the whole screen (the iOS large title
    // only collapses with a full-screen scroll view). The screen then pads its content by the height reported here.
    readonly placement?: 'flow' | 'overlay'
    readonly onHeight?: (height: number) => void
}): ReactElement {
    const barId = useOriginNativeId(nativeID)
    const reasonId = useOriginNativeId(reasonNativeID)
    const { colors } = useTheme()
    const insets = useSafeAreaInsets()
    const large = useLargeText()
    const { height } = useWindowDimensions()
    const shown = (action: BarAction): BarAction =>
        large && action.compactLabel !== undefined
            ? { ...action, label: action.compactLabel, accessibilityLabel: action.accessibilityLabel ?? action.label }
            : action
    // A real, enabled action is a tip target under its test ID. The registry runs this same `onPress`; a disabled or
    // busy action offers none, so a late tap can never run an action the button itself would refuse.
    const target = (action: BarAction, node: ReactElement): ReactElement =>
        action.testID === undefined ? (
            node
        ) : (
            <CoachTarget
                id={action.testID}
                label={action.accessibilityLabel ?? action.label}
                onPress={action.disabled === true || action.busy === true ? undefined : action.onPress}
            >
                {node}
            </CoachTarget>
        )
    // A secondary that stands alone (no primary beside it) keeps its words: an icon by itself reads as debris.
    const iconSecondary = large && primary !== null && secondary !== undefined && secondary.icon !== undefined
    return (
        <View
            testID={testID}
            nativeID={barId}
            onLayout={onHeight === undefined ? undefined : (event): void => onHeight(event.nativeEvent.layout.height)}
            style={[
                styles.bar,
                placement === 'overlay' && styles.overlay,
                { backgroundColor: colors.canvas, paddingBottom: space.sm + insets.bottom },
            ]}
        >
            {reason === undefined || reason === null ? null : large ? (
                <ScrollView
                    nativeID={reasonId}
                    accessibilityLiveRegion="polite"
                    style={{ maxHeight: Math.round(height * REASON_MAX_RATIO) }}
                    contentContainerStyle={styles.reason}
                >
                    <Caption tone="muted">{reason}</Caption>
                </ScrollView>
            ) : (
                <View nativeID={reasonId} accessibilityLiveRegion="polite" style={styles.reason}>
                    <Caption tone="muted">{reason}</Caption>
                </View>
            )}
            {navigation !== undefined && primary !== null ? (
                cloneElement(navigation, {
                    primary: target(primary, <AppButton variant="accent" size="primary" {...shown(primary)} />),
                    secondary:
                        secondary === undefined
                            ? undefined
                            : target(
                                  secondary,
                                  <IconButton
                                      label={secondary.accessibilityLabel ?? secondary.label}
                                      icon={secondary.icon ?? 'more'}
                                      variant={secondaryVariant}
                                      disabled={secondary.disabled === true || secondary.busy === true}
                                      testID={secondary.testID}
                                      nativeID={secondary.nativeID}
                                      onPress={secondary.onPress}
                                  />,
                              ),
                })
            ) : iconSecondary && primary !== null && secondary !== undefined ? (
                <View style={styles.row}>
                    <View style={styles.grow}>
                        {target(primary, <AppButton variant="accent" size="primary" {...shown(primary)} />)}
                    </View>
                    {target(
                        secondary,
                        <IconButton
                            label={secondary.accessibilityLabel ?? secondary.label}
                            icon={secondary.icon!}
                            disabled={secondary.disabled === true || secondary.busy === true}
                            testID={secondary.testID}
                            nativeID={secondary.nativeID}
                            onPress={secondary.onPress}
                        />,
                    )}
                </View>
            ) : (
                <>
                    {primary === null
                        ? null
                        : target(primary, <AppButton variant="accent" size="primary" {...shown(primary)} />)}
                    {secondary === undefined
                        ? null
                        : target(secondary, <AppButton variant={secondaryVariant} {...shown(secondary)} />)}
                </>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    bar: { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.xs, flexShrink: 0 },
    overlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    reason: { alignItems: 'center' },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
    grow: { flex: 1 },
})
