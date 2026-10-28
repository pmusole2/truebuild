import type { ReactElement } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { typeProps } from '../theme/typography'
import { radius, space, touchTarget, type ColorToken } from '../theme/tokens'
import { Icon, type IconName } from './icons'
import { useFeedback } from './feedback'
import { focusRingStyle, useFocusRing } from './focus'

// `accent` marks the single primary task on a screen. Quiet actions use text without competing filled containers.
export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'quiet' | 'danger'

const VARIANT_TOKENS: Readonly<Record<ButtonVariant, { container: ColorToken; border: ColorToken; text: ColorToken }>> =
    {
        primary: { container: 'fillStrong', border: 'fillStrong', text: 'fillStrongInk' },
        accent: { container: 'accent', border: 'accent', text: 'accentFillInk' },
        secondary: { container: 'surfaceRaised', border: 'borderStrong', text: 'ink' },
        quiet: { container: 'surfaceSunken', border: 'border', text: 'ink' },
        danger: { container: 'refuseSurface', border: 'refuse', text: 'refuse' },
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
}: AppButtonProps): ReactElement {
    const { colors } = useTheme()
    const { haptic } = useFeedback()
    const focus = useFocusRing()
    const inactive = disabled || busy
    const tokens = VARIANT_TOKENS[variant]
    const type = typeProps('button')
    return (
        <Pressable
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
            testID={testID}
            style={({ pressed }) => [
                styles.base,
                { backgroundColor: colors[tokens.container], borderColor: colors[tokens.border] },
                variant === 'quiet' && styles.quiet,
                focusRingStyle(focus.focused, colors),
                pressed && !inactive && styles.pressed,
                inactive && styles.inactive,
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
        </Pressable>
    )
}

export type IconButtonProps = {
    // Icon-only controls have no visible text, so the label is the accessible name and is required.
    readonly label: string
    readonly icon: IconName
    readonly onPress: () => void
    readonly variant?: Exclude<ButtonVariant, 'accent' | 'primary'>
    readonly disabled?: boolean
    readonly testID?: string
}

export function IconButton({
    label,
    icon,
    onPress,
    variant = 'quiet',
    disabled = false,
    testID,
}: IconButtonProps): ReactElement {
    const { colors } = useTheme()
    const { haptic } = useFeedback()
    const focus = useFocusRing()
    const tokens = VARIANT_TOKENS[variant]
    return (
        <Pressable
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
            testID={testID}
            style={({ pressed }) => [
                styles.base,
                styles.square,
                { backgroundColor: colors[tokens.container], borderColor: colors[tokens.border] },
                variant === 'quiet' && styles.quiet,
                focusRingStyle(focus.focused, colors),
                pressed && !disabled && styles.pressed,
                disabled && styles.inactive,
            ]}
        >
            <Icon name={icon} color={colors[tokens.text]} />
        </Pressable>
    )
}

const styles = StyleSheet.create({
    base: {
        minHeight: touchTarget,
        minWidth: touchTarget,
        maxWidth: '100%',
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderWidth: 1,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
    },
    quiet: { backgroundColor: 'transparent', borderColor: 'transparent' },
    square: {
        width: touchTarget,
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
    pressed: {
        opacity: 0.8,
    },
    inactive: {
        opacity: 0.5,
    },
})
