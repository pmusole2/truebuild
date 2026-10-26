import type { ReactElement, ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { fonts, palette, radius, space, touchTarget } from './theme'

// Shown on every simulated output so fixture results cannot be mistaken for live analysis.
export const FIXTURE_LABEL = 'Demo data — simulated results'

type ButtonTone = 'primary' | 'quiet' | 'danger'

type ActionButtonProps = {
    readonly label: string
    readonly onPress: () => void
    readonly tone?: ButtonTone
    readonly disabled?: boolean
}

const BUTTON_TONES: Record<ButtonTone, { container: object; text: object }> = {
    primary: {
        container: { backgroundColor: palette.charcoal, borderColor: palette.charcoal },
        text: { color: palette.paperRaised },
    },
    quiet: {
        container: { backgroundColor: palette.paperRaised, borderColor: palette.rule },
        text: { color: palette.charcoal },
    },
    danger: {
        container: { backgroundColor: palette.paperRaised, borderColor: palette.signalInk },
        text: { color: palette.signalInk },
    },
}

export function ActionButton({ label, onPress, tone = 'quiet', disabled = false }: ActionButtonProps): ReactElement {
    const toneStyle = BUTTON_TONES[tone]
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            aria-disabled={disabled}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [
                styles.button,
                toneStyle.container,
                disabled && styles.disabled,
                pressed && !disabled && styles.pressed,
            ]}
        >
            <Text style={[styles.buttonText, toneStyle.text]}>{label}</Text>
        </Pressable>
    )
}

type SegmentedOption<T extends string> = { readonly value: T; readonly label: string }

type SegmentedProps<T extends string> = {
    readonly label: string
    readonly options: readonly SegmentedOption<T>[]
    readonly value: T
    readonly onChange: (value: T) => void
}

export function Segmented<T extends string>({ label, options, value, onChange }: SegmentedProps<T>): ReactElement {
    return (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.segmented}>
            {options.map((option) => {
                const selected = option.value === value
                return (
                    <Pressable
                        key={option.value}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        aria-checked={selected}
                        onPress={() => onChange(option.value)}
                        style={[styles.segment, selected && styles.segmentSelected]}
                    >
                        <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{option.label}</Text>
                    </Pressable>
                )
            })}
        </View>
    )
}

type TextFieldProps = {
    readonly label: string
    readonly value: string
    readonly onChangeText: (value: string) => void
    readonly placeholder?: string
    readonly onSubmitEditing?: () => void
    readonly keyboardType?: 'default' | 'number-pad'
    // Secret entry (owner token): masked, never autocorrected or autocapitalised.
    readonly secure?: boolean
}

export function TextField({
    label,
    value,
    onChangeText,
    placeholder,
    onSubmitEditing,
    keyboardType = 'default',
    secure = false,
}: TextFieldProps): ReactElement {
    return (
        <View style={styles.field}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
                accessibilityLabel={label}
                value={value}
                onChangeText={onChangeText}
                placeholder={placeholder}
                placeholderTextColor={palette.graphite}
                onSubmitEditing={onSubmitEditing}
                keyboardType={keyboardType}
                secureTextEntry={secure}
                autoCapitalize={secure ? 'none' : 'sentences'}
                autoCorrect={!secure}
                returnKeyType="done"
                style={styles.input}
            />
        </View>
    )
}

export function Panel({ children }: { readonly children: ReactNode }): ReactElement {
    return <View style={styles.panel}>{children}</View>
}

type TagTone = 'simulated' | 'reviewed' | 'unreviewed'

const TAG_TONES: Record<TagTone, { container: object; text: object }> = {
    simulated: {
        container: { backgroundColor: palette.charcoal, borderColor: palette.charcoal },
        text: { color: palette.paper },
    },
    reviewed: { container: { borderColor: palette.passInk }, text: { color: palette.passInk } },
    unreviewed: { container: { borderColor: palette.signalInk }, text: { color: palette.signalInk } },
}

export function Tag({ text, tone }: { readonly text: string; readonly tone: TagTone }): ReactElement {
    const toneStyle = TAG_TONES[tone]
    return (
        <View style={[styles.tag, toneStyle.container]}>
            <Text style={[styles.tagText, toneStyle.text]}>{text}</Text>
        </View>
    )
}

type NoticeTone = 'info' | 'error' | 'caution'

const NOTICE_BAR: Record<NoticeTone, string> = {
    info: palette.charcoal,
    error: palette.signalInk,
    caution: palette.cautionInk,
}

export function Notice({ text, tone = 'info' }: { readonly text: string; readonly tone?: NoticeTone }): ReactElement {
    return (
        <View accessibilityRole="alert" style={[styles.notice, { borderLeftColor: NOTICE_BAR[tone] }]}>
            <Text style={styles.noticeText}>{text}</Text>
        </View>
    )
}

export function SectionTitle({ children }: { readonly children: string }): ReactElement {
    return (
        <Text accessibilityRole="header" style={styles.sectionTitle}>
            {children}
        </Text>
    )
}

const styles = StyleSheet.create({
    button: {
        minHeight: touchTarget,
        minWidth: touchTarget,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderWidth: 1,
        borderRadius: radius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonText: {
        fontSize: 15,
        fontWeight: '600',
    },
    disabled: {
        opacity: 0.4,
    },
    pressed: {
        opacity: 0.75,
    },
    segmented: {
        flexDirection: 'row',
        borderWidth: 1,
        borderColor: palette.charcoal,
        borderRadius: radius,
        overflow: 'hidden',
        alignSelf: 'flex-start',
    },
    segment: {
        minHeight: touchTarget,
        paddingHorizontal: space.md,
        justifyContent: 'center',
        backgroundColor: palette.paperRaised,
    },
    segmentSelected: {
        backgroundColor: palette.charcoal,
    },
    segmentText: {
        color: palette.charcoal,
        fontSize: 14,
        fontWeight: '600',
    },
    segmentTextSelected: {
        color: palette.paperRaised,
    },
    field: {
        gap: space.xs,
    },
    fieldLabel: {
        color: palette.graphite,
        fontSize: 13,
        fontFamily: fonts.mono,
        textTransform: 'uppercase',
    },
    input: {
        minHeight: touchTarget,
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        paddingHorizontal: space.sm,
        fontSize: 16,
        color: palette.charcoal,
        backgroundColor: palette.paperRaised,
    },
    panel: {
        backgroundColor: palette.paperRaised,
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        padding: space.md,
        gap: space.sm,
    },
    tag: {
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderRadius: radius,
        paddingHorizontal: space.xs,
        paddingVertical: 2,
    },
    tagText: {
        fontFamily: fonts.mono,
        fontSize: 12,
        fontWeight: '700',
        textTransform: 'uppercase',
    },
    notice: {
        borderLeftWidth: 4,
        backgroundColor: palette.paperDeep,
        padding: space.sm,
    },
    noticeText: {
        color: palette.charcoal,
        fontSize: 15,
        lineHeight: 21,
    },
    sectionTitle: {
        color: palette.charcoal,
        fontFamily: fonts.display,
        fontSize: 20,
        fontWeight: '700',
    },
})
