import { useState, type ReactElement } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { stepEvidenceRequirements, type ManualBinding, type ManualSession, type ManualStep } from '@truebuild/contracts'
import { AppButton } from '../../ui/button'
import { Card, Stack } from '../../ui/surface'
import { Body, Callout, Caption, Heading } from '../../ui/text'
import { Notice, StatusTag, type StatusTone } from '../../ui/status'
import { Icon, type IconName } from '../../ui/icons'
import { SegmentedControl, TextField } from '../../ui/fields'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import { reviewedSession, unresolvedCriticalFacts, type WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import { PageImage } from './page-media'
import { ConfirmRow, Screen, WorkflowNotice } from './screen-chrome'
import { factText, ModelProvenance, SourceDiagrams, StepFacts } from './step-facts'
import type { WorkflowController, WorkflowScreenProps } from './workflow-types'

type Chip = { label: string; tone: StatusTone; icon: IconName }

export function OverviewScreen({
    state,
    controller,
    entry,
}: WorkflowScreenProps & { entry: LibraryEntry }): ReactElement {
    const { session } = entry
    // The whole-manual tick belongs to one revision; any change to the facts makes the user tick it again.
    const [confirmation, setConfirmation] = useState({ revision: session.revision, checked: false })
    const confirmed = confirmation.revision === session.revision && confirmation.checked
    // Cards the person opened or closed by hand. A new revision restarts from the defaults, like the confirmation.
    const [toggled, setToggled] = useState<{ revision: number; open: Readonly<Record<string, boolean>> }>({
        revision: session.revision,
        open: {},
    })
    const manualToggles = toggled.revision === session.revision ? toggled.open : {}
    const canConfirm = reviewedSession(session) !== null
    const unresolved = unresolvedCriticalFacts(session)
    const reviewed = session.reviewStatus === 'reviewed'
    const notes = session.rawExtraction?.unknowns ?? []
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
            {unresolved.length === 0 ? null : <BlockerGroup issues={unresolved} />}
            {notes.length === 0 ? null : (
                <Card>
                    <Heading>Notes from reading</Heading>
                    {notes.map((unknown, index) => (
                        <Body key={index}>{`Extraction note: ${unknown}`}</Body>
                    ))}
                </Card>
            )}
            {session.reviewedSteps.map((step, index) => {
                const blockers = stepBlockerCount(session, step)
                const locked = needsStepFacts(step)
                const open = locked || (manualToggles[step.stepId] ?? blockers > 0)
                return (
                    <StepCard
                        key={step.stepId}
                        state={state}
                        controller={controller}
                        session={session}
                        step={step}
                        index={index}
                        blockers={blockers}
                        open={open}
                        locked={locked}
                        reviewed={reviewed}
                        onToggle={(): void =>
                            setToggled({
                                revision: session.revision,
                                open: { ...manualToggles, [step.stepId]: !open },
                            })
                        }
                    />
                )
            })}
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
                variant="quiet"
                disabled={state.pending !== null}
                onPress={(): void => controller.navigate('pages')}
            />
        </Screen>
    )
}

/** One calm block for every unresolved critical fact; each reason is stated once here and in its step's open details. */
function BlockerGroup({ issues }: { issues: readonly string[] }): ReactElement {
    const { colors } = useTheme()
    return (
        <Card>
            <View style={styles.blockerHeader}>
                <Icon name="alert" size="sm" color={colors.refuse} />
                <View style={styles.flex}>
                    <Heading>{issues.length === 1 ? '1 fact needs you' : `${issues.length} facts need you`}</Heading>
                </View>
            </View>
            <Caption>
                The manual did not make these clear. Open the step below and add only what the cited page shows.
                Confirmation stays off until they are resolved.
            </Caption>
            {issues.map((issue) => (
                <Body key={issue}>{`Unresolved critical fact: ${issue}`}</Body>
            ))}
        </Card>
    )
}

/** Same facts the confirm gate uses, limited to one step so its card can say whether it still needs the person. */
function stepBlockerCount(session: ManualSession, step: ManualStep): number {
    const requiredIds = new Set(step.parts.map((part) => part.partId))
    return unresolvedCriticalFacts({
        parts: session.parts.filter((part) => requiredIds.has(part.partId)),
        reviewedSteps: [step],
    }).length
}

/** A step needs facts from the manual when its orientation is unknown or it lists no visible check. */
function needsStepFacts(step: ManualStep): boolean {
    const required = stepEvidenceRequirements(step)
    return (
        (required.orientation && step.orientation.state === 'unknown') ||
        (required.visibleChecks && step.visibleChecks.length === 0)
    )
}

