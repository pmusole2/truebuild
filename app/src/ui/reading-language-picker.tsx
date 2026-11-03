import type { ReactElement } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space, touchTarget } from '../theme/tokens'
import { focusRingStyle, useFocusRing } from './focus'
import { Body } from './text'

const LANGUAGES = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Spanish' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
    { value: 'pt-BR', label: 'Portuguese' },
] as const

/** Stacked choices keep every language readable at phone widths and with larger text. */
export function ReadingLanguagePicker({
    label,
    value,
    onChange,
    disabled = false,
}: {
    readonly label: string
    readonly value: string
    readonly onChange: (value: string) => void
    readonly disabled?: boolean
}): ReactElement {
    return (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.list}>
            {LANGUAGES.map((option) => (
                <LanguageChoice
                    key={option.value}
                    label={option.label}
                    selected={value === option.value}
                    disabled={disabled}
                    onPress={(): void => onChange(option.value)}
                />
            ))}
        </View>
    )
}

function LanguageChoice({
    label,
    selected,
    disabled,
    onPress,
}: {
    readonly label: string
    readonly selected: boolean
    readonly disabled: boolean
    readonly onPress: () => void
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Pressable
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ checked: selected, ...(disabled ? { disabled: true } : {}) }}
            aria-checked={selected}
            disabled={disabled}
            {...focus.focusHandlers}
            onPress={(): void => {
                if (!disabled) onPress()
            }}
            style={[
                styles.option,
                {
                    backgroundColor: selected ? colors.accent : colors.surfaceRaised,
                    borderColor: selected ? colors.accent : colors.borderStrong,
                },
                focusRingStyle(focus.focused, colors),
            ]}
        >
            <Body tone={selected ? 'onAccent' : 'default'}>{label}</Body>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    list: { gap: space.xs, alignSelf: 'stretch' },
    option: {
        minHeight: touchTarget,
        justifyContent: 'center',
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderWidth: 1,
        borderRadius: radius.md,
    },
})
