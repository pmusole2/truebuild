import type { ReactElement, ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space, touchTarget } from '../theme/tokens'
import { AppButton } from './button'
import { TextField } from './fields'
import { focusRingStyle, useFocusRing } from './focus'
import { Caption } from './text'
import { Stack } from './surface'

export type AskPart = { readonly id: string; readonly label: string }

// `null` targets the whole step rather than one part.
export type AskTarget = string | null

export function AskSheet({
    question,
    onQuestionChange,
    parts,
    target,
    onTargetChange,
    onSubmit,
    busy = false,
    disabledReason,
    answer,
}: {
    readonly question: string
    readonly onQuestionChange: (value: string) => void
    readonly parts: readonly AskPart[]
    readonly target: AskTarget
    readonly onTargetChange: (target: AskTarget) => void
    readonly onSubmit: () => void
    readonly busy?: boolean
    // Why the question cannot be sent yet. It is shown as text, and the submit control is disabled while it applies.
    readonly disabledReason?: string
    readonly answer?: ReactNode
}): ReactElement {
    const submitDisabled = disabledReason !== undefined || question.trim().length === 0
    return (
        <Stack gap="md">
            <TextField
                label="Question about this step"
                value={question}
                onChangeText={onQuestionChange}
                placeholder="Which way should this part face?"
                hint={disabledReason}
                multiline={true}
            />
            <Stack gap="xs">
                <Caption>Ask about</Caption>
                <View accessibilityRole="radiogroup" accessibilityLabel="Ask about" style={styles.chips}>
                    {[
                        { id: null, label: 'Whole step' },
                        ...parts.map((part) => ({ id: part.id, label: part.label })),
                    ].map((option) => (
                        <PartChip
                            key={option.id ?? 'whole'}
                            label={option.label}
                            selected={option.id === target}
                            onPress={(): void => onTargetChange(option.id)}
                        />
                    ))}
                </View>
            </Stack>
            <AppButton
                label="Ask question"
                variant="primary"
                busy={busy}
                disabled={submitDisabled}
                onPress={onSubmit}
                hint={disabledReason}
            />
            {answer}
        </Stack>
    )
}

function PartChip({
    label,
    selected,
    onPress,
}: {
    readonly label: string
    readonly selected: boolean
    readonly onPress: () => void
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Pressable
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ checked: selected }}
            aria-checked={selected}
            {...focus.focusHandlers}
            onPress={onPress}
            style={[
                focusRingStyle(focus.focused, colors),
                styles.chip,
                {
                    borderColor: colors.borderStrong,
                    backgroundColor: selected ? colors.fillStrong : colors.surfaceRaised,
                },
            ]}
        >
            <Caption tone={selected ? 'inverse' : 'default'}>{label}</Caption>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    chip: {
        minHeight: touchTarget,
        paddingHorizontal: space.sm,
        justifyContent: 'center',
        borderWidth: 1,
        borderRadius: radius.pill,
    },
})
