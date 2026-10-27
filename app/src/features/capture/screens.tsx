import { useState, type ReactElement, type ReactNode } from 'react'
import { Image, Linking, Pressable, StyleSheet, View } from 'react-native'
import type { CheckResult, Fact, ManualSession, SourceRef } from '@truebuild/contracts'
import { FrozenPhoto } from '../assembly/frozen-photo'
import { boxOnDisplay } from '../assembly/frame-geometry'
import { stepPartChoices } from '../assembly/question-state'
import { AppButton, IconButton } from '../../ui/button'
import { BottomSheet } from '../../ui/sheet'
import { Card, Screen as ScreenShell, Stack } from '../../ui/surface'
import { Body, Callout, Caption, Heading, Label, Title } from '../../ui/text'
import { Icon } from '../../ui/icons'
import { EmptyState, ErrorState, LoadingState } from '../../ui/states'
import { Notice, StatusTag, type NoticeTone } from '../../ui/status'
import { ProgressBar, StepList, type StepListItem } from '../../ui/progress'
import { ComparisonFrame, MeasuredPane, type ComparisonPane } from '../../ui/comparison'
import { AskSheet } from '../../ui/ask-sheet'
import { ResultSheet } from '../../ui/result-sheet'
import { TextField } from '../../ui/fields'
import { Skeleton } from '../../ui/skeleton'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { useTheme } from '../../theme/theme'
import { radius, space, touchTarget } from '../../theme/tokens'
import { groundedRegion } from './grounded-region'
import { reviewedSession, unresolvedCriticalFacts, type CaptureController, type WorkflowState } from './controller'
import type { LibraryEntry } from './library'

