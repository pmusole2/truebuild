import { useEffect, useRef, useState, type ComponentRef, type ReactElement, type ReactNode } from 'react'
import {
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    useWindowDimensions,
    View,
} from 'react-native'
import { FrozenPhoto } from '../assembly/frozen-photo'
import { boxOnDisplay, type Point } from '../assembly/frame-geometry'
import type { Observation } from '../assembly/observation'
import { stepPartChoices } from '../assembly/question-state'
import { AppButton, IconButton } from '../../ui/button'
import { BottomSheet } from '../../ui/sheet'
import { ActionDock, Card, Screen as ScreenShell } from '../../ui/surface'
import { Caption, Heading } from '../../ui/text'
import { EmptyState } from '../../ui/states'
import type { PaneNote } from '../../ui/pane-notes'
import { Notice } from '../../ui/status'
import { ProgressBar, StepList, type StepListItem } from '../../ui/progress'
import { AskSheet } from '../../ui/ask-sheet'
import { space } from '../../theme/tokens'
import { groundedRegion } from './grounded-region'
import type { LibraryEntry } from './library'
import { guidanceNotes, partGuidance } from './part-regions'
import {
    AnswerPanel,
    CheckHighlight,
    CheckPanel,
    PartGuidanceOverlay,
    passPulseKey,
    RefusalComparison,
} from './result-panels'
import { WorkflowNotice } from './screen-chrome'
import { DemoControls } from './demo-controls'
import { EvidencePair } from './evidence-pair'
import { SourceDiagrams, StepFacts } from './step-facts'
import { StepLayout } from './step-layout'
import type { WorkflowScreenProps } from './workflow-types'

/** The secondary actions may take at most this share of the window and scroll beyond it, so none is ever clipped. */
export const PANEL_MAX_RATIO = 0.4

// Two dock cells fit side by side on a 390 point phone; narrower rows or larger labels wrap instead of squeezing.
const DOCK_CELL_MIN_WIDTH = 150

/**
 * Assembly guide. One scroll holds the current step summary, the frozen photo or comparison, the result and the
 * question composer. The actions remain in a separate dock at standard text sizes on taller screens. Short windows,
 * larger text and the keyboard use one scroll so content is reachable. Full facts and diagrams open in the sheet.
 */
