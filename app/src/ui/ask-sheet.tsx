import type { ReactElement, ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space, touchTarget } from '../theme/tokens'
import { AppButton } from './button'
import { TextField } from './fields'
import { focusRingStyle, useFocusRing } from './focus'
import { Caption } from './text'
import { Stack } from './surface'
import { originId, parseOrigin } from './render-origin'

export type AskPart = { readonly id: string; readonly label: string }

// Same cap the capture controller enforces on question text.
export const QUESTION_MAX_LENGTH = 500

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
    stillThinking = false,
    disabledReason,
    answer,
    submitLabel = 'Send question',
    nativeID,
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
    /** A real pending ticket was received. This deterministic status remains visible inside the open composer. */
    readonly stillThinking?: boolean
    readonly disabledReason?: string
    readonly answer?: ReactNode
    // Keep the visible and accessible action names identical for voice control.
    readonly submitLabel?: string
    // Render-origin marker for the root when a composed screen placed this composer.
    readonly nativeID?: string
}): ReactElement {
    const submitDisabled =
        !editable || busy || !hasTarget || question.trim().length === 0 || disabledReason !== undefined
    const submitInstruction = submitLabel === 'Send question' ? 'Send' : submitLabel
    return (
        <Stack gap="md" nativeID={nativeID}>
            <Caption>
                Type a question, or use your keyboard’s dictation. Questions are sent only when you press{' '}
                {submitInstruction}.
            </Caption>
            <TextField
                label={questionLabel}
                value={question}
                onChangeText={onQuestionChange}
                placeholder="Which way should this part face?"
                hint={disabledReason}
                multiline={true}
                editable={editable}
                maxLength={QUESTION_MAX_LENGTH}
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
                                disabled={!editable}
                                onPress={(): void => onSelectPart(part.id)}
                            />
                        ))}
                    </View>
                </Stack>
            )}
            <Caption>{targetSummary}</Caption>
            {busy && stillThinking ? (
                <View
                    nativeID={originId(parseOrigin(nativeID) ?? 'shell')}
                    accessible
                    accessibilityLabel="Still thinking…"
                    accessibilityLiveRegion="polite"
                >
                    <Caption>Still thinking…</Caption>
                </View>
            ) : null}
            <AppButton
                label={submitLabel}
                accessibilityLabel={submitLabel}
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
            accessibilityState={{ checked: selected, disabled }}
            aria-checked={selected}
            disabled={disabled}
            {...focus.focusHandlers}
            onPress={onPress}
            style={[
                styles.chip,
                disabled && styles.disabled,
                {
                    borderColor: colors.borderStrong,
                    backgroundColor: selected ? colors.accent : colors.surfaceRaised,
                },
                focusRingStyle(focus.focused, colors),
            ]}
        >
            <Caption tone={selected ? 'onAccent' : 'default'}>{label}</Caption>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    disabled: {
        opacity: 0.5,
    },
    chip: {
        minHeight: touchTarget,
        maxWidth: '100%',
        paddingHorizontal: space.sm,
        justifyContent: 'center',
        borderWidth: 1,
        borderRadius: radius.pill,
    },
})
