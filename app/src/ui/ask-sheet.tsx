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

/**
 * Composer for one question about a frozen photo. A target is either a step part chosen here or a point tapped in the
 * photo (summarised by the caller). Sending needs a target and non-empty text; the caller owns the request.
 */
export function AskSheet({
    question,
    questionLabel,
    onQuestionChange,
    parts,
    selectedPartId,
    onSelectPart,
    targetSummary,
    hasTarget,
    editable = true,
    onSubmit,
    busy = false,
    disabledReason,
    answer,
}: {
    readonly question: string
    readonly questionLabel: string
    readonly onQuestionChange: (value: string) => void
    readonly parts: readonly AskPart[]
    readonly selectedPartId: string | null
    readonly onSelectPart: (partId: string) => void
    readonly targetSummary: string
    // True once the user has chosen a part or tapped a point. Text alone is never enough to send.
    readonly hasTarget: boolean
    readonly editable?: boolean
    readonly onSubmit: () => void
    readonly busy?: boolean
    readonly disabledReason?: string
    readonly answer?: ReactNode
}): ReactElement {
    const submitDisabled = busy || !hasTarget || question.trim().length === 0 || disabledReason !== undefined
    return (
        <Stack gap="md">
            <Caption>
                Type a question, or use your keyboard’s dictation. Questions are sent only when you press Send.
            </Caption>
            <TextField
                label={questionLabel}
                value={question}
                onChangeText={onQuestionChange}
                placeholder="Which way should this part face?"
                hint={disabledReason}
                multiline={true}
                editable={editable}
            />
            {parts.length === 0 ? null : (
                <Stack gap="xs">
                    <Caption>Ask about a part</Caption>
                    <View accessibilityRole="radiogroup" accessibilityLabel="Ask about a part" style={styles.chips}>
                        {parts.map((part) => (
                            <PartChip
                                key={part.id}
                                label={part.label}
                                selected={part.id === selectedPartId}
                                onPress={(): void => onSelectPart(part.id)}
                            />
                        ))}
                    </View>
                </Stack>
            )}
            <Caption>{targetSummary}</Caption>
            <AppButton
                label="Send question"
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
                styles.chip,
                {
                    borderColor: colors.borderStrong,
                    backgroundColor: selected ? colors.fillStrong : colors.surfaceRaised,
                },
                focusRingStyle(focus.focused, colors),
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
