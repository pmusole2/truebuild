import type { ReactElement } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { typeProps } from '../theme/typography'
import { controlHeight, primaryHeight, radius, space, touchTarget, type ColorToken } from '../theme/tokens'
import { Icon, type IconName } from './icons'
import { useFeedback } from './feedback'
import { focusRingStyle, useFocusRing } from './focus'
import { MotionPressable, usePressMotion } from './press-motion'
import { useOriginNativeId } from './render-origin'

// `accent` is the solid, saturated fill of the single primary task on a screen. `secondary` is a tonal sunken fill for
// other actions, and `quiet` is text with no container. Quiet actions never compete with a filled container.
// A control that cannot act keeps its place, dimmed. The press motion carries this opacity as its resting value.
const INACTIVE_OPACITY = 0.38

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'quiet' | 'danger'

const VARIANT_TOKENS: Readonly<Record<ButtonVariant, { container: ColorToken; text: ColorToken }>> = {
    primary: { container: 'accent', text: 'accentFillInk' },
    accent: { container: 'accent', text: 'accentFillInk' },
    secondary: { container: 'surfaceSunken', text: 'ink' },
    quiet: { container: 'surfaceSunken', text: 'ink' },
    danger: { container: 'refuseSurface', text: 'refuse' },
}

export type AppButtonProps = {
    readonly label: string
    readonly onPress: () => void
    readonly variant?: ButtonVariant
    readonly disabled?: boolean
    // Busy keeps the label visible, shows progress and blocks repeat presses while a request is in flight.
    readonly busy?: boolean
    readonly hint?: string
    // Full name for assistive tech when the visible label is shortened (for example "Up" for "Move page 2 up").
    readonly accessibilityLabel?: string
    readonly testID?: string
    readonly icon?: IconName
    // `primary` is the one 56 point action pinned above the safe area; tonal secondary buttons are 48 points and
    // every other button keeps the 44 point floor.
    readonly size?: 'regular' | 'primary'
    // Less horizontal inset for side-by-side coach actions at accessibility sizes; type and target floors stay intact.
    readonly compact?: boolean
    readonly nativeID?: string
}

export function AppButton({
    label,
    onPress,
    variant = 'secondary',
    disabled = false,
    busy = false,
    hint,
    accessibilityLabel,
    testID,
    icon,
    size = 'regular',
    compact = false,
    nativeID,
}: AppButtonProps): ReactElement {
    const inheritedId = useOriginNativeId(nativeID)
    const { colors } = useTheme()
    const { haptic } = useFeedback()
    const focus = useFocusRing()
    const inactive = disabled || busy
    const tokens = VARIANT_TOKENS[variant]
    const type = typeProps('button')
    const press = usePressMotion(inactive, inactive ? INACTIVE_OPACITY : 1)
    return (
        <MotionPressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? label}
            accessibilityHint={hint}
            accessibilityState={{ disabled: inactive, busy }}
            aria-disabled={inactive}
            disabled={inactive}
            {...focus.focusHandlers}
            onPress={(): void => {
                haptic('selection')
                onPress()
            }}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            testID={testID}
            nativeID={inheritedId}
            style={[
                styles.base,
                compact && styles.compact,
                variant === 'secondary' && styles.tonal,
                (size === 'primary' || variant === 'primary') && styles.primarySize,
                { backgroundColor: colors[tokens.container] },
                variant === 'quiet' && styles.quietText,
                focusRingStyle(focus.focused, colors),
                press.style,
            ]}
        >
            <View style={styles.row}>
                {busy ? <ActivityIndicator color={colors[tokens.text]} /> : null}
                {!busy && icon !== undefined ? <Icon name={icon} size="sm" color={colors[tokens.text]} /> : null}
                <Text
                    maxFontSizeMultiplier={type.maxFontSizeMultiplier}
                    style={[type.style, styles.label, { color: colors[tokens.text] }]}
                >
                    {label}
                </Text>
            </View>
        </MotionPressable>
    )
}

export type IconButtonProps = {
    // Icon-only controls have no visible text, so the label is the accessible name and is required.
    readonly label: string
    readonly icon: IconName
    readonly onPress: () => void
    // Round and tonal by default; `quiet` drops the fill for a header control that should stay calm.
    readonly variant?: Exclude<ButtonVariant, 'primary'>
    readonly disabled?: boolean
    readonly testID?: string
    readonly nativeID?: string
}

export function IconButton({
    label,
    icon,
    onPress,
    variant = 'secondary',
    disabled = false,
    testID,
    nativeID,
}: IconButtonProps): ReactElement {
    const inheritedId = useOriginNativeId(nativeID)
    const { colors } = useTheme()
    const { haptic } = useFeedback()
    const focus = useFocusRing()
    const tokens = VARIANT_TOKENS[variant]
    const press = usePressMotion(disabled, disabled ? INACTIVE_OPACITY : 1)
    return (
        <MotionPressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            aria-disabled={disabled}
            disabled={disabled}
            {...focus.focusHandlers}
            onPress={(): void => {
                haptic('selection')
                onPress()
            }}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            testID={testID}
            nativeID={inheritedId}
            style={[
                styles.base,
                styles.round,
                { backgroundColor: colors[tokens.container] },
                variant === 'quiet' && styles.quiet,
                focusRingStyle(focus.focused, colors),
                press.style,
            ]}
        >
            <Icon name={icon} color={colors[tokens.text]} />
        </MotionPressable>
    )
}

const styles = StyleSheet.create({
    base: {
        minHeight: touchTarget,
        minWidth: touchTarget,
        maxWidth: '100%',
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderRadius: radius.md,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
    },
    primarySize: { minHeight: primaryHeight },
    tonal: { minHeight: controlHeight },
    compact: { paddingHorizontal: space.xs },
    // A quiet text button has no fill and no outline: it reads as text with a 44 point target.
    quietText: { backgroundColor: 'transparent' },
    quiet: { backgroundColor: 'transparent' },
    // A round control at 48 points: the circle keeps the fill tonal and the target clear of its neighbours.
    round: {
        width: controlHeight,
        minWidth: controlHeight,
        height: controlHeight,
        minHeight: controlHeight,
        borderRadius: radius.pill,
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
    row: {
        flexDirection: 'row',
        maxWidth: '100%',
        flexShrink: 1,
        alignItems: 'center',
        gap: space.xs,
    },
    label: {
        textAlign: 'center',
        flexShrink: 1,
    },
})