export type WorkflowScreenProps = { state: WorkflowState; controller: CaptureController }

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
    return (
        <Card>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.session.title}`}
                onPress={onOpen}
                style={styles.manualPress}
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
            <Caption>
                Pages stay on this device. Pages are sent to your TrueBuild API only when you read the manual, check a
                step or ask a question.
            </Caption>
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

function factText<T>(fact: Fact<T>, display: (value: T) => string): string {
    return fact.state === 'known' ? display(fact.value) : `Unknown: ${fact.reason}`
}

export function StepFacts({ session, index }: { session: ManualSession; index: number }): ReactElement {
    const step = session.reviewedSteps[index]
    if (step === undefined) {
        return <Body tone="muted">No extracted steps yet.</Body>
    }
    return (
        <Stack gap="xs">
            <Heading>{`${step.order}. ${step.title}`}</Heading>
            {step.parts.map((part) => (
                <Body key={part.partId}>{`${part.partId}: ${factText(part.quantity, String)}`}</Body>
            ))}
            <Body>{`Orientation: ${factText(step.orientation, (value) => value.description)}`}</Body>
            <Body>{`Connection: ${factText(step.connection, (value) => value.description)}`}</Body>
            {step.visibleChecks.map((check) => (
                <Body key={check.checkId}>{`Visible check: ${factText(check.description, String)}`}</Body>
            ))}
            {step.correction?.actions.map((action) => (
                <Body key={action.actionId}>{`Correction: ${action.instruction}`}</Body>
            ))}
        </Stack>
    )
}

/** Expected diagrams for cited pages. Highlights are measured against each page's own size, so letterboxing is correct. */
export function SourceDiagrams({
    refs,
    session,
    pageUris,
}: {
    refs: readonly SourceRef[]
    session: ManualSession
    pageUris: WorkflowState['pageUris']
}): ReactElement {
    return (
        <Stack gap="sm">
            {refs.map((ref, index) => {
                const page = session.pages.find((candidate) => candidate.pageId === ref.pageId)
                if (page === undefined) {
                    return <Caption key={index}>Cited diagram unavailable.</Caption>
                }
                const pageNumber = session.pages.indexOf(page) + 1
                const uri = pageUris[page.pageId]
                const pane: ComparisonPane = {
                    caption: `Expected diagram · page ${pageNumber}`,
                    media:
                        uri === undefined ? (
                            <Caption>Loading page…</Caption>
                        ) : (
                            <Image
                                source={{ uri }}
                                accessibilityLabel={`Expected diagram page ${pageNumber}`}
                                resizeMode="stretch"
                                style={StyleSheet.absoluteFill}
                            />
                        ),
                    mediaSize: { width: page.width, height: page.height },
                    regions:
                        ref.region === null ? [] : [{ id: `cited-${index}`, label: 'Cited area', box: ref.region }],
                }
                return (
                    <MeasuredPane
                        key={`${ref.pageId}-${index}`}
                        pane={pane}
                        testID={`diagram-${index}`}
                        sideBySide={false}
                    />
                )
            })}
        </Stack>
    )
}

export function OverviewScreen({
    state,
    controller,
    entry,
}: WorkflowScreenProps & { entry: LibraryEntry }): ReactElement {
    const { session } = entry
    const [confirmed, setConfirmed] = useState(false)
    const canConfirm = reviewedSession(session) !== null
    const unresolved = unresolvedCriticalFacts(session)
    const reviewed = session.reviewStatus === 'reviewed'
    return (
        <Screen title={session.title} onBack={controller.home} testID="overview-screen">
            <WorkflowNotice state={state} controller={controller} />
            <Caption>
                Review extracted facts against your original diagrams. Unknown critical facts block verified checks.
            </Caption>
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
                        onToggle={(): void => setConfirmed(!confirmed)}
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

export function GuideScreen({ state, controller, entry }: WorkflowScreenProps & { entry: LibraryEntry }): ReactElement {
    const { session } = entry
    const step = session.reviewedSteps[entry.stepIndex]
    const blocked = controller.coverageNotice()
    const highlight = groundedRegion(state.answer ?? state.check)
    const busy = state.pending !== null || state.storageReadOnly
    const [sheetOpen, setSheetOpen] = useState(false)
    const choices = step === undefined ? [] : stepPartChoices(session, step)
    const completed = new Set(entry.completedStepIds)
    const stepItems: StepListItem[] = session.reviewedSteps.map((item, index) => ({
        id: item.stepId,
        title: item.title,
        state: completed.has(item.stepId) ? 'done' : index === entry.stepIndex ? 'current' : 'upcoming',
    }))
    const check = state.check
    const refusal = check !== null && check.decision === 'refuse' ? check : null
    const target = state.target
    const targetSummary =
        target === null
            ? 'Choose a point or part.'
            : target.kind === 'part'
              ? `Selected part: ${choices.find((choice) => choice.partId === target.partId)?.label ?? target.partId}`
              : 'Selected point in photo.'
    return (
        <Screen
            title={`Assembly · ${session.title}`}
            onBack={(): void => controller.navigate('overview')}
            testID="guide-screen"
        >
            <WorkflowNotice state={state} controller={controller} />
            <Label>{`Step ${entry.stepIndex + 1} of ${session.reviewedSteps.length}`}</Label>
            <ProgressBar
                label="Steps marked complete"
                value={entry.completedStepIds.length}
                total={session.reviewedSteps.length}
            />
            <StepList steps={stepItems} />
            {step === undefined ? null : (
                <Card>
                    <Heading>{`${step.order}. ${step.title}`}</Heading>
                    <AppButton label="Show step instructions" onPress={(): void => setSheetOpen(true)} />
                </Card>
            )}
            <BottomSheet
                visible={sheetOpen}
                title={`Step ${entry.stepIndex + 1}`}
                onClose={(): void => setSheetOpen(false)}
            >
                <StepFacts session={session} index={entry.stepIndex} />
                <SourceDiagrams refs={step?.sourceRefs ?? []} session={session} pageUris={state.pageUris} />
            </BottomSheet>
            {blocked === null ? null : <Notice tone="caution" text={blocked} />}
            {state.capture === null ? (
                <EmptyState
                    title="No photo for this step yet."
                    body="Take a photo of this step to check or ask about it."
                />
            ) : refusal !== null ? (
                <RefusalComparison
                    refusal={refusal}
                    observation={state.capture.observation}
                    entry={entry}
                    pageUris={state.pageUris}
                />
            ) : (
                <FrozenPhoto
                    observation={state.capture.observation}
                    caption="Frozen photo for this step. New photos clear prior results."
                    onTapPoint={
                        busy ? undefined : (point): void => controller.targetChanged({ kind: 'point', ...point })
                    }
                    overlay={
                        highlight === null
                            ? undefined
                            : (displayed): ReactNode => <CheckHighlight rect={boxOnDisplay(highlight, displayed)} />
                    }
                />
            )}
            {check === null ? null : (
                <ResultSheet
                    verdict={check.decision}
                    reason={check.reason}
                    missing={check.missingEvidence}
                    citedPage={
                        refusal === null ? (
                            <SourceDiagrams refs={check.sourceRefs} session={session} pageUris={state.pageUris} />
                        ) : undefined
                    }
                />
            )}
            <AppButton
                label="Take new photo and check"
                variant="accent"
                disabled={busy || blocked !== null || session.reviewStatus !== 'reviewed'}
                onPress={(): void => controller.camera({ kind: 'check' })}
            />
            <AppButton
                label="Take photo to ask"
                disabled={busy || blocked !== null || session.reviewStatus !== 'reviewed'}
                onPress={(): void => controller.camera({ kind: 'question' })}
            />
            {state.capture === null ? null : (
                <Card>
                    <Heading>Ask about this photo</Heading>
                    <AskSheet
                        question={state.question}
                        questionLabel="Question about frozen photo"
                        onQuestionChange={controller.questionChanged}
                        parts={choices.map((choice) => ({ id: choice.partId, label: choice.label }))}
                        selectedPartId={target?.kind === 'part' ? target.partId : null}
                        onSelectPart={(partId): void => controller.targetChanged({ kind: 'part', partId })}
                        targetSummary={targetSummary}
                        hasTarget={target !== null}
                        editable={controller.canCompose}
                        busy={state.pending !== null && state.pending.startsWith('Asking')}
                        onSubmit={(): void => {
                            void controller.ask()
                        }}
                        answer={
                            state.answer === null ? undefined : (
                                <ResultSheet
                                    verdict={state.answer.missingEvidence.length === 0 ? 'pass' : 'cannot_verify'}
                                    reason={state.answer.answer}
                                    missing={state.answer.missingEvidence}
                                    citedPage={
                                        <SourceDiagrams
                                            refs={state.answer.sourceRefs}
                                            session={session}
                                            pageUris={state.pageUris}
                                        />
                                    }
                                />
                            )
                        }
                    />
                </Card>
            )}
            <AppButton
                label="Mark step complete myself"
                disabled={busy}
                onPress={(): void => {
                    void controller.completeStep()
                }}
            />
            <View style={styles.actionRow}>
                <AppButton
                    label="Previous step"
                    variant="quiet"
                    disabled={busy || entry.stepIndex === 0}
                    onPress={(): void => {
                        void controller.step(entry.stepIndex - 1)
                    }}
                />
                <AppButton
                    label="Next step"
                    variant="quiet"
                    disabled={busy || entry.stepIndex >= session.reviewedSteps.length - 1}
                    onPress={(): void => {
                        void controller.step(entry.stepIndex + 1)
                    }}
                />
            </View>
        </Screen>
    )
}

/** A refusal shows the expected diagram and the frozen photo side by side, with the observed region measured on each. */
function RefusalComparison({
    refusal,
    observation,
    entry,
    pageUris,
}: {
    refusal: CheckResult
    observation: { uri: string; width: number; height: number }
    entry: LibraryEntry
    pageUris: WorkflowState['pageUris']
}): ReactElement {
    const cited = refusal.sourceRefs[0]
    const page =
        cited === undefined ? undefined : entry.session.pages.find((candidate) => candidate.pageId === cited.pageId)
    const diagramUri = page === undefined ? undefined : pageUris[page.pageId]
    const diagram: ComparisonPane = {
        caption: 'Manual diagram',
        media:
            diagramUri === undefined ? (
                <Caption>Cited diagram unavailable.</Caption>
            ) : (
                <Image
                    source={{ uri: diagramUri }}
                    accessibilityLabel="Cited manual page"
                    resizeMode="stretch"
                    style={StyleSheet.absoluteFill}
                />
            ),
        mediaSize: page === undefined ? { width: 1, height: 1 } : { width: page.width, height: page.height },
        regions: cited?.region ? [{ id: 'cited', label: 'Cited area', box: cited.region }] : [],
    }
    const photo: ComparisonPane = {
        caption: 'Your photo',
        media: (
            <Image
                source={{ uri: observation.uri }}
                accessibilityLabel="Your photo of this step"
                resizeMode="stretch"
                style={StyleSheet.absoluteFill}
            />
        ),
        mediaSize: { width: observation.width, height: observation.height },
        regions: refusal.observedRegion
            ? [{ id: 'observed', label: 'Observed part', box: refusal.observedRegion }]
            : [],
    }
    return <ComparisonFrame diagram={diagram} photo={photo} />
}

function CheckHighlight({ rect }: { rect: { x: number; y: number; width: number; height: number } }): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            pointerEvents="none"
            accessibilityElementsHidden={true}
            importantForAccessibility="no"
            style={[
                styles.highlight,
                { borderColor: colors.accent, left: rect.x, top: rect.y, width: rect.width, height: rect.height },
            ]}
        />
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
                <Body>
                    Manual pages leave this phone only when you read a manual. A frozen photo leaves only when you check
                    a step or ask a question. Cancelled requests are not repeated automatically.
                </Body>
            </Card>
            <Card>
                <Heading>Camera and photos</Heading>
                <Body>
                    The camera opens only when you choose to photograph a page or a step. Photos you choose from your
                    library stay on this device until you send them.
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
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    titleWrap: {
        flex: 1,
    },
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
    highlight: {
        position: 'absolute',
        borderWidth: 3,
        borderRadius: radius.sm,
    },
})
