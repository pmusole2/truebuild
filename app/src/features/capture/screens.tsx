import type { ReactElement } from 'react'
import { Linking, Pressable, StyleSheet } from 'react-native'
import { AppButton, IconButton } from '../../ui/button'
import { Card } from '../../ui/surface'
import { Body, Caption, Heading } from '../../ui/text'
import { EmptyState, ErrorState, LoadingState } from '../../ui/states'
import { StatusTag } from '../../ui/status'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import { PRIVACY_COPY } from './privacy-copy'
import type { WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import { Screen, WorkflowNotice } from './screen-chrome'
import type { WorkflowScreenProps } from './workflow-types'

// Public barrel: the extracted modules keep their original import path.
export { GuideScreen, PANEL_MAX_RATIO } from './guide-screen'
export { AnswerPanel, CheckPanel } from './result-panels'
export { ConfirmRow, noticeTone, Screen, WorkflowNotice } from './screen-chrome'
export { PagesScreen, type PagesScreenProps } from './pages-screen'
export { OverviewScreen } from './review-screen'
export { SourceDiagrams, StepFacts } from './step-facts'
export type { WorkflowController, WorkflowScreenProps } from './workflow-types'

export function LibraryScreen({
    state,
    controller,
    onOpenSettings,
}: WorkflowScreenProps & { onOpenSettings?: () => void }): ReactElement {
    const addDisabled = state.loading || state.pending !== null || state.storageReadOnly
    return (
        <Screen
            title="Your manuals"
            testID="library-screen"
            trailing={
                onOpenSettings === undefined ? null : (
                    <IconButton label="Settings" icon="settings" onPress={onOpenSettings} />
                )
            }
        >
            <WorkflowNotice state={state} controller={controller} />
            {state.loading ? (
                <Card>
                    <LoadingState label="Restoring local library…" />
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
            {state.entries.map((entry) => (
                <ManualSummary
                    key={entry.session.manualId}
                    entry={entry}
                    onOpen={(): void => {
                        void controller.open(entry.session.manualId)
                    }}
                />
            ))}
            <AppButton
                label="Add manual"
                variant="accent"
                disabled={addDisabled}
                onPress={(): void => {
                    void controller.createManual()
                }}
            />
        </Screen>
    )
}

function ManualSummary({ entry, onOpen }: { entry: LibraryEntry; onOpen: () => void }): ReactElement {
    const confirmed = entry.session.reviewStatus === 'reviewed'
    const { colors } = useTheme()
    const focus = useFocusRing()
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
                    {`${entry.session.pages.length} pages · ${entry.session.reviewedSteps.length} steps · ${entry.completedStepIds.length} marked complete by you`}
                </Caption>
                <StatusTag
                    label={confirmed ? 'Facts confirmed' : 'Facts not confirmed'}
                    tone={confirmed ? 'pass' : 'caution'}
                    icon={confirmed ? 'check' : 'help'}
                />
            </Pressable>
        </Card>
    )
}

export function SettingsScreen({ state, onBack }: { state: WorkflowState; onBack: () => void }): ReactElement {
    const count = state.entries.length
    return (
        <Screen title="Settings" onBack={onBack} testID="settings-screen">
            <Card>
                <Heading>Your manuals on this device</Heading>
                <Body>
                    {count === 1 ? '1 manual is stored on this device.' : `${count} manuals are stored on this device.`}
                </Body>
                <Caption>Stored locally. Nothing is removed unless you remove it.</Caption>
            </Card>
            <Card>
                <Heading>What leaves this phone</Heading>
                <Body>{PRIVACY_COPY.read}</Body>
                <Body>{PRIVACY_COPY.check}</Body>
                <Body>{PRIVACY_COPY.ask}</Body>
                <Caption>Each request is sent once. Cancelled requests are not repeated automatically.</Caption>
            </Card>
            <Card>
                <Heading>Camera and photos</Heading>
                <Body>{PRIVACY_COPY.camera}</Body>
                <Body>
                    Photos you choose from your library stay on this device until you send them for extraction, a step
                    check or a question.
                </Body>
                <AppButton
                    label="Open device settings"
                    onPress={(): void => {
                        void Linking.openSettings().catch((): void => undefined)
                    }}
                />
            </Card>
            <Caption>Settings describe this build. No preference here changes what is sent.</Caption>
        </Screen>
    )
}

const styles = StyleSheet.create({
    manualPress: {
        gap: space.xs,
        minHeight: touchTarget,
    },
})
