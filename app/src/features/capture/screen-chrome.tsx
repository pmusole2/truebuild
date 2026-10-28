import type { ReactElement, ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { AppButton, IconButton } from '../../ui/button'
import { Card, Screen as ScreenShell, Stack } from '../../ui/surface'
import { Body, Callout, Title } from '../../ui/text'
import { Icon } from '../../ui/icons'
import { Notice, type NoticeTone } from '../../ui/status'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { useTheme } from '../../theme/theme'
import { radius, space, touchTarget } from '../../theme/tokens'
import type { WorkflowScreenProps } from './workflow-types'

// Notices that describe a failure or an unavailable service read as errors; progress and cancellation read as information.
const FAILURE_NOTICE = /unavailable|timed out|could not|not allowed|cannot|not confirmed|nothing was/iu

export function noticeTone(text: string): NoticeTone {
    return FAILURE_NOTICE.test(text) ? 'error' : 'info'
}

/** Shared frame: safe-area shell, our own top bar with an optional back control, and the screen title. */
export function Screen({
    title,
    children,
    onBack,
    trailing,
    testID,
}: {
    title: string
    children: ReactNode
    onBack?: () => void
    trailing?: ReactNode
    testID?: string
}): ReactElement {
    return (
        <ScreenShell header="hidden" testID={testID}>
            <Stack gap="md">
                <View style={styles.topBar}>
                    {onBack === undefined ? null : <IconButton label="Back" icon="chevronLeft" onPress={onBack} />}
                    <View style={styles.titleWrap}>
                        <Title>{title}</Title>
                    </View>
                    {trailing ?? null}
                </View>
                {children}
            </Stack>
        </ScreenShell>
    )
}

export function WorkflowNotice({ state, controller }: WorkflowScreenProps): ReactElement {
    return (
        <View accessibilityLiveRegion="polite">
            <Stack gap="sm">
                {state.notice === null ? null : <Notice tone={noticeTone(state.notice)} text={state.notice} />}
                {state.storageReadOnly ? (
                    <AppButton
                        label={state.loading ? 'Reading local library…' : 'Retry local library'}
                        busy={state.loading}
                        disabled={state.loading || state.pending !== null}
                        onPress={(): void => {
                            void controller.restore()
                        }}
                    />
                ) : null}
                {state.pending === null ? null : (
                    <Card>
                        <Callout>{state.pending}</Callout>
                        <AppButton label="Cancel" variant="quiet" onPress={controller.cancel} />
                    </Card>
                )}
            </Stack>
        </View>
    )
}

/** Explicit checkbox: a 44 point row with a visible mark, a text label and a web focus ring. */
export function ConfirmRow({
    label,
    checked,
    disabled,
    onToggle,
}: {
    label: string
    checked: boolean
    disabled: boolean
    onToggle: () => void
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={label}
            accessibilityState={{ checked, disabled }}
            aria-checked={checked}
            disabled={disabled}
            {...focus.focusHandlers}
            onPress={onToggle}
            style={[
                styles.confirmRow,
                { borderColor: colors.border, backgroundColor: colors.surfaceRaised },
                disabled && styles.disabled,
                focusRingStyle(focus.focused, colors),
            ]}
        >
            <View
                style={[
                    styles.checkBox,
                    { borderColor: colors.borderStrong, backgroundColor: checked ? colors.fillStrong : colors.surface },
                ]}
            >
                {checked ? <Icon name="check" size="sm" color={colors.fillStrongInk} /> : null}
            </View>
            <View style={styles.confirmText}>
                <Body>{label}</Body>
            </View>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    titleWrap: {
        flex: 1,
    },
    confirmRow: {
        minHeight: touchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: space.sm,
    },
    confirmText: {
        flex: 1,
    },
    checkBox: {
        width: 28,
        height: 28,
        borderWidth: 1,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    disabled: {
        opacity: 0.5,
    },
})
