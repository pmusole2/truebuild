import { useState, type ReactElement } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { typeProps } from '../theme/typography'
import { radius, space, touchTarget } from '../theme/tokens'
import { Caption, Label } from './text'

export type TextFieldProps = {
    readonly label: string
    readonly value: string
    readonly onChangeText: (value: string) => void
    readonly placeholder?: string
    readonly hint?: string
    readonly error?: string
    readonly multiline?: boolean
    readonly keyboardType?: 'default' | 'number-pad'
    // Secret entry (for example a shared key): masked, never autocorrected or autocapitalised.
    readonly secure?: boolean
    readonly onSubmitEditing?: () => void
}

/** Labelled text input. Errors are announced and linked to the field as its accessibility hint. */
export function TextField({
    label,
    value,
    onChangeText,
    placeholder,
    hint,
    error,
    multiline = false,
    keyboardType = 'default',
    secure = false,
    onSubmitEditing,
}: TextFieldProps): ReactElement {
    const { colors } = useTheme()
    const type = typeProps('body')
    const [focused, setFocused] = useState(false)
    const described = error ?? hint
    return (
        <View style={styles.field}>
            <Label>{label}</Label>
            <TextInput
                accessibilityLabel={label}
                accessibilityHint={described}
                aria-invalid={error !== undefined}
                value={value}
                onChangeText={onChangeText}
                placeholder={placeholder}
                placeholderTextColor={colors.inkMuted}
                onSubmitEditing={onSubmitEditing}
                onFocus={(): void => setFocused(true)}
                onBlur={(): void => setFocused(false)}
                keyboardType={keyboardType}
                secureTextEntry={secure}
                autoCapitalize={secure ? 'none' : 'sentences'}
                autoCorrect={!secure}
                returnKeyType={multiline ? 'default' : 'done'}
                multiline={multiline}
                textAlignVertical={multiline ? 'top' : 'center'}
                maxFontSizeMultiplier={type.maxFontSizeMultiplier}
                style={[
                    type.style,
                    styles.input,
                    multiline && styles.multiline,
                    {
                        color: colors.ink,
                        backgroundColor: colors.surfaceRaised,
                        borderColor:
                            error === undefined ? (focused ? colors.focus : colors.borderStrong) : colors.refuse,
                    },
                ]}
            />
            {error === undefined ? null : <Caption tone="refuse">{error}</Caption>}
            {error !== undefined || hint === undefined ? null : <Caption>{hint}</Caption>}
        </View>
    )
}

export type SegmentOption<T extends string> = { readonly value: T; readonly label: string }

/** A single-choice group. Each option is a radio with its own 44 point target and a visible selected state. */
export function SegmentedControl<T extends string>({
    label,
    options,
    value,
    onChange,
}: {
    readonly label: string
    readonly options: readonly SegmentOption<T>[]
    readonly value: T
    readonly onChange: (value: T) => void
}): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            accessibilityRole="radiogroup"
            accessibilityLabel={label}
            style={[styles.segmented, { borderColor: colors.borderStrong }]}
        >
            {options.map((option) => {
                const selected = option.value === value
                return (
                    <Pressable
                        key={option.value}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{ checked: selected }}
                        aria-checked={selected}
                        onPress={(): void => onChange(option.value)}
                        style={[
                            styles.segment,
                            { backgroundColor: selected ? colors.fillStrong : colors.surfaceRaised },
                        ]}
                    >
                        <Caption tone={selected ? 'inverse' : 'default'}>{option.label}</Caption>
                    </Pressable>
                )
            })}
        </View>
    )
}

/** A two-state setting. The on/off word is shown as text so the state never depends on the switch colour alone. */
export function SettingRow({
    label,
    description,
    value,
    onValueChange,
    testID,
}: {
    readonly label: string
    readonly description?: string
    readonly value: boolean
    readonly onValueChange: (value: boolean) => void
    readonly testID?: string
}): ReactElement {
    const { colors } = useTheme()
    return (
        <Pressable
            accessibilityRole="switch"
            accessibilityLabel={label}
            accessibilityHint={description}
            accessibilityState={{ checked: value }}
            aria-checked={value}
            onPress={(): void => onValueChange(!value)}
            testID={testID}
            style={[styles.setting, { borderColor: colors.border }]}
        >
            <View style={styles.settingText}>
                <Label>{label}</Label>
                {description === undefined ? null : <Caption>{description}</Caption>}
            </View>
            <Caption tone="default">{value ? 'On' : 'Off'}</Caption>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    field: {
        gap: space.xs,
    },
    input: {
        minHeight: touchTarget,
        borderWidth: 1,
        borderRadius: radius.md,
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
    },
    multiline: {
        minHeight: touchTarget * 2,
    },
    segmented: {
        flexDirection: 'row',
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderRadius: radius.md,
        overflow: 'hidden',
    },
    segment: {
        minHeight: touchTarget,
        minWidth: touchTarget,
        paddingHorizontal: space.md,
        justifyContent: 'center',
        alignItems: 'center',
    },
    setting: {
        minHeight: touchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: space.xs,
        borderBottomWidth: 1,
    },
    settingText: {
        flex: 1,
        gap: space.xxs,
    },
})