function stepChips(session: ManualSession, step: ManualStep, blockers: number): Chip[] {
    const chips: Chip[] =
        blockers > 0
            ? [{ label: 'Needs your input', tone: 'caution', icon: 'help' }]
            : [{ label: 'Facts readable', tone: 'neutral', icon: 'info' }]
    const required = stepEvidenceRequirements(step)
    if (required.orientation || step.orientation.state === 'known') {
        chips.push(
            step.orientation.state === 'known'
                ? { label: 'Orientation known', tone: 'neutral', icon: 'check' }
                : { label: 'Orientation unknown', tone: 'caution', icon: 'help' },
        )
    }
    if (required.visibleChecks || step.visibleChecks.length > 0) {
        chips.push(
            step.visibleChecks.length === 0
                ? { label: 'No visible checks', tone: 'caution', icon: 'help' }
                : {
                      label: `${step.visibleChecks.length} visible check${step.visibleChecks.length === 1 ? '' : 's'}`,
                      tone: 'neutral',
                      icon: 'check',
                  },
        )
    }
    const pageNumbers = [
        ...new Set(
            step.sourceRefs
                .map((ref) => session.pages.findIndex((page) => page.pageId === ref.pageId) + 1)
                .filter((number) => number > 0),
        ),
    ]
    chips.push(
        pageNumbers.length === 0
            ? { label: 'No cited page', tone: 'caution', icon: 'help' }
            : { label: `Cited page ${pageNumbers.join(', ')}`, tone: 'neutral', icon: 'image' },
    )
    if (step.correction !== null) {
        chips.push({ label: 'Includes correction', tone: 'neutral', icon: 'info' })
    }
    return chips
}

function partSummary(session: ManualSession, step: ManualStep): string {
    if (step.parts.length === 0) {
        return 'No parts listed.'
    }
    const names = step.parts.map((part) => {
        const registry = session.parts.find((candidate) => candidate.partId === part.partId)
        return registry !== undefined && registry.name.state === 'known' ? registry.name.value : part.partId
    })
    return `Parts: ${names.join(', ')}`
}

/**
 * A scannable step: order, title, status chips and a one line summary. Full facts, cited diagrams and the fact editors
 * open beneath it. A step that still needs facts stays open so the editors are always reachable and drafts survive.
 */
function StepCard({
    state,
    controller,
    session,
    step,
    index,
    blockers,
    open,
    locked,
    reviewed,
    onToggle,
}: {
    state: WorkflowState
    controller: WorkflowController
    session: ManualSession
    step: ManualStep
    index: number
    blockers: number
    open: boolean
    locked: boolean
    reviewed: boolean
    onToggle: () => void
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    const heading = (
        <View style={styles.cardTop}>
            <View style={styles.flex}>
                <Heading>{`${step.order}. ${step.title}`}</Heading>
            </View>
            {locked ? null : (
                <View style={open ? styles.chevronOpen : undefined}>
                    <Icon name="chevronRight" color={colors.inkMuted} />
                </View>
            )}
        </View>
    )
    return (
        <Card>
            {locked ? (
                heading
            ) : (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Step ${step.order} details`}
                    accessibilityState={{ expanded: open }}
                    {...focus.focusHandlers}
                    onPress={onToggle}
                    style={[styles.headerPress, focusRingStyle(focus.focused, colors)]}
                >
                    {heading}
                </Pressable>
            )}
            <View style={styles.chips}>
                {stepChips(session, step, blockers).map((chip, chipIndex) =>
                    chipIndex === 0 ? (
                        <StatusTag key={chip.label} label={chip.label} tone={chip.tone} icon={chip.icon} />
                    ) : (
                        <Caption key={chip.label}>{chip.label}</Caption>
                    ),
                )}
            </View>
            <Caption>{partSummary(session, step)}</Caption>
            {open ? (
                <Stack gap="sm">
                    <StepFacts session={session} index={index} showHeading={false} />
                    <SourceDiagrams refs={step.sourceRefs} session={session} pageUris={state.pageUris} />
                    {locked ? (
                        <StepFactEditor
                            key={`${session.manualId}:${session.revision}:${step.stepId}`}
                            state={state}
                            controller={controller}
                            session={session}
                            step={step}
                        />
                    ) : null}
                </Stack>
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
    )
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
    const required = stepEvidenceRequirements(step)
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
            {required.orientation && step.orientation.state === 'unknown' ? (
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
            {required.visibleChecks && step.visibleChecks.length === 0 ? (
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

const styles = StyleSheet.create({
    flex: { flex: 1 },
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    pageStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    stripItem: { width: 96 },
    blockerHeader: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    headerPress: { minHeight: touchTarget, justifyContent: 'center' },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    chevronOpen: { transform: [{ rotate: '90deg' }] },
})
