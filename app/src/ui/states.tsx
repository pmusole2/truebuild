import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space } from '../theme/tokens'
import { AppButton } from './button'
import { Body, Heading } from './text'
import { Icon } from './icons'
import { SkeletonCard, SkeletonLines } from './skeleton'
import { Card, Stack } from './surface'

export type StateAction = {
    readonly label: string
    readonly onPress: () => void
}

// Each state is a complete message: a heading, what happened, and at most two actions. Nothing is shown as a result.

/** Announced once as "loading"; the placeholder lines beneath it are hidden from assistive tech. */
export function LoadingState({
    label,
    shape = 'lines',
}: {
    readonly label: string
    // `card` shows a card-shaped silhouette, so a screen that will become a card predicts its own layout.
    readonly shape?: 'lines' | 'card'
}): ReactElement {
    return (
        <Stack gap="sm">
            <View accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={label}>
                <Body>{label}</Body>
            </View>
            {shape === 'card' ? <SkeletonCard /> : <SkeletonLines />}
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
            <StateIcon />
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
        <Card tone="result" bar="refuse">
            <Stack gap="sm">
                <View accessible={true} accessibilityRole="alert" style={styles.alert}>
                    <View style={styles.titleRow}>
                        <Icon name="alert" color={colors.refuse} />
                        <View style={styles.stateTitle}>
                            <Heading>{title}</Heading>
                        </View>
                    </View>
                    <Body>{body}</Body>
                </View>
                {retry === undefined ? null : (
                    <AppButton label={retry.label} icon="refresh" variant="accent" onPress={retry.onPress} />
                )}
            </Stack>
        </Card>
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
            <StateIcon camera />
            <Heading>{title}</Heading>
            <Body tone="muted">{body}</Body>
            <AppButton label={primary.label} variant="accent" onPress={primary.onPress} />
            {secondary === undefined ? null : (
                <AppButton label={secondary.label} variant="quiet" onPress={secondary.onPress} />
            )}
        </Stack>
    )
}

function StateIcon({ camera = false }: { readonly camera?: boolean }): ReactElement {
    const { colors } = useTheme()
    return (
        <View style={[styles.stateIcon, { backgroundColor: colors.surfaceSunken }]}>
            <Icon name={camera ? 'camera' : 'image'} color={colors.inkMuted} />
        </View>
    )
}

const styles = StyleSheet.create({
    alert: {
        gap: space.sm,
    },
    stateTitle: { flex: 1, minWidth: 0 },
    stateIcon: { alignSelf: 'flex-start', padding: space.sm, borderRadius: radius.lg },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
    },
})
