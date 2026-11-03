import type { ReactElement } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { READING_LANGUAGES } from '@truebuild/contracts'
import { useTheme } from '../theme/theme'
import { radius, space, touchTarget } from '../theme/tokens'
import { focusRingStyle, useFocusRing } from './focus'
import { Body, Caption } from './text'

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
        <View style={styles.list}>
            {/* The caption and hint are visual context; the radiogroup's label is what assistive tech announces. */}
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.list}>
                <Caption>Manual language</Caption>
                <Caption>The language TrueBuild reads and writes in</Caption>
            </View>
            <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.list}>
                {READING_LANGUAGES.map((option) => (
                    <LanguageChoice
                        key={option.code}
                        label={option.label}
                        selected={value === option.code}
                        disabled={disabled}
                        onPress={(): void => onChange(option.code)}
                    />
                ))}
            </View>
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
