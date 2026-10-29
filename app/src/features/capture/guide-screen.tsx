import { useEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
import {
    I18nManager,
    KeyboardAvoidingView,
    PanResponder,
    Platform,
    StyleSheet,
    useWindowDimensions,
    View,
} from 'react-native'
import { FrozenPhoto } from '../assembly/frozen-photo'
import { boxOnDisplay, type Point } from '../assembly/frame-geometry'
import type { Observation } from '../assembly/observation'
import { stepPartChoices } from '../assembly/question-state'
import { AppButton } from '../../ui/button'
import { FixedBottomBar, type BarAction } from '../../ui/bottom-bar'
import { MoreSheet } from '../../ui/sheet'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Instruction } from '../../ui/text'
import type { PaneNote } from '../../ui/pane-notes'
import { ProgressBar, StepList, type StepListItem } from '../../ui/progress'
import { AskSheet } from '../../ui/ask-sheet'
import { useFeedback } from '../../ui/feedback'
import { useIconReveal, useStepTransition } from '../../ui/motion'
import Animated from 'react-native-reanimated'
import { Icon, type IconName } from '../../ui/icons'
import { useTheme } from '../../theme/theme'
import { radius, space, type ColorToken } from '../../theme/tokens'
import { guideCandidates } from '../onboarding/coach-inventory'
import { CoachTarget, useCoachAttention, useCoachScope, useCoachScreen } from '../onboarding/coach-provider'
import { ShowTipsAgainRow } from '../onboarding/tips-rows'
import { groundedRegion } from './grounded-region'
import type { LibraryEntry } from './library'
import { guidanceNotes, partGuidance } from './part-regions'
import { AnswerPanel, CheckHighlight, CheckPanel, PartGuidanceOverlay, RefusalComparison } from './result-panels'
import { PlainNotice, ScreenBody, TextRegion, useHeroHeight, useKeyboardVisible } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import { defaultNav, type ScreenNav } from './screen-nav'
import { DemoControls } from './demo-controls'
import { AboutThisCheck } from './more-sections'
import { guideSentence, isProgressNotice, plainPending } from './plain-copy'
import { PRIVACY_COPY } from './privacy-copy'
import { EvidencePair } from './evidence-pair'
import { SourceDiagrams } from './step-facts'
import { StepDetails } from './step-details'
import { StepLayout } from './step-layout'
import { StepPicture } from './step-picture'
import type { WorkflowScreenProps } from './workflow-types'

// A horizontal drag this long on the hero moves to the neighbouring step.
const SWIPE_DISTANCE = 56

// iOS goes back when a drag starts at the leading screen edge. The hero's step swipe leaves that strip to the system,
// so a back swipe is never swallowed; swipes that start anywhere else still browse steps.
export const EDGE_RESERVE = 28

/** True when a drag that began at `startX` belongs to the system's edge Back and not to the step swipe. */
export function startsAtSystemEdge(startX: number, width: number, rtl: boolean): boolean {
    return rtl ? startX > width - EDGE_RESERVE : startX < EDGE_RESERVE
}

const RESULT_SIZE = 48

const RESULT_LOOK: Readonly<
    Record<'pass' | 'refuse' | 'cannot' | 'error', { icon: IconName; surface: ColorToken; ink: ColorToken }>
> = {
    pass: { icon: 'check', surface: 'passSurface', ink: 'pass' },
    refuse: { icon: 'close', surface: 'refuseSurface', ink: 'refuse' },
    cannot: { icon: 'help', surface: 'cautionSurface', ink: 'caution' },
    error: { icon: 'alert', surface: 'cautionSurface', ink: 'caution' },
}

/** The verdict as a tinted mark beside the sentence. It says nothing the sentence does not, so it is not an element. */
function ResultIcon({
    kind,
    identity,
    enabled,
}: {
    kind: 'pass' | 'refuse' | 'cannot' | 'error'
    identity: string
    enabled: boolean
}): ReactElement {
    const { colors } = useTheme()
    const look = RESULT_LOOK[kind]
    // The one result motion: the icon settles once per result identity; the sentence beside it never moves.
    const reveal = useIconReveal(identity, enabled)
    return (
        <Animated.View
            testID="result-icon"
            accessibilityElementsHidden={true}
            importantForAccessibility="no-hide-descendants"
            style={[styles.resultIcon, { backgroundColor: colors[look.surface] }, reveal]}
        >
            <Icon name={look.icon} color={colors[look.ink]} />
        </Animated.View>
    )
}

