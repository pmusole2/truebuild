import type {
    ApiResult,
    CaptureBinding,
    CheckResult,
    ManualSession,
    ManualStep,
    QuestionResult,
    QuestionTarget,
} from '@truebuild/contracts'
import { useEffect, useMemo, useReducer, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Rect as SvgRect } from 'react-native-svg'
import { ModelApiClient } from '../../api/model-client'
import { contentMaxWidth, fonts, palette, space } from '../../components/theme'
import { ActionButton, FIXTURE_LABEL, Notice, Panel, Segmented, SectionTitle, Tag } from '../../components/ui'
import { modelConnectionStore, useModelConnection } from '../connection/connection-store'
import { SourceView } from '../manuals/source-view'
import type { StoredPageAsset } from '../../storage/manual-store.types'
import { isDemoSession } from '../manuals/workspace-state'
import {
    canRunCheck,
    checkReducer,
    createCheckState,
    type CheckMode,
    type RunCheck,
    type Scenario,
} from './check-state'
import { FrozenPhoto } from './frozen-photo'
import { boxOnDisplay, type Point, type Rect } from './frame-geometry'
import { LocalizationPanel } from './localization-panel'
import { createLocalizationState, localizationReady, localizationReducer } from './localization-state'
import { locateInPhoto } from './localize'
import { askModelQuestion, runModelCheck as defaultRunModelCheck, type RunModelCheck } from './model-check'
import type { Observation } from './observation'
import { ObservationPanel } from './observation-panel'
import { freshCaptureId, freshRequestId } from './identity'
import { QuestionPanel } from './question-panel'
import { createQuestionState, questionReady, questionReducer, stepPartChoices } from './question-state'

type AssemblyScreenProps = {
    readonly session: ManualSession
    readonly step: ManualStep
    readonly runCheck: RunCheck
    readonly onBack: () => void
    // Injected by the route from local storage. Absent in tests and demos, where no page image can be sent.
    readonly loadPageAsset?: (assetId: string) => Promise<StoredPageAsset | null>
    readonly runModelCheck?: RunModelCheck
}

const MODE_OPTIONS: ReadonlyArray<{ value: CheckMode; label: string }> = [
    { value: 'fixture', label: 'Simulated (fixture)' },
    { value: 'model', label: 'Live model' },
]

const SCENARIO_OPTIONS: ReadonlyArray<{ value: Scenario; label: string }> = [
    { value: 'correct', label: 'Correct' },
    { value: 'wrong', label: 'Wrong' },
    { value: 'unclear', label: 'Unclear' },
]

const DECISION_TEXT: Record<CheckResult['decision'], string> = {
    pass: 'Pass',
    refuse: 'Refuse',
    cannot_verify: 'Cannot verify',
}

const UNAVAILABLE_TEXT: Record<string, string> = {
    unconfigured: 'Live checks are not configured in this build. No request was sent and no model was called.',
    invalid_input:
        'The fixture check only accepts the built-in demo at revision 1. This is not a verdict on your assembly.',
    budget_exhausted: 'The check budget is used up. This is not a pass or a mistake.',
    duplicate_request: 'This check was already sent. Wait for its result.',
}

const LIVE_UNAVAILABLE_TEXT: Record<string, string> = {
    unconfigured: 'Live checks are not configured. No request was sent and no model was called.',
    unauthorized: 'The owner token was rejected. Reconnect on the connection screen.',
    invalid_input:
        'This step cannot be sent to the live check. It must cite one or two saved pages, and the photo must be a supported image.',
    timeout: 'The live check timed out. This is not a pass or a mistake; try again.',
    budget_exhausted: 'The check budget is used up. This is not a pass or a mistake.',
}

function unavailableText(code: string, mode: CheckMode): string {
    if (mode === 'model') {
        return LIVE_UNAVAILABLE_TEXT[code] ?? 'Could not check. This is not a pass or a mistake.'
    }
    return UNAVAILABLE_TEXT[code] ?? 'Could not check. This is not a pass or a mistake.'
}