export function GuideScreen({ state, controller, entry }: WorkflowScreenProps & { entry: LibraryEntry }): ReactElement {
    const { session } = entry
    const step = session.reviewedSteps[entry.stepIndex]
    const blocked = controller.coverageNotice()
    const highlight = groundedRegion(state.answer ?? state.check)
    const busy = state.pending !== null || state.storageReadOnly
    const editable = controller.canCompose
    const { height, fontScale } = useWindowDimensions()
    const [instructionsOpen, setInstructionsOpen] = useState(false)
    const [keyboardVisible, setKeyboardVisible] = useState(false)
    const guideScroll = useRef<ComponentRef<typeof ScrollView>>(null)
    const compact = height < 650 || fontScale >= 1.5 || keyboardVisible
    useEffect(() => {
        const show = (): void => setKeyboardVisible(true)
        const hide = (): void => setKeyboardVisible(false)
        const subscriptions = [
            Keyboard.addListener('keyboardWillShow', show),
            Keyboard.addListener('keyboardDidShow', show),
            Keyboard.addListener('keyboardWillHide', hide),
            Keyboard.addListener('keyboardDidHide', hide),
        ]
        return (): void => subscriptions.forEach((subscription) => subscription.remove())
    }, [])
    // A reply arrives after submitting from the composer near the bottom. Bring that reply into view immediately;
    // no animation is needed, including when the user has requested reduced motion.
    useEffect(() => {
        if (state.check !== null) {
            guideScroll.current?.scrollTo({ y: 0, animated: false })
        }
    }, [state.check])
    useEffect(() => {
        if (state.answer !== null) {
            guideScroll.current?.scrollTo({ y: 0, animated: false })
        }
    }, [state.answer])
    const choices = step === undefined ? [] : stepPartChoices(session, step)
    // Only the current step's own part names can label a located region; anything else is dropped, never guessed.
    const guidance = partGuidance(state.answer ?? state.check, new Map(choices.map((c) => [c.partId, c.label])))
    const completed = new Set(entry.completedStepIds)
    const stepItems: StepListItem[] = session.reviewedSteps.map((item, index) => ({
        id: item.stepId,
        title: item.title,
        state: completed.has(item.stepId) ? 'done' : index === entry.stepIndex ? 'current' : 'upcoming',
    }))
    const check = state.check
    const capture = state.capture
    const hasResult = check !== null || state.answer !== null
    const refusal = check !== null && check.decision === 'refuse' ? check : null
    // Start the full-width view with the displayed result's actual citations, then retain the rest of the step.
    const instructionRefs = [
        ...new Map(
            [
                ...(refusal?.sourceRefs ?? state.answer?.sourceRefs ?? check?.sourceRefs ?? []),
                ...(state.answer?.sourceRefs ?? []),
                ...(check?.sourceRefs ?? []),
                ...(step?.sourceRefs ?? []),
            ].map((ref) => [JSON.stringify([ref.pageId, ref.region]), ref] as const),
        ).values(),
    ]
    // The summary and its layout are one element that shows before or after the photo; the answer's layout wins.
    const summary = (
        <StepLayout
            session={session}
            index={entry.stepIndex}
            result={state.answer ?? state.check}
            pageUris={state.pageUris}
        />
    )
    // Only a pass's own returned region pulses; an answer's region is outlined statically.
    const pulseKey =
        state.answer === null && check !== null && state.capture !== null
            ? passPulseKey(check, state.capture.binding.captureId)
            : null
    const target = state.target
    const targetSummary =
        target === null
            ? 'Choose a point or part.'
            : target.kind === 'part'
              ? `Selected part: ${choices.find((choice) => choice.partId === target.partId)?.label ?? target.partId}`
              : 'Selected point in photo.'
    // Point selection goes through the controller, which refuses it while a check is in flight.
    const onPoint = (point: Point): void => controller.targetChanged({ kind: 'point', ...point })
    const pointTap = editable && state.capture !== null ? onPoint : undefined
    const stepTitle = step === undefined ? session.title : `${step.order}. ${step.title}`
    // The first cited page of a pass, cannot-verify or answer sits beside the photo. A refusal has its own comparison.
    const pairedFrom = state.capture === null || refusal !== null ? null : state.answer !== null ? 'answer' : 'check'
    const pairedRefs =
        pairedFrom === 'answer'
            ? (state.answer?.sourceRefs ?? [])
            : pairedFrom === 'check'
              ? (check?.sourceRefs ?? [])
              : []
    const guideNotes = guidanceNotes(guidance)
    const frozenPhoto = (observation: Observation, notes?: readonly PaneNote[]): ReactElement => (
        <FrozenPhoto
            observation={observation}
            caption="Frozen photo for this step. New photos clear prior results."
            onTapPoint={pointTap}
            notes={notes}
            overlay={(displayed): ReactNode => (
                <>
                    <CheckHighlight
                        rect={highlight === null ? null : boxOnDisplay(highlight, displayed)}
                        pulseKey={pulseKey}
                    />
                    <PartGuidanceOverlay guidance={guidance} displayed={displayed} />
                </>
            )}
        />
    )
    const openInstructions = (): void => setInstructionsOpen(true)
    const unavailable = busy || blocked !== null || session.reviewStatus !== 'reviewed'
    // Secondary actions sit in two short rows beneath the one filled action: moving between steps, then the two
    // quieter ones. Every label stays visible and every control keeps its 44 point height; a row only wraps.
    const secondaryActions = (
        <>
            <View testID="dock-step-row" style={styles.dockRow}>
                <View style={styles.dockCell}>
                    <AppButton
                        label="Previous step"
                        icon="chevronLeft"
                        disabled={busy || entry.stepIndex === 0}
                        onPress={(): void => {
                            void controller.step(entry.stepIndex - 1)
                        }}
                    />
                </View>
                <View style={styles.dockCell}>
                    <AppButton
                        label="Next step"
                        icon="chevronRight"
                        disabled={busy || entry.stepIndex >= session.reviewedSteps.length - 1}
                        onPress={(): void => {
                            void controller.step(entry.stepIndex + 1)
                        }}
                    />
                </View>
            </View>
            <View testID="dock-support-row" style={styles.dockRow}>
                <View style={styles.dockCell}>
                    <AppButton
                        label="Take photo to ask"
                        icon="help"
                        variant="quiet"
                        disabled={unavailable}
                        onPress={(): void => controller.camera({ kind: 'question' })}
                    />
                </View>
                <View style={styles.dockCell}>
                    <AppButton
                        label="Mark step complete myself"
                        variant="quiet"
                        disabled={busy}
                        onPress={(): void => {
                            void controller.completeStep()
                        }}
                    />
                </View>
            </View>
        </>
    )
    const actions = (
        <ActionDock>
            <AppButton
                label="Take new photo and check"
                variant="accent"
                icon="camera"
                disabled={unavailable}
                onPress={(): void => controller.camera({ kind: 'check' })}
            />
            {compact ? (
                <View testID="guide-actions" style={styles.actions}>
                    {secondaryActions}
                </View>
            ) : (
                <ScrollView
                    testID="guide-actions"
                    style={{ maxHeight: height * PANEL_MAX_RATIO }}
                    contentContainerStyle={styles.actions}
                    keyboardShouldPersistTaps="handled"
                >
                    {secondaryActions}
                </ScrollView>
            )}
        </ActionDock>
    )
    const header = (
        <View style={[styles.header, compact && styles.compactHeader]}>
            <View style={styles.guideTop}>
                <IconButton label="Back" icon="chevronLeft" onPress={(): void => controller.navigate('overview')} />
                <View style={styles.titleWrap}>
                    <Caption>{`Step ${entry.stepIndex + 1} of ${session.reviewedSteps.length}`}</Caption>
                    <Heading>{stepTitle}</Heading>
                </View>
                <IconButton label="Step instructions" icon="info" onPress={openInstructions} />
            </View>
            <ProgressBar
                label="Guide progress"
                value={entry.completedStepIds.length}
                total={session.reviewedSteps.length}
            />
        </View>
    )
    return (
        <ScreenShell header="hidden" scroll={false} padded={false} testID="guide-screen">
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.guide}>
                {compact ? null : header}
                <ScrollView
                    ref={guideScroll}
                    testID="guide-panel"
                    accessibilityLabel="Step guide and results"
                    style={styles.main}
                    contentContainerStyle={styles.mainContent}
                    keyboardShouldPersistTaps="handled"
                >
                    {compact ? header : null}
                    <WorkflowNotice state={state} controller={controller} />
                    {blocked === null ? null : <Notice tone="caution" text={blocked} />}
                    {state.answer === null ? null : (
                        <AnswerPanel
                            answer={state.answer}
                            session={session}
                            pageUris={state.pageUris}
                            showSource={false}
                        />
                    )}
                    {check === null ? null : (
                        <CheckPanel check={check} session={session} pageUris={state.pageUris} showSource={false} />
                    )}
                    {hasResult ? null : summary}
                    {capture === null ? (
                        <EmptyState
                            title="No photo for this step yet."
                            body="Take a photo of this step to check or ask about it."
                        />
                    ) : refusal !== null ? (
                        <RefusalComparison
                            refusal={refusal}
                            observation={capture.observation}
                            entry={entry}
                            pageUris={state.pageUris}
                            onTapPoint={pointTap}
                            guidance={guidance}
                            onViewDiagram={openInstructions}
                        />
                    ) : pairedRefs.length > 0 ? (
                        <EvidencePair
                            photo={(photoNotes): ReactElement => frozenPhoto(capture.observation, photoNotes)}
                            notes={guideNotes}
                            reference={pairedRefs[0]!}
                            session={session}
                            pageUris={state.pageUris}
                            onViewDiagram={openInstructions}
                        />
                    ) : (
                        frozenPhoto(capture.observation, guideNotes)
                    )}
                    {state.answer === null ? null : (
                        <SourceDiagrams
                            refs={state.answer.sourceRefs}
                            session={session}
                            pageUris={state.pageUris}
                            skip={pairedFrom === 'answer' ? 1 : 0}
                        />
                    )}
                    {check === null || check.decision === 'refuse' ? null : (
                        <SourceDiagrams
                            refs={check.sourceRefs}
                            session={session}
                            pageUris={state.pageUris}
                            skip={pairedFrom === 'check' ? 1 : 0}
                        />
                    )}
                    {hasResult ? summary : null}
                    <DemoControls
                        session={session}
                        stepIndex={entry.stepIndex}
                        completedStepIds={entry.completedStepIds}
                        locked={busy || session.reviewStatus !== 'reviewed'}
                        onSelectStep={(index): void => {
                            void controller.step(index)
                        }}
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
                                editable={editable}
                                busy={state.pending !== null && state.pending.startsWith('Asking')}
                                onSubmit={(): void => {
                                    void controller.ask()
                                }}
                            />
                        </Card>
                    )}
                    {compact ? actions : null}
                </ScrollView>
                {compact ? null : actions}
            </KeyboardAvoidingView>
            <BottomSheet
                visible={instructionsOpen}
                title={`Step ${entry.stepIndex + 1} instructions`}
                onClose={(): void => setInstructionsOpen(false)}
            >
                <StepFacts session={session} index={entry.stepIndex} />
                <SourceDiagrams refs={instructionRefs} session={session} pageUris={state.pageUris} fit="page" />
                <ProgressBar
                    label="Steps marked complete"
                    value={entry.completedStepIds.length}
                    total={session.reviewedSteps.length}
                />
                <StepList steps={stepItems} />
            </BottomSheet>
        </ScreenShell>
    )
}

const styles = StyleSheet.create({
    guide: { flex: 1 },
    header: { gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm },
    compactHeader: { paddingHorizontal: 0, paddingTop: 0 },
    guideTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    titleWrap: { flex: 1 },
    main: { flex: 1 },
    mainContent: { padding: space.md, gap: space.md },
    actions: { gap: space.xs },
    dockRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    dockCell: { flexGrow: 1, flexBasis: 0, minWidth: DOCK_CELL_MIN_WIDTH },
})