type GuideProps = WorkflowScreenProps & ChromeProps & { entry: LibraryEntry; readonly nav?: ScreenNav }

/**
 * Guide: the step's picture fills the top, one sentence says what to do or how it went, and one primary sits above the
 * safe area. Everything else (full words, evidence, asking, all steps, marking a step done) is in More. Only text that
 * overflows scrolls; the hero and the bar stay put.
 */
export function GuideScreen({
    state,
    controller,
    entry,
    nav: navProp,
    chrome = 'inline',
    more: moreProp,
}: GuideProps): ReactElement {
    const { session } = entry
    const nav = navProp ?? defaultNav(controller)
    const internalMore = useMoreState()
    const more = moreProp ?? internalMore
    const keyboard = useKeyboardVisible()
    const heroHeight = useHeroHeight(keyboard)
    const { width: windowWidth } = useWindowDimensions()
    const step = session.reviewedSteps[entry.stepIndex]
    const stepCount = session.reviewedSteps.length
    const last = entry.stepIndex >= stepCount - 1
    const coverage = controller.coverageNotice()
    const needsQuestions = session.reviewStatus !== 'reviewed'
    const blocked = coverage !== null || needsQuestions
    const busy = state.pending !== null || state.storageReadOnly
    const editable = controller.canCompose
    const { check, capture, answer } = state
    const highlight = groundedRegion(answer ?? check)
    const hasResult = check !== null || answer !== null
    const refusal = check !== null && check.decision === 'refuse' ? check : null
    const choices = step === undefined ? [] : stepPartChoices(session, step)
    // Only the current step's own part names can label a located region; anything else is dropped, never guessed.
    const guidance = partGuidance(answer ?? check, new Map(choices.map((c) => [c.partId, c.label])))
    const guideNotes = guidanceNotes(guidance)
    // The last step is marked but others are not (steps were skipped or browsed past): say so and offer the first open one.
    const firstOpen = session.reviewedSteps.findIndex((item) => !entry.completedStepIds.includes(item.stepId))
    const unfinished =
        last &&
        !blocked &&
        capture === null &&
        !hasResult &&
        step !== undefined &&
        entry.completedStepIds.includes(step.stepId) &&
        firstOpen >= 0
            ? firstOpen
            : null
    const sentence = guideSentence({
        state,
        step,
        blocked,
        unfinished: unfinished === null ? undefined : unfinished + 1,
    })
    // Marking a step done already moved the header on; its notice would only be a second sentence under the first.
    // A generic failure is the sentence itself (warning icon and one instruction), so it never gets a second banner.
    const quietState =
        state.notice !== null && (isProgressNotice(state.notice) || sentence.kind === 'error')
            ? { ...state, notice: null }
            : state
    const target = state.target
    const targetSummary =
        target === null
            ? 'Choose a point or part.'
            : target.kind === 'part'
              ? `Selected part: ${choices.find((choice) => choice.partId === target.partId)?.label ?? 'a part'}`
              : 'Selected point in photo.'
    const onPoint = (point: Point): void => controller.targetChanged({ kind: 'point', ...point })
    const pointTap = editable && capture !== null ? onPoint : undefined

    // One notification per new result, announced once however often it is shown again. An answer never changes how a
    // retained check was announced.
    const { hapticOnce } = useFeedback()
    // A new photo is a new result even when the checker words it the same, so the photo is part of the identity.
    // Opening More or coming back to a shown result never changes it, so nothing replays.
    const checkIdentity =
        check === null
            ? null
            : JSON.stringify([
                  'check',
                  session.manualId,
                  step?.stepId,
                  capture?.binding.captureId ?? null,
                  check.decision,
                  check.reason,
              ])
    useEffect(() => {
        if (check === null || checkIdentity === null) {
            return
        }
        hapticOnce(checkIdentity, check.decision === 'pass' ? 'success' : 'warning')
    }, [check, checkIdentity, hapticOnce])
    // Step and result motion hold still while the app is working, a sheet covers the screen or a tip owns attention.
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const still = state.pending !== null || more.open || attention || !scope.active
    const previousStep = useRef(entry.stepIndex)
    const direction = entry.stepIndex >= previousStep.current ? 1 : -1
    useEffect(() => {
        previousStep.current = entry.stepIndex
    }, [entry.stepIndex])
    // Picture, overlays and instruction share one transform, so evidence never slides apart from its photo.
    const stepMotion = useStepTransition(`${session.manualId}:${step?.stepId ?? ''}`, direction, !still)
    useEffect(() => {
        if (answer !== null) {
            hapticOnce(
                JSON.stringify(['answer', session.manualId, capture?.binding.captureId, answer.answer]),
                'selection',
            )
        }
    }, [answer, capture, hapticOnce, session.manualId])

    // A reply to a question closes the composer so the answer reads on the hero.
    const previousAnswer = useRef(answer)
    useEffect(() => {
        if (answer !== null && previousAnswer.current === null && more.open && more.mode === 'ask') {
            more.hide()
        }
        previousAnswer.current = answer
    }, [answer, more])

    const swipe = useMemo(
        () =>
            PanResponder.create({
                onMoveShouldSetPanResponder: (_event, gesture) =>
                    Math.abs(gesture.dx) > 24 &&
                    Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5 &&
                    !(
                        Platform.OS === 'ios' &&
                        startsAtSystemEdge(gesture.moveX - gesture.dx, windowWidth, I18nManager.isRTL)
                    ),
                onPanResponderRelease: (_event, gesture) => {
                    if (state.pending !== null || state.storageReadOnly) {
                        return
                    }
                    const next =
                        gesture.dx < -SWIPE_DISTANCE
                            ? entry.stepIndex + 1
                            : gesture.dx > SWIPE_DISTANCE
                              ? entry.stepIndex - 1
                              : null
                    if (next !== null && next >= 0 && next < stepCount) {
                        void controller.step(next)
                    }
                },
            }),
        [controller, entry.stepIndex, state.pending, state.storageReadOnly, stepCount, windowWidth],
    )

    // What the hero photo must keep in view: the observed area and the returned next-part and target areas.
    const heroRegions = [highlight, guidance.next?.box, guidance.target?.box].filter((box) => box != null)
    const frozenPhoto = (observation: Observation, notes?: readonly PaneNote[], fillHeight?: number): ReactElement => (
        <FrozenPhoto
            observation={observation}
            caption="Your photo for this step."
            onTapPoint={fillHeight === undefined ? pointTap : undefined}
            notes={notes}
            fillHeight={fillHeight}
            heroRegions={heroRegions}
            heroLabel={fillHeight === undefined ? undefined : (guidance.next?.name ?? guidance.target?.name)}
            flush={fillHeight !== undefined}
            overlay={(displayed): ReactNode => (
                <>
                    <CheckHighlight rect={highlight === null ? null : boxOnDisplay(highlight, displayed)} />
                    <PartGuidanceOverlay guidance={guidance} displayed={displayed} />
                </>
            )}
        />
    )

    const cameraBlocked = busy || blocked
    const primary: BarAction = blocked
        ? {
              label: needsQuestions ? 'Answer questions' : 'Add clearer photos',
              compactLabel: needsQuestions ? 'Answer' : 'Add',
              testID: 'guide-primary',
              disabled: state.pending !== null,
              onPress: (): void => controller.navigate(needsQuestions ? 'overview' : 'pages'),
          }
        : state.pending !== null && check === null
          ? {
                label: 'Checking…',
                compactLabel: 'Checking',
                testID: 'guide-primary',
                busy: true,
                onPress: (): void => undefined,
            }
          : check !== null && check.decision === 'pass' && step !== undefined
            ? {
                  label: last ? 'Finish' : 'Next step',
                  compactLabel: last ? 'Finish' : 'Next',
                  testID: 'guide-primary',
                  disabled: busy,
                  // Tapping after a pass is the person's own confirmation that this step is done: it records that
                  // (the same completion as marking a step done) and moves on. Swiping and browsing never record it.
                  onPress: (): void => {
                      if (last) {
                          void nav.finish()
                      } else {
                          void controller.completeStep()
                      }
                  },
              }
            : unfinished !== null
              ? {
                    label: `Go to step ${unfinished + 1}`,
                    compactLabel: 'Go',
                    testID: 'guide-primary',
                    disabled: busy,
                    onPress: (): void => {
                        void controller.step(unfinished)
                    },
                }
              : {
                    label: check !== null ? 'Take another photo' : 'Take photo',
                    compactLabel: check !== null ? 'Retake' : 'Photo',
                    testID: 'guide-primary',
                    icon: 'camera',
                    disabled: cameraBlocked,
                    onPress: (): void => controller.camera({ kind: 'check' }),
                }

    useCoachScreen('guide', {
        suppressed: state.pending !== null || state.storageReadOnly || more.open || keyboard,
        candidates: guideCandidates({
            hero: step !== undefined,
            primaryLabel: primary.disabled === true || primary.busy === true ? null : primary.label,
            swipe: stepCount > 1,
            more: chrome === 'native',
        }),
    })

    const stepItems: StepListItem[] = session.reviewedSteps.map((item, index) => ({
        id: item.stepId,
        title: item.title,
        state: entry.completedStepIds.includes(item.stepId)
            ? 'done'
            : index === entry.stepIndex
              ? 'current'
              : 'upcoming',
    }))
    const instructionRefs = [
        ...new Map(
            [
                ...(refusal?.sourceRefs ?? answer?.sourceRefs ?? check?.sourceRefs ?? []),
                ...(answer?.sourceRefs ?? []),
                ...(check?.sourceRefs ?? []),
                ...(step?.sourceRefs ?? []),
            ].map((ref) => [JSON.stringify([ref.pageId, ref.region]), ref] as const),
        ).values(),
    ]
    const pairedFrom = capture === null || refusal !== null ? null : answer !== null ? 'answer' : 'check'
    const pairedRefs =
        pairedFrom === 'answer' ? (answer?.sourceRefs ?? []) : pairedFrom === 'check' ? (check?.sourceRefs ?? []) : []
    const heroImage = (
        <View testID="guide-hero" style={{ height: heroHeight }}>
            {capture === null ? (
                <StepPicture
                    reference={step?.sourceRefs[0]}
                    references={step?.sourceRefs}
                    session={session}
                    pageUris={state.pageUris}
                    height={heroHeight}
                    testID="guide-hero-picture"
                    flush
                    cover
                />
            ) : (
                frozenPhoto(capture.observation, guideNotes, heroHeight)
            )}
        </View>
    )
    const reason = state.pending !== null && check !== null ? plainPending(state.pending) : null
    // An answer never carries a verdict, even while a check is retained, so only the check's own sentence gets the mark.
    const verdict =
        sentence.kind === 'pass' ||
        sentence.kind === 'refuse' ||
        sentence.kind === 'cannot' ||
        sentence.kind === 'error'
            ? sentence.kind
            : null
    const resultIdentity =
        checkIdentity ?? JSON.stringify(['error', session.manualId, step?.stepId, state.notice ?? null])
    const sentenceNode =
        check !== null || answer !== null || sentence.kind === 'error' ? (
            <View accessibilityLiveRegion="polite" style={styles.sentenceRow}>
                {verdict === null ? null : <ResultIcon kind={verdict} identity={resultIdentity} enabled={!still} />}
                <View style={styles.sentenceText}>
                    <Instruction>{sentence.text}</Instruction>
                </View>
            </View>
        ) : (
            <Instruction>{sentence.text}</Instruction>
        )

    return (
        <ScreenBody testID="guide-screen">
            {chrome === 'inline' ? (
                <InlineHeader
                    title={session.title}
                    subtitle={`Step ${entry.stepIndex + 1} of ${stepCount}`}
                    more={more}
                />
            ) : null}
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
                <CoachTarget id="guide-hero-frame" label="The step picture">
                    <CoachTarget id="guide-hero" label="The step picture">
                        <View testID="guide-hero-frame" {...swipe.panHandlers} style={styles.heroFrame}>
                            <View style={blocked ? styles.dimmed : undefined}>
                                <Animated.View style={stepMotion}>{heroImage}</Animated.View>
                            </View>
                        </View>
                    </CoachTarget>
                </CoachTarget>
                {/* A slim cue of overall progress: the full labelled bar is in More. It never moves the hero. */}
                <View style={styles.cue}>
                    <ProgressBar
                        slim
                        animate={!still}
                        label="Current step"
                        value={entry.stepIndex + 1}
                        total={stepCount}
                    />
                </View>
                <TextRegion testID="guide-panel">
                    <PlainNotice state={quietState} controller={controller} />
                    <Animated.View style={stepMotion}>{sentenceNode}</Animated.View>
                </TextRegion>
            </KeyboardAvoidingView>
            <FixedBottomBar primary={primary} reason={reason} />
            <MoreSheet
                visible={more.open}
                title={more.mode === 'ask' ? 'Ask about this step' : 'More about this step'}
                compactTitle={more.mode === 'ask' ? 'Ask' : 'More'}
                onClose={more.hide}
                detents={more.mode === 'ask' ? ['tall', 'full'] : ['peek', 'tall', 'full']}
                initialDetent="tall"
            >
                <GuideMore
                    mode={more.mode === 'ask' ? 'ask' : 'details'}
                    onAsk={(): void => more.show('ask')}
                    state={state}
                    controller={controller}
                    nav={nav}
                    entry={entry}
                    onClose={more.hide}
                    refusal={refusal}
                    pairedRefs={pairedRefs}
                    pairedFrom={pairedFrom}
                    instructionRefs={instructionRefs}
                    stepItems={stepItems}
                    frozenPhoto={frozenPhoto}
                    guideNotes={guideNotes}
                    pointTap={pointTap}
                    guidance={guidance}
                    choices={choices}
                    targetSummary={targetSummary}
                    editable={editable}
                    askBlocked={cameraBlocked}
                />
            </MoreSheet>
        </ScreenBody>
    )
}

