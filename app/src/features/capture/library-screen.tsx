import type { ReactElement } from 'react'
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { AppButton, IconButton } from '../../ui/button'
import { ProgressBar, StepList, type StepListItem } from '../../ui/progress'
import { ActionDock, Card, Screen as ScreenShell, Stack } from '../../ui/surface'
import { Caption, Heading, Title } from '../../ui/text'
import { EmptyState, ErrorState, LoadingState } from '../../ui/states'
import { StatusTag } from '../../ui/status'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import type { LibraryEntry } from './library'
import { WorkflowNotice } from './screen-chrome'
import type { WorkflowScreenProps } from './workflow-types'

// A non-binding outline of the flow; every item is "not started" because nothing has been added yet.
const FIRST_RUN_STAGES: readonly StepListItem[] = [
    { id: 'photograph', title: 'Photograph your manual pages', state: 'upcoming' },
    { id: 'confirm', title: 'Confirm the facts read from them', state: 'upcoming' },
    { id: 'assemble', title: 'Follow guided assembly and check steps', state: 'upcoming' },
]

/** Why Add manual is unavailable, so a disabled primary action is never unexplained. */
function addHint(state: WorkflowScreenProps['state']): string | null {
    if (state.loading) {
        return 'Available once your library has loaded.'
    }
    if (state.storageReadOnly) {
        return 'Adding is paused until the saved library is restored.'
    }
    if (state.pending !== null) {
        return 'Available when the current request finishes.'
    }
    return null
}

export function LibraryScreen({
    state,
    controller,
    onOpenSettings,
}: WorkflowScreenProps & { onOpenSettings?: () => void }): ReactElement {
    const { height, fontScale } = useWindowDimensions()
    // Same rule as the guide: on a short screen or with large text the primary action joins the one scroll.
    const compact = height < 650 || fontScale >= 1.5
    const addDisabled = state.loading || state.pending !== null || state.storageReadOnly
    const hint = addHint(state)
    const firstRun = !state.loading && !state.storageReadOnly && state.entries.length === 0
    const header = (
        <View style={styles.topBar}>
            <View style={styles.titleWrap}>
                <Title>Your manuals</Title>
            </View>
            {onOpenSettings === undefined ? null : (
                <IconButton label="Settings" icon="settings" onPress={onOpenSettings} />
            )}
        </View>
    )
    const body = (
        <>
            <WorkflowNotice state={state} controller={controller} />
            {state.loading ? (
                <Card>
                    <LoadingState label="Restoring local library…" />
                    <Caption>Your saved manuals stay on this device and are not changed while this loads.</Caption>
                </Card>
            ) : state.entries.length === 0 ? (
                state.storageReadOnly ? (
                    <ErrorState
                        title="Saved library unavailable"
                        body="Original local data is retained. Retry the local library above before making changes."
                    />
                ) : (
                    <EmptyState title="No manuals yet." body="Scan or choose your own manual pages to start." />
                )
            ) : null}
            {firstRun ? (
                <Card>
                    <Heading>How it works</Heading>
                    <StepList steps={FIRST_RUN_STAGES} />
                    <Caption>Follow one step at a time, with your manual&apos;s own pages beside you.</Caption>
                </Card>
            ) : null}
            {state.entries.map((entry) => (
                <ManualSummary
                    key={entry.session.manualId}
                    entry={entry}
                    onOpen={(): void => {
                        void controller.open(entry.session.manualId)
                    }}
                />
            ))}
        </>
    )
    const add = (
        <>
            <AppButton
                label="Add manual"
                variant="accent"
                icon="plus"
                disabled={addDisabled}
                onPress={(): void => {
                    void controller.createManual()
                }}
            />
            {hint === null ? null : <Caption>{hint}</Caption>}
        </>
    )
    return (
        <ScreenShell header="hidden" scroll={false} padded={false} testID="library-screen">
            {compact ? (
                <ScrollView
                    testID="library-scroll"
                    contentContainerStyle={styles.content}
                    keyboardShouldPersistTaps="handled"
                >
                    {header}
                    {body}
                    <Stack gap="xs">{add}</Stack>
                </ScrollView>
            ) : (
                <>
                    <View style={styles.fixedHeader}>{header}</View>
                    <ScrollView
                        testID="library-scroll"
                        contentContainerStyle={styles.content}
                        keyboardShouldPersistTaps="handled"
                    >
                        {body}
                    </ScrollView>
                    <ActionDock>{add}</ActionDock>
                </>
            )}
        </ScreenShell>
    )
}

function ManualSummary({ entry, onOpen }: { entry: LibraryEntry; onOpen: () => void }): ReactElement {
    const confirmed = entry.session.reviewStatus === 'reviewed'
    const { colors } = useTheme()
    const focus = useFocusRing()
    const steps = entry.session.reviewedSteps.length
    const pages = entry.session.pages.length
    const completed = entry.completedStepIds.length
    return (
        <Card>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.session.title}`}
                {...focus.focusHandlers}
                onPress={onOpen}
                style={[styles.manualPress, focusRingStyle(focus.focused, colors)]}
            >
                <Heading>{entry.session.title}</Heading>
                <Caption>
                    {`${pages} ${pages === 1 ? 'page' : 'pages'} · ${steps} ${steps === 1 ? 'step' : 'steps'} · ${completed} marked complete by you`}
                </Caption>
                {steps === 0 ? null : (
                    <ProgressBar
                        label={`Steps you marked complete: ${completed} of ${steps}`}
                        value={completed}
                        total={steps}
                    />
                )}
                <StatusTag
                    label={confirmed ? 'Facts confirmed' : 'Facts not confirmed'}
                    tone={confirmed ? 'pass' : 'caution'}
                    icon={confirmed ? 'check' : 'help'}
                />
            </Pressable>
        </Card>
    )
}

const styles = StyleSheet.create({
    topBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    titleWrap: { flex: 1 },
    fixedHeader: { paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm },
    content: { padding: space.md, gap: space.md },
    manualPress: { gap: space.xs, minHeight: touchTarget },
})