function describeStep(step: ManualStep): string[] {
    const lines: string[] = []
    if (step.orientation.state === 'known') {
        lines.push(`Orientation: ${step.orientation.value.description}`)
    }
    if (step.connection.state === 'known') {
        lines.push(`Connection: ${step.connection.value.description}`)
    }
    return lines
}

async function noStoredAsset(): Promise<StoredPageAsset | null> {
    return null
}

/** Whole percent for display; the normalized value is the source of truth. */
function percent(value: number): string {
    return `${Math.round(value * 100)}%`
}

// Stopping work for a rejected token clears the connection. The connection store refuses if it was replaced meanwhile.
function dropConnectionIfUnauthorized(outcome: ApiResult<unknown>, startedGeneration: number): void {
    if (outcome.status === 'unavailable' && outcome.code === 'unauthorized') {
        modelConnectionStore.clearIfCurrent(startedGeneration)
    }
}

export function AssemblyScreen({
    session,
    step,
    runCheck,
    onBack,
    loadPageAsset = noStoredAsset,
    runModelCheck = defaultRunModelCheck,
}: AssemblyScreenProps): ReactElement {
    const demo = isDemoSession(session)
    const reviewed = session.reviewStatus === 'reviewed'
    const cited =
        session.pages.find((page) => step.sourceRefs.some((ref) => ref.pageId === page.pageId)) ?? session.pages[0]
    const connection = useModelConnection()
    const generation = connection?.generation ?? 0
    const client = useMemo<ModelApiClient | null>(() => {
        if (connection === null) {
            return null
        }
        try {
            return new ModelApiClient({ baseUrl: connection.origin, token: connection.token })
        } catch {
            return null
        }
        // Keyed on the connection identity so a replaced token never reuses the old client.
    }, [connection])

    // Every physical observation, retake and correction recheck gets a new identity, unique across mounts.
    const [captureId, setCaptureId] = useState<string>(freshCaptureId)
    const binding = useMemo<CaptureBinding>(
        () => ({
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: step.stepId,
            captureId,
        }),
        [session.manualId, session.revision, step.stepId, captureId],
    )
    // The frozen photo belongs to exactly one capture; a new capture always replaces it.
    const [observation, setObservation] = useState<Observation | null>(null)

    const [state, dispatch] = useReducer(checkReducer, binding, createCheckState)
    const [questionState, questionDispatch] = useReducer(questionReducer, binding, createQuestionState)
    const [localState, localDispatch] = useReducer(localizationReducer, binding, createLocalizationState)
    const checkControllerRef = useRef<AbortController | null>(null)
    const questionControllerRef = useRef<AbortController | null>(null)
    const localizeControllerRef = useRef<AbortController | null>(null)
    // Synchronous single-flight guards that hold the request id they admitted, so a finished request only releases its own slot.
    const checkInFlightRef = useRef<string | null>(null)
    const questionInFlightRef = useRef<string | null>(null)
    const localizeInFlightRef = useRef<string | null>(null)

    // One invalidation path: abort every in-flight action and release its single-flight slot.
    function abortAll(): void {
        checkControllerRef.current?.abort()
        questionControllerRef.current?.abort()
        localizeControllerRef.current?.abort()
        checkInFlightRef.current = null
        questionInFlightRef.current = null
        localizeInFlightRef.current = null
    }

    // A different capture or step drops every old result and aborts the requests still in flight for it.
    useEffect(() => {
        dispatch({ type: 'bindingSynced', binding })
        questionDispatch({ type: 'bindingSynced', binding })
        localDispatch({ type: 'bindingSynced', binding })
        return (): void => abortAll()
    }, [binding])

    // A connection replaced or cleared is a new identity: its verdicts, answers and boxes are stale.
    useEffect(() => {
        dispatch({ type: 'invalidated' })
        questionDispatch({ type: 'invalidated' })
        localDispatch({ type: 'invalidated' })
        return (): void => abortAll()
    }, [generation])

    // Switching between simulated and live aborts every operation and clears subordinate state.
    function changeMode(mode: CheckMode): void {
        abortAll()
        dispatch({ type: 'modeChanged', mode })
        questionDispatch({ type: 'invalidated' })
        localDispatch({ type: 'invalidated' })
    }

    const parts = useMemo(() => stepPartChoices(session, step), [session, step])
    const modelReady = client !== null && observation !== null && reviewed
    const modelSelected = state.mode === 'model'
    const result = state.result

    function takeObservation(next: Observation): void {
        setObservation(next)
        setCaptureId(freshCaptureId())
    }

    async function run(): Promise<void> {
        if (checkInFlightRef.current !== null || !canRunCheck(state, reviewed)) {
            return
        }
        // Live mode without a connection keeps the existing path: the fixture runner reports unconfigured, no I/O.
        const live = state.mode === 'model' && client !== null
        if (live && !modelReady) {
            return
        }
        const requestId = freshRequestId('check')
        const startedGeneration = generation
        const requestBinding = binding
        const controller = new AbortController()
        checkInFlightRef.current = requestId
        checkControllerRef.current = controller
        dispatch({ type: 'checkStarted', requestId })
        try {
            const outcome: ApiResult<CheckResult> =
                live && observation !== null
                    ? await runModelCheck({
                          client,
                          requestId,
                          binding: requestBinding,
                          session,
                          step,
                          observation,
                          loadPageAsset,
                          signal: controller.signal,
                      })
                    : await runCheck(
                          { mode: state.mode, requestId, binding: requestBinding, scenario: state.scenario },
                          controller.signal,
                      )
            if (live) {
                dropConnectionIfUnauthorized(outcome, startedGeneration)
            }
            dispatch({ type: 'checkFinished', requestId, binding: requestBinding, result: outcome })
        } catch {
            if (controller.signal.aborted) {
                dispatch({ type: 'checkAborted', requestId })
                return
            }
            dispatch({
                type: 'checkFinished',
                requestId,
                binding: requestBinding,
                result: {
                    status: 'unavailable',
                    requestId,
                    binding: requestBinding,
                    code: 'provider_error',
                    retryable: true,
                },
            })
        } finally {
            if (checkInFlightRef.current === requestId) {
                checkInFlightRef.current = null
            }
        }
    }

    function stopQuestion(): void {
        questionControllerRef.current?.abort()
        questionInFlightRef.current = null
    }

    function setQuestion(question: string): void {
        stopQuestion()
        questionDispatch({ type: 'questionChanged', question })
    }

    function setTarget(target: QuestionTarget | null): void {
        stopQuestion()
        questionDispatch({ type: 'targetChanged', target })
    }

    async function ask(): Promise<void> {
        if (questionInFlightRef.current !== null || client === null || observation === null || !reviewed) {
            return
        }
        if (!questionReady(questionState) || questionState.target === null) {
            return
        }
        const requestId = freshRequestId('question')
        const startedGeneration = generation
        const requestBinding = binding
        const controller = new AbortController()
        questionInFlightRef.current = requestId
        questionControllerRef.current = controller
        questionDispatch({ type: 'started', requestId })
        try {
            const outcome: ApiResult<QuestionResult> = await askModelQuestion({
                client,
                requestId,
                binding: requestBinding,
                session,
                step,
                observation,
                question: questionState.question.trim(),
                target: questionState.target,
                loadPageAsset,
                signal: controller.signal,
            })
            dropConnectionIfUnauthorized(outcome, startedGeneration)
            questionDispatch({ type: 'finished', requestId, binding: requestBinding, result: outcome })
        } catch {
            questionDispatch(
                controller.signal.aborted
                    ? { type: 'aborted', requestId }
                    : {
                          type: 'finished',
                          requestId,
                          binding: requestBinding,
                          result: {
                              status: 'unavailable',
                              requestId,
                              binding: requestBinding,
                              code: 'provider_error',
                              retryable: true,
                          },
                      },
            )
        } finally {
            if (questionInFlightRef.current === requestId) {
                questionInFlightRef.current = null
            }
        }
    }

    function setPrompt(prompt: string): void {
        localizeControllerRef.current?.abort()
        localizeInFlightRef.current = null
        localDispatch({ type: 'promptChanged', prompt })
    }

    async function locate(): Promise<void> {
        if (localizeInFlightRef.current !== null || client === null || observation === null || !reviewed) {
            return
        }
        if (!localizationReady(localState)) {
            return
        }
        const requestId = freshRequestId('locate')
        const startedGeneration = generation
        const requestBinding = binding
        const controller = new AbortController()
        localizeInFlightRef.current = requestId
        localizeControllerRef.current = controller
        localDispatch({ type: 'started', requestId })
        try {
            for await (const event of locateInPhoto({
                client,
                requestId,
                binding: requestBinding,
                prompt: localState.prompt.trim(),
                observation,
                signal: controller.signal,
            })) {
                dropConnectionIfUnauthorized(event, startedGeneration)
                localDispatch({ type: 'received', requestId, result: event })
                if (controller.signal.aborted) {
                    break
                }
            }
        } catch {
            localDispatch({ type: 'aborted', requestId })
        } finally {
            if (localizeInFlightRef.current === requestId) {
                localizeInFlightRef.current = null
            }
        }
    }

    // Shows only a confirmed correction; a model-proposed or unconfirmed one never reads as the reviewed procedure.
    const showCorrection =
        result !== null &&
        result.status === 'ok' &&
        result.value.decision !== 'pass' &&
        step.correction !== null &&
        step.correction.reviewed
    const pending = state.pendingRequestId !== null

    // Human-facing reasons for a disabled model action; null means the action is available.
    const liveDisabledReason =
        client === null
            ? 'Connect a live backend on the connection screen first. Without a connection no request is sent and no model is called.'
            : observation === null
              ? 'Choose or capture a fresh photo of the assembly first. Source pages are never used as the photo.'
              : !reviewed
                ? 'Mark the manual reviewed before a live check or question can run.'
                : null

    const observedRegion = result !== null && result.status === 'ok' ? result.value.observedRegion : null
    const citedRegions =
        result !== null && result.status === 'ok' && cited !== undefined
            ? result.value.sourceRefs.flatMap((ref) =>
                  ref.pageId === cited.pageId && ref.region !== null ? [ref.region] : [],
              )
            : []
    const citedPageNumbers =
        result !== null && result.status === 'ok'
            ? [...new Set(result.value.sourceRefs.map((ref) => ref.pageId))].map(
                  (pageId) => session.pages.findIndex((page) => page.pageId === pageId) + 1,
              )
            : []

    const highlights = [
        ...step.sourceRefs.flatMap((ref) =>
            cited !== undefined && ref.pageId === cited.pageId && ref.region !== null ? [ref.region] : [],
        ),
        ...citedRegions,
    ]

    const localizeOverlay = (displayed: Rect): ReactNode => (
        <>
            {localState.boxes.map((item, index) => {
                const rect = boxOnDisplay(item.box, displayed)
                return (
                    <SvgRect
                        key={`${item.label}-${index}`}
                        x={rect.x}
                        y={rect.y}
                        width={rect.width}
                        height={rect.height}
                        stroke={palette.signal}
                        strokeWidth={2}
                        fill="none"
                    />
                )
            })}
            {observedRegion === null ? null : (
                <SvgRect
                    key="check-region"
                    x={boxOnDisplay(observedRegion, displayed).x}
                    y={boxOnDisplay(observedRegion, displayed).y}
                    width={boxOnDisplay(observedRegion, displayed).width}
                    height={boxOnDisplay(observedRegion, displayed).height}
                    stroke={palette.charcoal}
                    strokeWidth={2}
                    strokeDasharray={[6, 4]}
                    fill="none"
                />
            )}
        </>
    )

    return (
        <ScrollView contentContainerStyle={styles.page}>
            <View style={styles.inner}>
                <ActionButton label="Back to manual" onPress={onBack} />
                <View style={styles.headerRow}>
                    <Text style={styles.stepNumber}>Step {step.order}</Text>
                    <Tag tone={reviewed ? 'reviewed' : 'unreviewed'} text={reviewed ? 'Reviewed' : 'Unreviewed'} />
                    {demo ? <Tag tone="simulated" text={FIXTURE_LABEL} /> : null}
                </View>
                <Text accessibilityRole="header" style={styles.title}>
                    {step.title}
                </Text>

                {cited === undefined ? null : (
                    <Panel>
                        <SectionTitle>Source diagram</SectionTitle>
                        <SourceView
                            page={cited}
                            isDemo={demo}
                            highlights={highlights}
                            caption="Manual source — not a photo of your assembly"
                        />
                    </Panel>
                )}

                <Panel>
                    <SectionTitle>Instructions</SectionTitle>
                    {describeStep(step).map((line) => (
                        <Text key={line} style={styles.body}>
                            {line}
                        </Text>
                    ))}
                    {step.visibleChecks.map((check) => (
                        <Text key={check.checkId} style={styles.body}>
                            Check:{' '}
                            {check.description.state === 'known' ? check.description.value : 'wording not confirmed'}
                        </Text>
                    ))}
                    <Notice text="Browsing these instructions does not verify the assembly." />
                </Panel>

                <Panel>
                    <SectionTitle>Check</SectionTitle>
                    {reviewed ? null : (
                        <Notice tone="caution" text="Mark the manual reviewed before a check can run." />
                    )}
                    <Segmented label="Check mode" options={MODE_OPTIONS} value={state.mode} onChange={changeMode} />
                    {state.mode === 'fixture' ? (
                        <>
                            <Notice
                                tone="caution"
                                text={`${FIXTURE_LABEL}. No photo is analysed. The selected outcome is what the simulation returns.`}
                            />
                            <Segmented
                                label="Simulated observation"
                                options={SCENARIO_OPTIONS}
                                value={state.scenario}
                                onChange={(scenario) => dispatch({ type: 'scenarioChanged', scenario })}
                            />
                        </>
                    ) : (
                        <Notice
                            text={
                                client === null
                                    ? 'Live checks need a connected backend. Running is disabled until you connect on the connection screen.'
                                    : 'Live check sends the cited pages of this step and the photo below to the connected backend. Nothing is sent until you press Run check.'
                            }
                        />
                    )}
                    {modelSelected ? (
                        <>
                            <ObservationPanel disabled={client === null} onObservation={takeObservation} />
                            {observation === null ? null : (
                                <FrozenPhoto
                                    observation={observation}
                                    caption="Photo of your assembly — one frozen capture. Not a manual page."
                                    onTapPoint={
                                        reviewed
                                            ? (point: Point): void =>
                                                  setTarget({ kind: 'point', x: point.x, y: point.y })
                                            : undefined
                                    }
                                    overlay={localizeOverlay}
                                />
                            )}
                        </>
                    ) : null}
                    <ActionButton
                        label={pending ? 'Checking…' : 'Run check'}
                        tone="primary"
                        disabled={!canRunCheck(state, reviewed) || (modelSelected && client !== null && !modelReady)}
                        onPress={() => void run()}
                    />
                    {modelSelected && liveDisabledReason !== null ? (
                        <Notice tone="caution" text={liveDisabledReason} />
                    ) : null}
                </Panel>

                {result === null ? null : (
                    <Panel>
                        <SectionTitle>Result</SectionTitle>
                        {result.status === 'ok' ? (
                            <>
                                <Tag
                                    tone={result.mode === 'fixture' ? 'simulated' : 'unreviewed'}
                                    text={result.mode === 'fixture' ? FIXTURE_LABEL : 'Live model'}
                                />
                                <Text style={styles.decision}>
                                    {DECISION_TEXT[result.value.decision]}
                                    {result.mode === 'fixture' ? ' (simulated)' : ''}
                                </Text>
                                <Text style={styles.body}>{result.value.reason}</Text>
                                {citedPageNumbers.length === 0 ? null : (
                                    <Text style={styles.body}>
                                        Cited manual {citedPageNumbers.length === 1 ? 'page' : 'pages'}:{' '}
                                        {citedPageNumbers.map((number) => `page ${number}`).join(', ')}
                                        {citedRegions.length === 0 ? '' : ' (region highlighted on the source diagram)'}
                                    </Text>
                                )}
                                {observedRegion === null ? null : (
                                    <Text style={styles.body}>
                                        Observed region on the photo (dashed outline): left {percent(observedRegion.x)},
                                        top {percent(observedRegion.y)}, width {percent(observedRegion.width)}, height{' '}
                                        {percent(observedRegion.height)}.
                                    </Text>
                                )}
                                {result.value.missingEvidence.map((item) => (
                                    <Text key={item} style={styles.body}>
                                        Missing: {item}
                                    </Text>
                                ))}
                            </>
                        ) : (
                            <>
                                {state.mode === 'fixture' ? <Tag tone="simulated" text={FIXTURE_LABEL} /> : null}
                                <Notice tone="error" text={unavailableText(result.code, state.mode)} />
                            </>
                        )}
                        {showCorrection && step.correction !== null ? (
                            <View style={styles.correction}>
                                <SectionTitle>Confirmed correction</SectionTitle>
                                {step.correction.actions.map((action) => (
                                    <Text key={action.actionId} style={styles.body}>
                                        {action.instruction}
                                    </Text>
                                ))}
                                <ActionButton
                                    label="Mark correction applied"
                                    onPress={() => {
                                        setObservation(null)
                                        setCaptureId(freshCaptureId())
                                    }}
                                />
                                <Notice text="Run a fresh check after correcting. The previous result no longer applies." />
                            </View>
                        ) : null}
                    </Panel>
                )}

                {modelSelected && observation !== null ? (
                    <>
                        <QuestionPanel
                            session={session}
                            state={questionState}
                            parts={parts}
                            ready={modelReady && questionReady(questionState)}
                            disabledReason={liveDisabledReason}
                            onQuestionChange={setQuestion}
                            onPartTarget={(partId) => setTarget({ kind: 'part', partId })}
                            onClearTarget={() => setTarget(null)}
                            onAsk={() => void ask()}
                        />
                        <LocalizationPanel
                            state={localState}
                            ready={modelReady && localizationReady(localState)}
                            disabledReason={liveDisabledReason}
                            onPromptChange={setPrompt}
                            onLocate={() => void locate()}
                        />
                    </>
                ) : null}
            </View>
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    page: {
        padding: space.md,
        alignItems: 'center',
    },
    inner: {
        width: '100%',
        maxWidth: contentMaxWidth,
        gap: space.md,
    },
    headerRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: space.xs,
    },
    stepNumber: {
        color: palette.signalInk,
        fontWeight: '700',
        fontSize: 16,
    },
    title: {
        color: palette.charcoal,
        fontFamily: fonts.display,
        fontSize: 24,
        fontWeight: '700',
    },
    body: {
        color: palette.charcoal,
        fontSize: 15,
        lineHeight: 22,
    },
    decision: {
        color: palette.charcoal,
        fontFamily: fonts.display,
        fontSize: 22,
        fontWeight: '700',
    },
    correction: {
        gap: space.sm,
        paddingTop: space.sm,
    },
})
