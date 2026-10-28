import { useState, type ReactElement } from 'react'
import { Image, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import type { ManualBinding, ManualSession, ManualStep } from '@truebuild/contracts'
import { AppButton, IconButton } from '../../ui/button'
import { Card, Stack } from '../../ui/surface'
import { Body, Callout, Caption, Heading } from '../../ui/text'
import { EmptyState, ErrorState, LoadingState } from '../../ui/states'
import { Notice, StatusTag } from '../../ui/status'
import { SegmentedControl, TextField } from '../../ui/fields'
import { Skeleton } from '../../ui/skeleton'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { useTheme } from '../../theme/theme'
import { radius, space, touchTarget } from '../../theme/tokens'
import { PRIVACY_COPY } from './privacy-copy'
import { reviewedSession, unresolvedCriticalFacts, type WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import { ConfirmRow, Screen, WorkflowNotice } from './screen-chrome'
import { factText, ModelProvenance, SourceDiagrams, StepFacts } from './step-facts'
import type { WorkflowController, WorkflowScreenProps } from './workflow-types'

// Public barrel: the extracted modules keep their original import path.
export { GuideScreen, PANEL_MAX_RATIO } from './guide-screen'
export { AnswerPanel, CheckPanel } from './result-panels'
export { ConfirmRow, noticeTone, Screen, WorkflowNotice } from './screen-chrome'
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

export type PagesScreenProps = WorkflowScreenProps & {
    entry: LibraryEntry
    choosePages: (replaceIndex?: number) => void
}

export function PagesScreen({ state, controller, entry, choosePages }: PagesScreenProps): ReactElement {
    const [title, setTitle] = useState(entry.session.title)
    const busy = state.pending !== null || state.storageReadOnly
    const full = entry.session.pages.length >= 20
    return (
        <Screen title="Manual pages" onBack={controller.home} testID="pages-screen">
            <WorkflowNotice state={state} controller={controller} />
            <TextField
                label="Manual title"
                value={title}
                maxLength={200}
                onChangeText={setTitle}
                onEndEditing={(): void => {
                    void controller.rename(title)
                }}
                editable={!state.storageReadOnly}
            />
            <Caption>{PRIVACY_COPY.stayOnDevice}</Caption>
            <Caption>{PRIVACY_COPY.read}</Caption>
            <Caption>Up to 20 pages. Phone photos are resized and compressed locally before upload.</Caption>
            {entry.session.pages.length === 0 ? (
                <Card>
                    <Body tone="muted">No pages yet. Scan a page or choose pages from photos.</Body>
                </Card>
            ) : null}
            {entry.session.pages.map((page, index) => (
                <Card key={page.pageId}>
                    <Heading>{`Page ${index + 1}`}</Heading>
                    <PageImage
                        uri={state.pageUris[page.pageId]}
                        label={`Manual page ${index + 1}`}
                        aspectRatio={page.width / page.height}
                    />
                    <View style={styles.actionRow}>
                        <AppButton
                            label="Up"
                            accessibilityLabel={`Move page ${index + 1} up`}
                            variant="quiet"
                            disabled={busy || index === 0}
                            onPress={(): void => {
                                void controller.editPage(index, 'up')
                            }}
                        />
                        <AppButton
                            label="Down"
                            accessibilityLabel={`Move page ${index + 1} down`}
                            variant="quiet"
                            disabled={busy || index === entry.session.pages.length - 1}
                            onPress={(): void => {
                                void controller.editPage(index, 'down')
                            }}
                        />
                        <AppButton
                            label="Retake"
                            accessibilityLabel={`Retake page ${index + 1}`}
                            variant="quiet"
                            disabled={busy}
                            onPress={(): void => controller.camera({ kind: 'page', replaceIndex: index })}
                        />
                        <AppButton
                            label="Replace"
                            accessibilityLabel={`Replace page ${index + 1} from photos`}
                            variant="quiet"
                            disabled={busy}
                            onPress={(): void => choosePages(index)}
                        />
                        <AppButton
                            label="Remove"
                            accessibilityLabel={`Remove page ${index + 1}`}
                            variant="danger"
                            disabled={busy}
                            onPress={(): void => {
                                void controller.editPage(index, 'remove')
                            }}
                        />
                    </View>
                </Card>
            ))}
            <AppButton
                label="Scan a page"
                variant="accent"
                disabled={busy || full}
                onPress={(): void => controller.camera({ kind: 'page' })}
            />
            <AppButton label="Choose pages from photos" disabled={busy || full} onPress={(): void => choosePages()} />
            <AppButton
                label={entry.session.rawExtraction === null ? 'Read manual' : 'Read manual again'}
                variant="primary"
                busy={state.pending !== null && state.pending.startsWith('Reading')}
                disabled={busy || entry.session.pages.length === 0}
                onPress={(): void => {
                    void controller.parse()
                }}
            />
            {entry.session.rawExtraction === null ? null : (
                <AppButton
                    label="Review extracted facts"
                    disabled={busy}
                    onPress={(): void => controller.navigate('overview')}
                />
            )}
        </Screen>
    )
}

function PageImage({
    uri,
    label,
    aspectRatio,
}: {
    uri: string | undefined
    label: string
    aspectRatio: number
}): ReactElement {
    if (uri === undefined) {
        return (
            <Stack gap="xs">
                <Skeleton height={160} />
                <Caption>Loading local page…</Caption>
            </Stack>
        )
    }
    return (
        <View style={[styles.pageFrame, { aspectRatio }]}>
            <Image source={{ uri }} accessibilityLabel={label} resizeMode="stretch" style={StyleSheet.absoluteFill} />
        </View>
    )
}

export function OverviewScreen({
    state,
    controller,
    entry,
}: WorkflowScreenProps & { entry: LibraryEntry }): ReactElement {
    const { session } = entry
    // The whole-manual tick belongs to one revision; any change to the facts makes the user tick it again.
    const [confirmation, setConfirmation] = useState({ revision: session.revision, checked: false })
    const confirmed = confirmation.revision === session.revision && confirmation.checked
    const canConfirm = reviewedSession(session) !== null
    const unresolved = unresolvedCriticalFacts(session)
    const reviewed = session.reviewStatus === 'reviewed'
    return (
        <Screen title={session.title} onBack={controller.home} testID="overview-screen">
            <WorkflowNotice state={state} controller={controller} />
            <Caption>
                Review extracted facts against your original diagrams. Unknown critical facts block verified checks.
            </Caption>
            {session.rawExtraction === null ? null : <ModelProvenance result={session.rawExtraction} />}
            <View style={styles.pageStrip}>
                {session.pages.map((page, index) => (
                    <View key={page.pageId} style={styles.stripItem}>
                        <PageImage
                            uri={state.pageUris[page.pageId]}
                            label={`Manual page ${index + 1}`}
                            aspectRatio={page.width / page.height}
                        />
                    </View>
                ))}
            </View>
            {session.parts.length === 0 ? null : (
                <Card>
                    <Heading>Parts</Heading>
                    {session.parts.map((part) => (
                        <Body key={part.partId}>{`Part ${part.partId}: ${factText(part.name, String)}`}</Body>
                    ))}
                </Card>
            )}
            {unresolved.map((issue) => (
                <Notice key={issue} tone="error" text={`Unresolved critical fact: ${issue}`} />
            ))}
            {session.rawExtraction?.unknowns.map((unknown, index) => (
                <Notice key={index} text={`Extraction note: ${unknown}`} />
            ))}
            {session.reviewedSteps.map((step, index) => (
                <Card key={step.stepId}>
                    <StepFacts session={session} index={index} />
                    <SourceDiagrams refs={step.sourceRefs} session={session} pageUris={state.pageUris} />
                    {needsStepFacts(step) ? (
                        <StepFactEditor
                            key={`${session.manualId}:${session.revision}:${step.stepId}`}
                            state={state}
                            controller={controller}
                            session={session}
                            step={step}
                        />
                    ) : null}
                    {reviewed ? (
                        <AppButton
                            label={`Guide step ${step.order}`}
                            onPress={(): void => {
                                void controller.step(index)
                            }}
                        />
                    ) : null}
                </Card>
            ))}
            {reviewed ? (
                <Card>
                    <StatusTag label="Facts confirmed by you" tone="pass" icon="check" />
                    <Callout>Facts confirmed by you.</Callout>
                    <AppButton
                        label="Continue assembly"
                        variant="accent"
                        onPress={(): void => controller.navigate('guide')}
                    />
                </Card>
            ) : (
                <Card>
                    <ConfirmRow
                        label="I checked all facts and corrections against the manual"
                        checked={confirmed}
                        disabled={!canConfirm}
                        onToggle={(): void => setConfirmation({ revision: session.revision, checked: !confirmed })}
                    />
                    {canConfirm ? null : (
                        <Caption>
                            Add or retake clearer pages showing the unresolved facts, then read the manual again. No
                            unknown facts will be filled in automatically.
                        </Caption>
                    )}
                    <AppButton
                        label="Confirm reviewed facts"
                        variant="primary"
                        disabled={!confirmed || !canConfirm || state.pending !== null || state.storageReadOnly}
                        onPress={(): void => {
                            void controller.confirm()
                        }}
                    />
                </Card>
            )}
            <AppButton
                label="Edit manual pages"
                disabled={state.pending !== null}
                onPress={(): void => controller.navigate('pages')}
            />
        </Screen>
    )
}

/** A step needs facts from the manual when its orientation is unknown or it lists no visible check. */
function needsStepFacts(step: ManualStep): boolean {
    return step.orientation.state === 'unknown' || step.visibleChecks.length === 0
}

function partLabel(session: ManualSession, partId: string): string {
    const registry = session.parts.find((part) => part.partId === partId)
    return registry !== undefined && registry.name.state === 'known' ? `${registry.name.value} (${partId})` : partId
}

/**
 * Facts the manual did not give us. Typing and part choice are local drafts; only an explicit accept asks the controller
 * to write, and the controller checks the candidate against this step's own citations. Cancel discards unaccepted text.
 */
function StepFactEditor({
    state,
    controller,
    session,
    step,
}: {
    state: WorkflowState
    controller: WorkflowController
    session: ManualSession
    step: ManualStep
}): ReactElement {
    const binding: ManualBinding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
    const busy = state.pending !== null || state.storageReadOnly
    const cited = step.sourceRefs.length > 0
    const parts = step.parts.map((part) => ({ value: part.partId, label: partLabel(session, part.partId) }))
    // A sole part is chosen for the draft only; with several parts the person must pick one.
    const [partId, setPartId] = useState<string | null>(parts.length === 1 ? parts[0]!.value : null)
    const [cue, setCue] = useState('')
    const [checks, setChecks] = useState('')
    const [cueError, setCueError] = useState<string | undefined>(undefined)
    const [checksError, setChecksError] = useState<string | undefined>(undefined)

    const acceptOrientation = async (): Promise<void> => {
        const description = cue.trim()
        if (description.length === 0) {
            setCueError('Describe the visible cue, or leave orientation unknown.')
            return
        }
        if (partId === null) {
            setCueError('Choose the part this cue applies to.')
            return
        }
        setCueError(undefined)
        await controller.acceptStepFacts(binding, step.stepId, { orientation: { partId, description } })
    }
    const acceptChecks = async (): Promise<void> => {
        const visibleChecks = checks
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        if (visibleChecks.length === 0) {
            setChecksError('Enter at least one visible check, one condition per line.')
            return
        }
        setChecksError(undefined)
        await controller.acceptStepFacts(binding, step.stepId, { visibleChecks })
    }
    const cancelOrientation = (): void => {
        setCue('')
        setCueError(undefined)
    }
    const cancelChecks = (): void => {
        setChecks('')
        setChecksError(undefined)
    }

    return (
        <Stack gap="sm">
            <Caption>
                Only accept what the cited manual supports. Anything it does not show stays unknown. Typing here changes
                no facts until you accept.
            </Caption>
            {cited ? null : (
                <Notice
                    tone="error"
                    text="This step has no cited manual page, so facts cannot be accepted here. Read the manual again after adding clearer pages."
                />
            )}
            {step.orientation.state === 'unknown' ? (
                <Stack gap="xs">
                    {parts.length > 1 ? (
                        <View pointerEvents={busy ? 'none' : 'auto'}>
                            <ScrollView horizontal accessibilityLabel="Scroll orientation parts">
                                <SegmentedControl
                                    label="Part for the orientation cue"
                                    options={parts}
                                    value={partId ?? ''}
                                    onChange={(value): void => setPartId(value)}
                                />
                            </ScrollView>
                        </View>
                    ) : parts.length === 1 ? (
                        <Caption>{`Part: ${parts[0]!.label}`}</Caption>
                    ) : (
                        <Notice
                            tone="error"
                            text="This step lists no parts, so an orientation cue cannot be tied to one."
                        />
                    )}
                    <TextField
                        label="Orientation cue"
                        value={cue}
                        onChangeText={setCue}
                        placeholder="What the manual shows, e.g. the groove faces inward"
                        error={cueError}
                        editable={!busy}
                    />
                    <View style={styles.actionRow}>
                        <AppButton
                            label="Accept orientation"
                            disabled={busy || !cited || parts.length === 0}
                            onPress={(): void => {
                                void acceptOrientation()
                            }}
                        />
                        <AppButton
                            label="Cancel orientation draft"
                            variant="quiet"
                            disabled={busy}
                            onPress={cancelOrientation}
                        />
                    </View>
                </Stack>
            ) : null}
            {step.visibleChecks.length === 0 ? (
                <Stack gap="xs">
                    <Caption>No visible checks are listed for this step. Enter one condition per line.</Caption>
                    <TextField
                        label="Visible checks, one per line"
                        value={checks}
                        onChangeText={setChecks}
                        multiline
                        placeholder="One condition per line"
                        error={checksError}
                        editable={!busy}
                    />
                    <View style={styles.actionRow}>
                        <AppButton
                            label="Accept visible checks"
                            disabled={busy || !cited}
                            onPress={(): void => {
                                void acceptChecks()
                            }}
                        />
                        <AppButton label="Cancel checks draft" variant="quiet" disabled={busy} onPress={cancelChecks} />
                    </View>
                </Stack>
            ) : null}
        </Stack>
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
    actionRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    pageFrame: {
        width: '100%',
        borderRadius: radius.md,
        overflow: 'hidden',
    },
    pageStrip: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    stripItem: {
        width: 96,
    },
    manualPress: {
        gap: space.xs,
        minHeight: touchTarget,
    },
})