function GuideMore({
    mode,
    onAsk,
    state,
    controller,
    nav,
    entry,
    onClose,
    refusal,
    pairedRefs,
    pairedFrom,
    instructionRefs,
    stepItems,
    frozenPhoto,
    guideNotes,
    pointTap,
    guidance,
    choices,
    targetSummary,
    editable,
    askBlocked,
}: {
    mode: 'details' | 'ask'
    onAsk: () => void
    state: WorkflowScreenProps['state']
    controller: WorkflowScreenProps['controller']
    nav: ScreenNav
    entry: LibraryEntry
    onClose: () => void
    refusal: NonNullable<WorkflowScreenProps['state']['check']> | null
    pairedRefs: LibraryEntry['session']['reviewedSteps'][number]['sourceRefs']
    pairedFrom: 'answer' | 'check' | null
    instructionRefs: LibraryEntry['session']['reviewedSteps'][number]['sourceRefs']
    stepItems: StepListItem[]
    frozenPhoto: (observation: Observation, notes?: readonly PaneNote[], fillHeight?: number) => ReactElement
    guideNotes: readonly PaneNote[]
    pointTap: ((point: Point) => void) | undefined
    guidance: ReturnType<typeof partGuidance>
    choices: ReturnType<typeof stepPartChoices>
    targetSummary: string
    editable: boolean
    askBlocked: boolean
}): ReactElement {
    const { session } = entry
    const { check, capture, answer, target } = state
    const busy = state.pending !== null || state.storageReadOnly
    const last = entry.stepIndex >= session.reviewedSteps.length - 1
    const ask = (
        <Stack gap="sm">
            <Heading>Ask about this step</Heading>
            {capture === null ? <Body>Take a photo first, then ask about it.</Body> : null}
            <AppButton
                label="Take photo to ask"
                icon="help"
                variant={capture === null ? 'secondary' : 'quiet'}
                disabled={askBlocked}
                onPress={(): void => {
                    onClose()
                    controller.camera({ kind: 'question' })
                }}
            />
            {capture === null ? null : (
                <AskSheet
                    question={state.question}
                    questionLabel="Question about your photo"
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
            )}
        </Stack>
    )
    const evidence =
        capture === null ? null : refusal !== null ? (
            <RefusalComparison
                refusal={refusal}
                observation={capture.observation}
                entry={entry}
                pageUris={state.pageUris}
                onTapPoint={pointTap}
                guidance={guidance}
            />
        ) : pairedRefs.length > 0 ? (
            <EvidencePair
                photo={(photoNotes): ReactElement => frozenPhoto(capture.observation, photoNotes)}
                notes={guideNotes}
                reference={pairedRefs[0]!}
                session={session}
                pageUris={state.pageUris}
            />
        ) : (
            frozenPhoto(capture.observation, guideNotes)
        )
    const extraSources = (
        <>
            {answer === null ? null : (
                <SourceDiagrams
                    refs={answer.sourceRefs}
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
        </>
    )
    if (mode === 'ask') {
        return (
            <Stack gap="md">
                {evidence}
                {ask}
            </Stack>
        )
    }
    return (
        <Stack gap="lg">
            {state.pending === null ? null : (
                <Card tone="raised">
                    <Body>{plainPending(state.pending) ?? 'Working…'}</Body>
                    <AppButton label="Cancel" variant="quiet" onPress={controller.cancel} />
                </Card>
            )}
            <AppButton label="Ask about this step" icon="help" variant="secondary" testID="more-ask" onPress={onAsk} />
            {answer === null ? null : (
                <AnswerPanel
                    answer={answer}
                    session={session}
                    pageUris={state.pageUris}
                    showSource={false}
                    provenance={false}
                    reveal={false}
                />
            )}
            {check === null ? null : (
                <CheckPanel
                    check={check}
                    session={session}
                    pageUris={state.pageUris}
                    showSource={false}
                    provenance={false}
                    reveal={false}
                />
            )}
            {evidence}
            {extraSources}
            <View testID="full-step" style={styles.fullStep}>
                <Heading>The full step</Heading>
                <StepLayout
                    session={session}
                    index={entry.stepIndex}
                    result={answer ?? check}
                    pageUris={state.pageUris}
                />
                <StepDetails session={session} index={entry.stepIndex} showHeading={false} />
                <SourceDiagrams refs={instructionRefs} session={session} pageUris={state.pageUris} fit="page" />
            </View>
            <Stack gap="sm">
                <Heading>All steps</Heading>
                <ProgressBar
                    label="Steps marked complete"
                    value={entry.completedStepIds.length}
                    total={session.reviewedSteps.length}
                />
                <StepList steps={stepItems} />
                <View style={styles.row}>
                    <View style={styles.cell}>
                        <AppButton
                            label="Previous step"
                            icon="chevronLeft"
                            disabled={busy || entry.stepIndex === 0}
                            onPress={(): void => {
                                void controller.step(entry.stepIndex - 1)
                            }}
                        />
                    </View>
                    <View style={styles.cell}>
                        <AppButton
                            label="Next step"
                            icon="chevronRight"
                            disabled={busy || last}
                            onPress={(): void => {
                                void controller.step(entry.stepIndex + 1)
                            }}
                        />
                    </View>
                </View>
                <AppButton
                    label="Mark step complete myself"
                    variant="quiet"
                    disabled={busy}
                    onPress={(): void => {
                        if (last) {
                            void nav.finish()
                        } else {
                            void controller.completeStep()
                        }
                    }}
                />
            </Stack>
            <Stack gap="xs">
                <Heading>About photos</Heading>
                <Caption>{PRIVACY_COPY.check}</Caption>
                <Caption>{PRIVACY_COPY.ask}</Caption>
                <AppButton label="All builds" variant="quiet" onPress={nav.allBuilds} />
                <ShowTipsAgainRow onClose={onClose} />
                <AboutThisCheck result={answer ?? check ?? undefined}>
                    <DemoControls
                        session={session}
                        stepIndex={entry.stepIndex}
                        completedStepIds={entry.completedStepIds}
                        locked={busy || session.reviewStatus !== 'reviewed'}
                        onSelectStep={(index): void => {
                            void controller.step(index)
                        }}
                    />
                </AboutThisCheck>
            </Stack>
        </Stack>
    )
}

const styles = StyleSheet.create({
    flex: { flex: 1 },
    sentenceRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    sentenceText: { flex: 1 },
    resultIcon: {
        width: RESULT_SIZE,
        height: RESULT_SIZE,
        borderRadius: radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dimmed: { opacity: 0.45 },
    heroFrame: { overflow: 'hidden' },
    cue: { paddingHorizontal: space.md, paddingTop: space.xs },
    fullStep: { gap: space.xs },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    cell: { flexGrow: 1, flexBasis: 0, minWidth: 150 },
})
