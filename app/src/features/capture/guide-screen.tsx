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
import { stepPartChoices } from '../assembly/question-state'
import { AppButton, IconButton } from '../../ui/button'
import { BottomSheet } from '../../ui/sheet'
import { ActionDock, ActionGroup, Card, Screen as ScreenShell } from '../../ui/surface'
import { Heading, Label } from '../../ui/text'
import { EmptyState } from '../../ui/states'
import { Notice } from '../../ui/status'
import { ProgressBar, StepList, type StepListItem } from '../../ui/progress'
import { AskSheet } from '../../ui/ask-sheet'
import { space } from '../../theme/tokens'
import { groundedRegion } from './grounded-region'
import type { LibraryEntry } from './library'
import { AnswerPanel, CheckHighlight, CheckPanel, RefusalComparison } from './result-panels'
import { WorkflowNotice } from './screen-chrome'
import { SourceDiagrams, StepFacts, StepSummary } from './step-facts'
import type { WorkflowScreenProps } from './workflow-types'

/** The secondary actions may take at most this share of the window and scroll beyond it, so none is ever clipped. */
export const PANEL_MAX_RATIO = 0.4

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
    // Point selection goes through the controller, which refuses it while a check is in flight.
    const onPoint = (point: Point): void => controller.targetChanged({ kind: 'point', ...point })
    const pointTap = editable && state.capture !== null ? onPoint : undefined
    const stepTitle = step === undefined ? session.title : `${step.order}. ${step.title}`
    const unavailable = busy || blocked !== null || session.reviewStatus !== 'reviewed'
    const secondaryActions = (
        <>
            <ActionGroup>
                <AppButton
                    label="Take photo to ask"
                    icon="help"
                    disabled={unavailable}
                    onPress={(): void => controller.camera({ kind: 'question' })}
                />
                <AppButton
                    label="Previous step"
                    icon="chevronLeft"
                    disabled={busy || entry.stepIndex === 0}
                    onPress={(): void => {
                        void controller.step(entry.stepIndex - 1)
                    }}
                />
                <AppButton
                    label="Next step"
                    icon="chevronRight"
                    disabled={busy || entry.stepIndex >= session.reviewedSteps.length - 1}
                    onPress={(): void => {
                        void controller.step(entry.stepIndex + 1)
                    }}
                />
            </ActionGroup>
            <AppButton
                label="Mark step complete myself"
                variant="quiet"
                disabled={busy}
                onPress={(): void => {
                    void controller.completeStep()
                }}
            />
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
    return (
        <ScreenShell header="hidden" scroll={false} padded={false} testID="guide-screen">
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.guide}>
                <View style={styles.header}>
                    <View style={styles.guideTop}>
                        <IconButton
                            label="Back"
                            icon="chevronLeft"
                            onPress={(): void => controller.navigate('overview')}
                        />
                        <View style={styles.titleWrap}>
                            <Label>{`Step ${entry.stepIndex + 1} of ${session.reviewedSteps.length}`}</Label>
                            <Heading>{stepTitle}</Heading>
                        </View>
                        <IconButton
                            label="Step instructions"
                            icon="info"
                            onPress={(): void => setInstructionsOpen(true)}
                        />
                    </View>
                    <ProgressBar
                        label="Guide progress"
                        value={entry.completedStepIds.length}
                        total={session.reviewedSteps.length}
                    />
                </View>
                <ScrollView
                    ref={guideScroll}
                    testID="guide-panel"
                    accessibilityLabel="Step guide and results"
                    style={styles.main}
                    contentContainerStyle={styles.mainContent}
                    keyboardShouldPersistTaps="handled"
                >
                    <WorkflowNotice state={state} controller={controller} />
                    {blocked === null ? null : <Notice tone="caution" text={blocked} />}
                    {state.answer === null ? null : (
                        <AnswerPanel answer={state.answer} session={session} pageUris={state.pageUris} />
                    )}
                    {check === null ? null : <CheckPanel check={check} session={session} pageUris={state.pageUris} />}
                    <StepSummary session={session} index={entry.stepIndex} />
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
                            onTapPoint={pointTap}
                        />
                    ) : (
                        <FrozenPhoto
                            observation={state.capture.observation}
                            caption="Frozen photo for this step. New photos clear prior results."
                            onTapPoint={pointTap}
                            overlay={
                                highlight === null
                                    ? undefined
                                    : (displayed): ReactNode => (
                                          <CheckHighlight rect={boxOnDisplay(highlight, displayed)} />
                                      )
                            }
                        />
                    )}
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
                <SourceDiagrams refs={step?.sourceRefs ?? []} session={session} pageUris={state.pageUris} />
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
    guideTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    titleWrap: { flex: 1 },
    main: { flex: 1 },
    mainContent: { padding: space.md, gap: space.md },
    actions: { gap: space.xs },
})
