import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { space } from '../theme/tokens'
import { AppButton } from './button'
import { Body, Heading } from './text'
import { Icon } from './icons'
import { SkeletonLines } from './skeleton'
import { Stack } from './surface'

export type StateAction = {
    readonly label: string
    readonly onPress: () => void
}

// Each state is a complete message: a heading, what happened, and at most two actions. Nothing is shown as a result.

/** Announced once as "loading"; the placeholder lines beneath it are hidden from assistive tech. */
export function LoadingState({ label }: { readonly label: string }): ReactElement {
    return (
        <Stack gap="sm">
            <View accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={label}>
                <Body>{label}</Body>
            </View>
            <SkeletonLines />
        </Stack>
    )
}

export function EmptyState({
    title,
    body,
    action,
}: {
    readonly title: string
    readonly body: string
    readonly action?: StateAction
}): ReactElement {
    return (
        <Stack gap="sm">
            <Heading>{title}</Heading>
            <Body tone="muted">{body}</Body>
            {action === undefined ? null : (
                <AppButton label={action.label} variant="secondary" onPress={action.onPress} />
            )}
        </Stack>
    )
}

export function ErrorState({
    title,
    body,
    retry,
}: {
    readonly title: string
    readonly body: string
    readonly retry?: StateAction
}): ReactElement {
    const { colors } = useTheme()
    // The message is one accessible group so it is announced as an alert; the retry stays a separate, focusable control.
    return (
        <Stack gap="sm">
            <View accessible={true} accessibilityRole="alert" style={styles.alert}>
                <View style={styles.titleRow}>
                    <Icon name="alert" color={colors.refuse} />
                    <Heading tone="refuse">{title}</Heading>
                </View>
                <Body>{body}</Body>
            </View>
            {retry === undefined ? null : <AppButton label={retry.label} variant="danger" onPress={retry.onPress} />}
        </Stack>
    )
}

export function PermissionState({
    title,
    body,
    primary,
    secondary,
}: {
    readonly title: string
    readonly body: string
    readonly primary: StateAction
    readonly secondary?: StateAction
}): ReactElement {
    return (
        <Stack gap="sm">
            <Icon name="camera" />
            <Heading>{title}</Heading>
            <Body tone="muted">{body}</Body>
            <AppButton label={primary.label} variant="accent" onPress={primary.onPress} />
            {secondary === undefined ? null : (
                <AppButton label={secondary.label} variant="quiet" onPress={secondary.onPress} />
            )}
        </Stack>
    )
}

const styles = StyleSheet.create({
    alert: {
        gap: space.sm,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
    },
})
