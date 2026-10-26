import { useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from 'react'
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native'
import Svg, { Rect } from 'react-native-svg'
import {
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type ManualSession,
    type ManualStep,
    type QuestionResult,
} from '@truebuild/contracts'
import { BoundedApiClient } from '../api/client'
import { ModelApiClient } from '../api/model-client'
import { ActionButton, Notice, Panel, SectionTitle, Tag } from '../components/ui'
import { palette, radius, space } from '../components/theme'
import { askModelQuestion, runModelCheck, type SourcePageAsset } from '../features/assembly/model-check'
import { checkReducer, createCheckState, type Scenario } from '../features/assembly/check-state'
import { FrozenPhoto } from '../features/assembly/frozen-photo'
import { freshCaptureId, freshRequestId } from '../features/assembly/identity'
import {
    localizationReducer,
    createLocalizationState,
    localizationReady,
} from '../features/assembly/localization-state'
import { locateInPhoto } from '../features/assembly/localize'
import { LocalizationPanel } from '../features/assembly/localization-panel'
import {
    captureObservation,
    observationForSegmentation,
    type CaptureResult,
    type Observation,
} from '../features/assembly/observation'
import { QuestionPanel } from '../features/assembly/question-panel'
import {
    createQuestionState,
    questionReady,
    questionReducer,
    stepPartChoices,
} from '../features/assembly/question-state'
import { bytesToDataUri } from '../media/image-source'
import { userMessageForMediaError } from '../media/media-errors'
import { PlanSummary } from './plan-summary'
import { SAMPLE_MANUAL_LABEL, confirmParsedPlan, sampleManual, unknownCriticalFacts } from './sample-manual'
import { parseManualPhoto, type ParseOutcome, type ParseRuntime } from './parse-photo'

export type DemoRuntime = ParseRuntime

type Capture = {
    readonly binding: CaptureBinding
    readonly observation: Observation | null
    readonly scenario: Scenario
}

type PlanOrigin = 'sample' | 'parsed'

const SIMULATED_PHOTOS: readonly { readonly scenario: Scenario; readonly label: string }[] = [
    { scenario: 'correct', label: 'Simulated correct photo' },
    { scenario: 'wrong', label: 'Simulated reversed panel' },
    { scenario: 'unclear', label: 'Simulated unclear photo' },
]

const CAMERA_DENIED = 'Camera access was not allowed. Allow the camera in Settings, or try again.'

function unavailableText(code: string): string {
    return `Unavailable (${code}). Nothing was shown as a result.`
}

/**
 * Direct demo: manual (photographed or synthetic sample) → confirmed plan → step → photo → check (pass, refuse or
 * cannot_verify) → Ask → part search on the frozen photo.
 *
 * Every context change (step, plan, photo, unmount) invalidates the visible verdict, answer and boxes at once and aborts
 * in-flight work. A completion from an earlier context is discarded instead of published.
 */
export function DemoScreen({ runtime }: { readonly runtime: DemoRuntime }): ReactElement {
    const simulated = runtime.mode === 'fixture'
    const [plan, setPlan] = useState<ManualSession | null>(simulated ? sampleManual() : null)
    const [origin, setOrigin] = useState<PlanOrigin | null>(simulated ? 'sample' : null)
    const [planSources, setPlanSources] = useState<readonly SourcePageAsset[]>([])
    const [parseOutcome, setParseOutcome] = useState<ParseOutcome | null>(null)
    const [parsing, setParsing] = useState(false)
    const [planMessage, setPlanMessage] = useState<string | null>(null)
    const [stepId, setStepId] = useState<string | null>(
        simulated ? (sampleManual().reviewedSteps[0]?.stepId ?? null) : null,
    )
    const [capture, setCapture] = useState<Capture | null>(null)
    const [photoMessage, setPhotoMessage] = useState<string | null>(null)
    const [photoPending, setPhotoPending] = useState(false)

    const emptyBinding: CaptureBinding = {
        kind: 'capture',
        manualId: plan?.manualId ?? 'none',
        revision: plan?.revision ?? 1,
        stepId: 'none',
        captureId: 'none',
    }
    const [check, dispatchCheck] = useReducer(checkReducer, emptyBinding, (binding) => ({
        ...createCheckState(binding),
        mode: runtime.mode,
    }))
    const [question, dispatchQuestion] = useReducer(questionReducer, emptyBinding, createQuestionState)
    const [locate, dispatchLocate] = useReducer(localizationReducer, emptyBinding, createLocalizationState)

    // The plan scope covers step, plan, photo, check, question and part search. Starting any new context aborts it.
    // The parse scope covers only the photographed-manual request; a sample choice or confirmation also aborts it.
    const scopeRef = useRef(new AbortController())
    const parseScopeRef = useRef<AbortController | null>(null)

    useEffect(() => {
        // StrictMode runs effects twice; a scope aborted by the previous cleanup must not stay dead.
        if (scopeRef.current.signal.aborted) {
            scopeRef.current = new AbortController()
        }
        return (): void => {
            scopeRef.current.abort()
            parseScopeRef.current?.abort()
        }
    }, [])

    const steps: readonly ManualStep[] = plan?.reviewedSteps ?? []
    const step = steps.find((candidate) => candidate.stepId === stepId) ?? steps[0] ?? null
    const parts = plan !== null && step !== null ? stepPartChoices(plan, step) : []
    const sourcesById = useMemo(() => new Map(planSources.map((source) => [source.assetId, source])), [planSources])
    const loadPageAsset = async (assetId: string): Promise<SourcePageAsset | null> => sourcesById.get(assetId) ?? null

    const modelClient = useMemo(
        () => new ModelApiClient({ baseUrl: runtime.baseUrl, secret: runtime.secret, fetch: runtime.fetch }),
        [runtime.baseUrl, runtime.secret, runtime.fetch],
    )
    const fixtureClient = useMemo(
        () =>
            new BoundedApiClient({
                baseUrl: runtime.baseUrl,
                mode: 'fixture',
                secret: runtime.secret,
                fetch: runtime.fetch,
            }),
        [runtime.baseUrl, runtime.secret, runtime.fetch],
    )

    const actionReady = plan !== null && step !== null && capture !== null
    const unavailableReason =
        plan === null
            ? 'Photograph a manual, or use the sample manual, then confirm the plan.'
            : step === null
              ? 'Pick a step first.'
              : capture === null
                ? 'Take a photo of the assembly for this step first.'
                : null

    /** Starts a new plan-level context: aborts all in-flight work and clears every visible verdict, answer and box. */
    function beginContext(): AbortController {
        scopeRef.current.abort()
        const next = new AbortController()
        scopeRef.current = next
        dispatchCheck({ type: 'invalidated' })
        dispatchQuestion({ type: 'invalidated' })
        dispatchLocate({ type: 'invalidated' })
        setCapture(null)
        setPhotoMessage(null)
        setPhotoPending(false)
        return next
    }

    async function photographManual(): Promise<void> {
        parseScopeRef.current?.abort()
        const controller = new AbortController()
        parseScopeRef.current = controller
        setParsing(true)
        setPlanMessage(null)
        setParseOutcome(null)
        const outcome = await parseManualPhoto(runtime, controller.signal)
        if (controller.signal.aborted) {
            return
        }
        setParsing(false)
        if (outcome.status === 'cancelled') {
            return
        }
        if (outcome.status === 'denied') {
            setPlanMessage(CAMERA_DENIED)
            return
        }
        if (outcome.status === 'failed') {
            setPlanMessage(outcome.message)
            return
        }
        setParseOutcome(outcome)
    }

    function useSampleManual(): void {
        parseScopeRef.current?.abort()
        beginContext()
        const sample = sampleManual()
        setPlan(sample)
        setPlanSources([])
        setOrigin('sample')
        setParseOutcome(null)
        setParsing(false)
        setPlanMessage(null)
        setStepId(sample.reviewedSteps[0]?.stepId ?? null)
    }

    function confirmPlan(): void {
        if (parseOutcome?.status !== 'parsed') {
            return
        }
        const outcome = confirmParsedPlan(plan, parseOutcome.parsed, parseOutcome.pages, parseOutcome.binding)
        if (outcome.status === 'blocked') {
            setPlanMessage(`Not confirmed. Resolve these first; nothing was filled in: ${outcome.unknowns.join('; ')}`)
            return
        }
        parseScopeRef.current?.abort()
        beginContext()
        setPlan(outcome.session)
        setPlanSources(parseOutcome.sources)
        setOrigin('parsed')
        setParseOutcome(null)
        setStepId(outcome.session.reviewedSteps[0]?.stepId ?? null)
        setPlanMessage('Plan confirmed. Model corrections were not applied; check each step against the manual.')
    }

    function selectStep(nextStepId: string): void {
        if (nextStepId === step?.stepId) {
            return
        }
        beginContext()
        setStepId(nextStepId)
    }

    async function takeCapture(source: Scenario | 'camera' | 'library'): Promise<void> {
        if (plan === null || step === null) {
            return
        }
        const session = plan
        const target = step
        const scope = beginContext()
        if (source === 'camera' || source === 'library') {
            setPhotoPending(true)
            let captured: CaptureResult
            try {
                captured = await captureObservation(source)
            } catch (error: unknown) {
                if (!scope.signal.aborted) {
                    setPhotoPending(false)
                    setPhotoMessage(userMessageForMediaError(error))
                }
                return
            }
            // A camera or library return can arrive after the step or plan changed; it must not overwrite the newer one.
            if (scope.signal.aborted) {
                return
            }
            setPhotoPending(false)
            if (captured.status === 'cancelled') {
                return
            }
            if (captured.status === 'denied') {
                setPhotoMessage(CAMERA_DENIED)
                return
            }
            publishCapture(session, target, captured.observation, 'correct', scope)
            return
        }
        publishCapture(session, target, null, source, scope)
    }

    function publishCapture(
        session: ManualSession,
        target: ManualStep,
        observation: Observation | null,
        scenario: Scenario,
        scope: AbortController,
    ): void {
        const binding: CaptureBinding = {
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: target.stepId,
            captureId: freshCaptureId(),
        }
        const next: Capture = { binding, observation, scenario }
        setCapture(next)
        dispatchCheck({ type: 'bindingSynced', binding })
        dispatchQuestion({ type: 'bindingSynced', binding })
        dispatchLocate({ type: 'bindingSynced', binding })
        void runCheckFor(next, session, target, scope)
    }

    async function runCheckFor(
        current: Capture,
        session: ManualSession,
        target: ManualStep,
        scope: AbortController,
    ): Promise<void> {
        const requestId = freshRequestId('check')
        dispatchCheck({ type: 'checkStarted', requestId })
        let result: ApiResult<CheckResult>
        try {
            result =
                runtime.mode === 'fixture'
                    ? await fixtureClient.check(current.binding, current.scenario, { requestId, signal: scope.signal })
                    : current.observation === null
                      ? {
                            status: 'unavailable',
                            requestId,
                            binding: current.binding,
                            code: 'invalid_input',
                            retryable: false,
                        }
                      : await runModelCheck({
                            client: modelClient,
                            requestId,
                            binding: current.binding,
                            session,
                            step: target,
                            observation: current.observation,
                            loadPageAsset,
                            signal: scope.signal,
                        })
        } catch {
            result = {
                status: 'unavailable',
                requestId,
                binding: current.binding,
                code: 'provider_error',
                retryable: true,
            }
        }
        if (scope.signal.aborted) {
            return
        }
        dispatchCheck({ type: 'checkFinished', requestId, binding: current.binding, result })
    }

    async function askQuestion(): Promise<void> {
        if (plan === null || step === null || capture === null || question.target === null) {
            return
        }
        const scope = scopeRef.current
        const requestId = freshRequestId('question')
        dispatchQuestion({ type: 'started', requestId })
        const binding = capture.binding
        const target = question.target
        const text = question.question.trim()
        let result: ApiResult<QuestionResult>
        try {
            result =
                runtime.mode === 'fixture'
                    ? await fixtureClient.questions(binding, text, target, { requestId, signal: scope.signal })
                    : capture.observation === null
                      ? { status: 'unavailable', requestId, binding, code: 'invalid_input', retryable: false }
                      : await askModelQuestion({
                            client: modelClient,
                            requestId,
                            binding,
                            session: plan,
                            step,
                            observation: capture.observation,
                            question: text,
                            target,
                            loadPageAsset,
                            signal: scope.signal,
                        })
        } catch {
            result = { status: 'unavailable', requestId, binding, code: 'provider_error', retryable: true }
        }
        if (scope.signal.aborted) {
            return
        }
        dispatchQuestion({ type: 'finished', requestId, binding, result })
    }

    async function locatePart(): Promise<void> {
        if (plan === null || capture === null) {
            return
        }
        const scope = scopeRef.current
        const requestId = freshRequestId('locate')
        dispatchLocate({ type: 'started', requestId })
        const binding = capture.binding
        const prompt = locate.prompt.trim()
        const failed = (code: 'invalid_input' | 'provider_error'): void =>
            dispatchLocate({
                type: 'received',
                requestId,
                result: { status: 'unavailable', requestId, binding, code, retryable: code === 'provider_error' },
            })

        if (runtime.mode === 'fixture') {
            try {
                const result = await fixtureClient.segments(binding, 'normal', { requestId, signal: scope.signal })
                if (scope.signal.aborted) {
                    return
                }
                if (result.status !== 'ok') {
                    dispatchLocate({ type: 'received', requestId, result })
                    return
                }
                for (const event of result.value.events) {
                    dispatchLocate({ type: 'received', requestId, result: { ...result, value: event } })
                }
            } catch {
                failed('provider_error')
            }
            return
        }
        if (capture.observation === null) {
            failed('invalid_input')
            return
        }
        try {
            const frozen = await observationForSegmentation(capture.observation)
            if (scope.signal.aborted) {
                return
            }
            for await (const result of locateInPhoto({
                client: modelClient,
                requestId,
                binding,
                prompt,
                observation: frozen,
                signal: scope.signal,
            })) {
                if (scope.signal.aborted) {
                    return
                }
                dispatchLocate({ type: 'received', requestId, result })
            }
        } catch {
            // Preparation failures (for example, a segmentation resize) end the search as unavailable, never pending.
            if (!scope.signal.aborted) {
                failed('invalid_input')
            }
        }
    }

    const checkResult = check.result
    const checkOk = checkResult?.status === 'ok' ? checkResult.value : null
    const citedPageId = checkOk?.sourceRefs[0]?.pageId ?? null
    const citedPage = citedPageId === null ? undefined : plan?.pages.find((page) => page.pageId === citedPageId)
    const citedSource = citedPage === undefined ? undefined : sourcesById.get(citedPage.assetId)
    const unknowns = parseOutcome?.status === 'parsed' ? unknownCriticalFacts(parseOutcome.parsed) : []

    return (
        <ScrollView contentContainerStyle={styles.content}>
            <Notice
                tone={simulated ? 'caution' : 'info'}
                text={
                    simulated
                        ? 'Demo data — simulated results. Photos are simulated and nothing is analysed.'
                        : 'Live backend. Photos are sent to the configured server only when you ask for a check, question or part search.'
                }
            />

            <Panel>
                <SectionTitle>1. Manual</SectionTitle>
                <Text style={styles.body}>
                    {origin === 'sample'
                        ? SAMPLE_MANUAL_LABEL
                        : origin === 'parsed'
                          ? 'Confirmed plan from your photo.'
                          : 'No plan yet.'}
                </Text>
                <ActionButton
                    label={parsing ? 'Reading photo…' : 'Photograph a manual'}
                    tone="primary"
                    disabled={parsing}
                    onPress={() => photographManual()}
                />
                {simulated ? (
                    <ActionButton label="Use sample manual (synthetic fixture)" onPress={useSampleManual} />
                ) : null}
                {parseOutcome?.status === 'parsed' ? (
                    <View style={styles.stack}>
                        <Tag
                            tone={parseOutcome.mode === 'fixture' ? 'simulated' : 'unreviewed'}
                            text={
                                parseOutcome.mode === 'fixture'
                                    ? 'Simulated parse result'
                                    : 'Parsed from your photo · unconfirmed'
                            }
                        />
                        {parseOutcome.mode === 'fixture' ? (
                            <Notice tone="caution" text="Simulated parse result. Your photo was not analysed." />
                        ) : null}
                        <PlanSummary
                            parts={parseOutcome.parsed.parts}
                            steps={parseOutcome.parsed.steps}
                            unknowns={unknowns}
                        />
                        <Notice
                            tone="caution"
                            text="Model corrections are not applied. Only expected facts you confirm are used."
                        />
                        <ActionButton
                            label="Confirm expected facts"
                            tone="primary"
                            disabled={unknowns.length > 0}
                            onPress={confirmPlan}
                        />
                    </View>
                ) : null}
                {planMessage === null ? null : <Notice text={planMessage} />}
            </Panel>

            <Panel>
                <SectionTitle>2. Step</SectionTitle>
                {steps.length === 0 ? <Text style={styles.body}>No confirmed steps yet.</Text> : null}
                {steps.map((candidate) => (
                    <ActionButton
                        key={candidate.stepId}
                        label={`${candidate.order}. ${candidate.title}`}
                        tone={candidate.stepId === step?.stepId ? 'primary' : 'quiet'}
                        onPress={() => selectStep(candidate.stepId)}
                    />
                ))}
                {plan !== null && step !== null ? (
                    <PlanSummary parts={plan.parts} steps={[step]} unknowns={[]} />
                ) : null}
            </Panel>

            <Panel>
                <SectionTitle>3. Photo of the assembly</SectionTitle>
                {simulated ? (
                    <View style={styles.stack}>
                        {SIMULATED_PHOTOS.map((photo) => (
                            <ActionButton
                                key={photo.scenario}
                                label={photo.label}
                                disabled={plan === null || step === null}
                                onPress={() => takeCapture(photo.scenario)}
                            />
                        ))}
                    </View>
                ) : (
                    <View style={styles.stack}>
                        <ActionButton
                            label="Take photo"
                            tone="primary"
                            disabled={plan === null || step === null || photoPending}
                            onPress={() => takeCapture('camera')}
                        />
                        <ActionButton
                            label="Choose photo"
                            disabled={plan === null || step === null || photoPending}
                            onPress={() => takeCapture('library')}
                        />
                    </View>
                )}
                {photoPending ? <Text style={styles.body}>Preparing photo…</Text> : null}
                {photoMessage === null ? null : <Notice tone="error" text={photoMessage} />}
                {unavailableReason === null ? null : <Text style={styles.body}>{unavailableReason}</Text>}
                {capture === null ? null : (
                    <View style={styles.frame}>
                        {capture.observation !== null ? (
                            <FrozenPhoto
                                observation={capture.observation}
                                caption="Frozen photo for this capture."
                                overlay={(displayed) =>
                                    locate.boxes.map((box) => (
                                        <Rect
                                            key={box.label}
                                            x={displayed.x + box.box.x * displayed.width}
                                            y={displayed.y + box.box.y * displayed.height}
                                            width={box.box.width * displayed.width}
                                            height={box.box.height * displayed.height}
                                            stroke={palette.signal}
                                            strokeWidth={3}
                                            fill="none"
                                        />
                                    ))
                                }
                            />
                        ) : (
                            <Svg width="100%" height={180} viewBox="0 0 1 1" preserveAspectRatio="none">
                                {locate.boxes.map((box) => (
                                    <Rect
                                        key={box.label}
                                        x={box.box.x}
                                        y={box.box.y}
                                        width={box.box.width}
                                        height={box.box.height}
                                        stroke={palette.signal}
                                        strokeWidth={0.01}
                                        fill="none"
                                    />
                                ))}
                            </Svg>
                        )}
                        <Text style={styles.body}>
                            {capture.observation === null
                                ? 'Simulated photo: no image was captured or analysed.'
                                : 'Your photo, frozen for this capture.'}
                        </Text>
                    </View>
                )}
            </Panel>

            <Panel>
                <SectionTitle>4. Check this step</SectionTitle>
                {checkResult === null && check.pendingRequestId === null ? (
                    <Text style={styles.body}>No check yet.</Text>
                ) : null}
                {check.pendingRequestId !== null ? <Text style={styles.body}>Checking…</Text> : null}
                {checkResult !== null && checkOk === null && checkResult.status === 'unavailable' ? (
                    <Notice tone="error" text={unavailableText(checkResult.code)} />
                ) : null}
                {checkOk !== null ? (
                    <View style={styles.stack}>
                        <Tag
                            tone={checkOk.decision === 'pass' ? 'reviewed' : 'unreviewed'}
                            text={
                                checkOk.decision === 'pass'
                                    ? 'Pass'
                                    : checkOk.decision === 'refuse'
                                      ? 'Refuse'
                                      : 'Cannot verify'
                            }
                        />
                        <Text style={styles.body}>{checkOk.reason}</Text>
                        {checkOk.missingEvidence.map((missing) => (
                            <Text key={missing} style={styles.body}>
                                Missing: {missing}
                            </Text>
                        ))}
                        {citedPageId === null ? null : <Text style={styles.body}>Cited page: {citedPageId}</Text>}
                        {checkOk.decision === 'refuse' && citedSource !== undefined ? (
                            <Image
                                accessibilityLabel="Cited manual page"
                                source={{ uri: bytesToDataUri(citedSource.bytes, citedSource.mimeType) }}
                                style={styles.pageImage}
                                resizeMode="contain"
                            />
                        ) : null}
                        {checkOk.decision === 'refuse' && citedSource === undefined ? (
                            <Notice
                                text={
                                    simulated
                                        ? 'The cited page is a synthetic fixture page. No image is shown here.'
                                        : 'The cited page image is not held in this session.'
                                }
                            />
                        ) : null}
                    </View>
                ) : null}
            </Panel>

            {plan !== null && step !== null ? (
                <QuestionPanel
                    session={plan}
                    state={question}
                    parts={parts}
                    ready={questionReady(question) && actionReady}
                    disabledReason={unavailableReason}
                    onQuestionChange={(text) => dispatchQuestion({ type: 'questionChanged', question: text })}
                    onPartTarget={(partId) =>
                        dispatchQuestion({ type: 'targetChanged', target: { kind: 'part', partId } })
                    }
                    onClearTarget={() => dispatchQuestion({ type: 'targetChanged', target: null })}
                    onAsk={() => askQuestion()}
                />
            ) : null}

            <LocalizationPanel
                state={locate}
                ready={localizationReady(locate) && capture !== null && (simulated || capture.observation !== null)}
                disabledReason={
                    capture === null
                        ? unavailableReason
                        : simulated
                          ? 'Part search runs against the simulated photo in fixture mode.'
                          : null
                }
                onPromptChange={(prompt) => dispatchLocate({ type: 'promptChanged', prompt })}
                onLocate={() => locatePart()}
            />

            <View style={styles.footer}>
                <Text style={styles.small}>Each action makes at most one request. No automatic retries.</Text>
            </View>
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    content: { padding: space.md, gap: space.md, backgroundColor: palette.paper },
    stack: { gap: space.sm },
    body: { color: palette.charcoal, fontSize: 15, lineHeight: 21 },
    small: { color: palette.graphite, fontSize: 13 },
    frame: { gap: space.xs, borderRadius: radius, overflow: 'hidden' },
    pageImage: { width: '100%', height: 200, borderRadius: radius },
    footer: { paddingBottom: space.lg },
})
