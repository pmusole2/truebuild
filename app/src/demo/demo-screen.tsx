import { useMemo, useReducer, useRef, useState, type ReactElement } from 'react'
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native'
import Svg, { Rect } from 'react-native-svg'
import {
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type ManualSession,
    type ManualStep,
    type ParsedManual,
    type QuestionTarget,
} from '@truebuild/contracts'
import { BoundedApiClient } from '../api/client'
import { ModelApiClient } from '../api/model-client'
import { ActionButton, Notice, Panel, SectionTitle, Tag } from '../components/ui'
import { palette, radius, space } from '../components/theme'
import { askModelQuestion, runModelCheck, type SourcePageAsset } from '../features/assembly/model-check'
import { checkReducer, createCheckState, type Scenario } from '../features/assembly/check-state'
import { runCheck } from '../features/assembly/check-runner'
import { FrozenPhoto } from '../features/assembly/frozen-photo'
import { freshCaptureId, freshRequestId } from '../features/assembly/identity'
import { boxOnDisplay } from '../features/assembly/frame-geometry'
import { localizationReducer, createLocalizationState, localizationReady } from '../features/assembly/localization-state'
import { locateInPhoto } from '../features/assembly/localize'
import { LocalizationPanel } from '../features/assembly/localization-panel'
import { captureObservation, observationForSegmentation, type Observation } from '../features/assembly/observation'
import { QuestionPanel } from '../features/assembly/question-panel'
import { createQuestionState, questionReady, questionReducer, stepPartChoices } from '../features/assembly/question-state'
import { bytesToDataUri } from '../media/image-source'
import { userMessageForMediaError } from '../media/media-errors'
import { ManualDiagram } from './manual-diagram'
import { confirmParsedPlan } from './sample-manual'
import { parseManualPhoto, type ParseOutcome, type ParseRuntime } from './parse-photo'
import { SAMPLE_MANUAL_LABEL, sampleManual } from './sample-manual'

export type DemoRuntime = ParseRuntime

type Capture = {
    readonly captureId: string
    readonly binding: CaptureBinding
    readonly observation: Observation | null
    readonly scenario: Scenario
}

const SIMULATED_PHOTOS: readonly { readonly scenario: Scenario; readonly label: string }[] = [
    { scenario: 'correct', label: 'Simulated correct photo' },
    { scenario: 'wrong', label: 'Simulated reversed panel' },
    { scenario: 'unclear', label: 'Simulated unclear photo' },
]

function unavailableText(code: string): string {
    return `Unavailable (${code}). Nothing was shown as a result.`
}

/**
 * One direct demo: sample or parsed manual → step picker → photo → check (pass, refuse or cannot_verify) → Ask →
 * part localization on the frozen photo. Fixture mode simulates every photo and labels every result as simulated.
 */
export function DemoScreen({ runtime }: { readonly runtime: DemoRuntime }): ReactElement {
    const simulated = runtime.mode === 'fixture'
    const [plan, setPlan] = useState<ManualSession | null>(simulated ? sampleManual() : null)
    const [planSources, setPlanSources] = useState<readonly SourcePageAsset[]>([])
    const [parseOutcome, setParseOutcome] = useState<ParseOutcome | null>(null)
    const [parsing, setParsing] = useState(false)
    const [planMessage, setPlanMessage] = useState<string | null>(null)
    const [stepId, setStepId] = useState<string | null>(null)
    const [capture, setCapture] = useState<Capture | null>(null)
    const [photoMessage, setPhotoMessage] = useState<string | null>(null)
    const [pickedParsedPlan, setPickedParsedPlan] = useState(false)

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
    const abortRef = useRef<AbortController | null>(null)

    const steps: readonly ManualStep[] = plan?.reviewedSteps ?? []
    const step = steps.find((candidate) => candidate.stepId === stepId) ?? steps[0] ?? null
    const parts = plan !== null && step !== null ? stepPartChoices(plan, step) : []
    const sourcesById = useMemo(
        () => new Map(planSources.map((source) => [source.assetId, source])),
        [planSources],
    )
    const loadPageAsset = async (assetId: string): Promise<SourcePageAsset | null> => sourcesById.get(assetId) ?? null

    const modelClient = useMemo(
        () => new ModelApiClient({ baseUrl: runtime.baseUrl, secret: runtime.secret, fetch: runtime.fetch }),
        [runtime.baseUrl, runtime.secret, runtime.fetch],
    )
    const fixtureClient = useMemo(
        () => new BoundedApiClient({ baseUrl: runtime.baseUrl, mode: 'fixture', secret: runtime.secret, fetch: runtime.fetch }),
        [runtime.baseUrl, runtime.secret, runtime.fetch],
    )

    const actionReady = plan !== null && step !== null && capture !== null
    const unavailableReason =
        plan === null
            ? 'Photograph a manual and confirm its plan first.'
            : step === null
              ? 'Pick a step first.'
              : capture === null
                ? 'Take a photo of the assembly for this step first.'
                : null

    // A parse result becomes checkable only after explicit confirmation. Nothing is filled in silently.
    async function photographManual(): Promise<void> {
        setParsing(true)
        setPlanMessage(null)
        setPickedParsedPlan(false)
        const outcome = await parseManualPhoto(runtime)
        setParsing(false)
        if (outcome.status === 'cancelled') {
            return
        }
        setParseOutcome(outcome)
        if (outcome.status === 'failed') {
            setPlanMessage(outcome.message)
        }
    }

    function confirmPlan(): void {
        if (parseOutcome?.status !== 'parsed' || plan === null) {
            return
        }
        const outcome = confirmParsedPlan(plan, parseOutcome.parsed, parseOutcome.pages)
        if (outcome.status === 'blocked') {
            setPlanMessage(
                'Not confirmed: a critical fact is unknown or cites a page that is not in this plan. Nothing was filled in. Use a clearer photo of the manual.',
            )
            return
        }
        setPlan(outcome.session)
        setPlanSources(parseOutcome.sources)
        setParseOutcome(null)
        setPickedParsedPlan(true)
        setStepId(outcome.session.reviewedSteps[0]?.stepId ?? null)
        setCapture(null)
        setPlanMessage('Plan confirmed. Model corrections were not applied; check each step against the manual.')
    }

    function selectStep(nextStepId: string): void {
        if (nextStepId === step?.stepId) {
            return
        }
        abortRef.current?.abort()
        setStepId(nextStepId)
        setCapture(null)
        setPhotoMessage(null)
    }

    async function takeCapture(source: Scenario | 'camera' | 'library'): Promise<void> {
        if (plan === null || step === null) {
            return
        }
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        let observation: Observation | null = null
        let scenario: Scenario = 'correct'
        if (source === 'camera' || source === 'library') {
            try {
                const picked = await captureObservation(source)
                if (picked === null) {
                    return
                }
                observation = picked
            } catch (error: unknown) {
                setPhotoMessage(userMessageForMediaError(error))
                return
            }
        } else {
            scenario = source
        }

        const binding: CaptureBinding = {
            kind: 'capture',
            manualId: plan.manualId,
            revision: plan.revision,
            stepId: step.stepId,
            captureId: freshCaptureId(),
        }
        const next: Capture = { captureId: binding.captureId, binding, observation, scenario }
        setCapture(next)
        setPhotoMessage(null)
        dispatchCheck({ type: 'bindingSynced', binding })
        dispatchQuestion({ type: 'bindingSynced', binding })
        dispatchLocate({ type: 'bindingSynced', binding })
        void runCheckFor(next, plan, step, controller.signal)
    }

    async function runCheckFor(
        current: Capture,
        session: ManualSession,
        target: ManualStep,
        signal: AbortSignal,
    ): Promise<void> {
        const requestId = freshRequestId('check')
        dispatchCheck({ type: 'checkStarted', requestId })
        const result: ApiResult<CheckResult> =
            runtime.mode === 'fixture'
                ? await runCheck({ mode: 'fixture', requestId, binding: current.binding, scenario: current.scenario }, signal)
                : current.observation === null
                  ? { status: 'unavailable', requestId, binding: current.binding, code: 'invalid_input', retryable: false }
                  : await runModelCheck({
                        client: modelClient,
                        requestId,
                        binding: current.binding,
                        session,
                        step: target,
                        observation: current.observation,
                        loadPageAsset,
                        signal,
                    })
        if (signal.aborted) {
            return
        }
        dispatchCheck({ type: 'checkFinished', requestId, binding: current.binding, result })
    }

    async function askQuestion(): Promise<void> {
        if (plan === null || step === null || capture === null || question.target === null) {
            return
        }
        const requestId = freshRequestId('question')
        dispatchQuestion({ type: 'started', requestId })
        const binding = capture.binding
        const target: QuestionTarget = question.target
        const text = question.question.trim()
        const result =
            runtime.mode === 'fixture'
                ? await fixtureClient.questions(binding, text, target, { requestId })
                : capture.observation === null
                  ? { status: 'unavailable' as const, requestId, binding, code: 'invalid_input' as const, retryable: false }
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
                        signal: new AbortController().signal,
                    })
        dispatchQuestion({ type: 'finished', requestId, binding, result })
    }

    async function locatePart(): Promise<void> {
        if (plan === null || capture === null) {
            return
        }
        const requestId = freshRequestId('locate')
        dispatchLocate({ type: 'started', requestId })
        const binding = capture.binding
        const prompt = locate.prompt.trim()
        if (runtime.mode === 'fixture') {
            const result = await fixtureClient.segments(binding, 'normal', { requestId })
            if (result.status !== 'ok') {
                dispatchLocate({ type: 'received', requestId, result })
                return
            }
            for (const event of result.value.events) {
                dispatchLocate({ type: 'received', requestId, result: { ...result, value: event } })
            }
            return
        }
        if (capture.observation === null) {
            dispatchLocate({
                type: 'received',
                requestId,
                result: { status: 'unavailable', requestId, binding, code: 'invalid_input', retryable: false },
            })
            return
        }
        const frozen = await observationForSegmentation(capture.observation)
        for await (const result of locateInPhoto({
            client: modelClient,
            requestId,
            binding,
            prompt,
            observation: frozen,
            signal: new AbortController().signal,
        })) {
            dispatchLocate({ type: 'received', requestId, result })
        }
    }

    const checkResult = check.result
    const checkOk = checkResult?.status === 'ok' ? checkResult.value : null
    // The cited page is shown only when its original is held in this session (model mode). Fixture never has one.
    const citedPage = plan === null || step === null
        ? undefined
        : plan.pages.find((page) => step.sourceRefs.some((ref) => ref.pageId === page.pageId))
    const pageForStep = citedPage === undefined ? undefined : sourcesById.get(citedPage.assetId)

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
                    {pickedParsedPlan ? 'Confirmed plan from your photo.' : plan === null ? 'No plan yet.' : SAMPLE_MANUAL_LABEL}
                </Text>
                <ActionButton
                    label={parsing ? 'Reading photo…' : 'Photograph a manual'}
                    tone="primary"
                    disabled={parsing}
                    onPress={() => void photographManual()}
                />
                {parseOutcome?.status === 'parsed' ? (
                    <View style={styles.stack}>
                        <Tag tone={parseOutcome.mode === 'fixture' ? 'simulated' : 'unreviewed'} text={parseOutcome.mode === 'fixture' ? 'Simulated parse result' : 'Parsed from your photo · unconfirmed'} />
                        {parseOutcome.mode === 'fixture' ? (
                            <Notice tone="caution" text="Simulated parse result. Your photo was not analysed." />
                        ) : null}
                        <Text style={styles.body}>Parts: {parseOutcome.parsed.parts.map((part) => (part.name.state === 'known' ? part.name.value : 'unknown part')).join(', ') || 'none'}</Text>
                        {parseOutcome.parsed.steps.map((candidate) => (
                            <Text key={candidate.stepId} style={styles.body}>
                                {candidate.order}. {candidate.title}
                            </Text>
                        ))}
                        {parseOutcome.parsed.unknowns.map((unknown) => (
                            <Text key={unknown} style={styles.body}>
                                Unknown: {unknown}
                            </Text>
                        ))}
                        <Notice tone="caution" text="Model corrections are not applied. Only expected facts you confirm are used." />
                        <ActionButton label="Confirm expected facts" tone="primary" onPress={confirmPlan} />
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
                                onPress={() => void takeCapture(photo.scenario)}
                            />
                        ))}
                    </View>
                ) : (
                    <View style={styles.stack}>
                        <ActionButton label="Take photo" tone="primary" disabled={plan === null || step === null} onPress={() => void takeCapture('camera')} />
                        <ActionButton label="Choose photo" disabled={plan === null || step === null} onPress={() => void takeCapture('library')} />
                    </View>
                )}
                {photoMessage === null ? null : <Notice tone="error" text={photoMessage} />}
                {unavailableReason === null ? null : <Text style={styles.body}>{unavailableReason}</Text>}
                {capture === null ? null : (
                    <View style={styles.frame}>
                        {capture.observation !== null ? (
                            <FrozenPhoto
                                observation={capture.observation}
                                caption="Frozen photo for this capture."
                                overlay={(displayed) =>
                                    locate.boxes.map((box) => {
                                        const rect = boxOnDisplay(box.box, displayed)
                                        return <Rect key={box.label} x={rect.x} y={rect.y} width={rect.width} height={rect.height} stroke={palette.signal} strokeWidth={3} fill="none" />
                                    })
                                }
                            />
                        ) : (
                            <Svg width="100%" height={180}>
                                {locate.boxes.map((box) => (
                                    <Rect
                                        key={box.label}
                                        x={`${box.box.x * 100}%`}
                                        y={`${box.box.y * 100}%`}
                                        width={`${box.box.width * 100}%`}
                                        height={`${box.box.height * 100}%`}
                                        stroke={palette.signal}
                                        strokeWidth={3}
                                        fill="none"
                                    />
                                ))}
                            </Svg>
                        )}
                        <Text style={styles.body}>
                            {capture.observation === null ? 'Simulated photo: no image was captured or analysed.' : 'Your photo, frozen for this capture.'}
                        </Text>
                    </View>
                )}
            </Panel>

            <Panel>
                <SectionTitle>4. Check this step</SectionTitle>
                {checkResult === null ? <Text style={styles.body}>No check yet.</Text> : null}
                {checkResult !== null && checkOk === null && checkResult.status === 'unavailable' ? (
                    <Notice tone="error" text={unavailableText(checkResult.code)} />
                ) : null}
                {check.pendingRequestId !== null ? <Text style={styles.body}>Checking…</Text> : null}
                {checkOk !== null ? (
                    <View style={styles.stack}>
                        <Tag
                            tone={checkOk.decision === 'pass' ? 'reviewed' : 'unreviewed'}
                            text={checkOk.decision === 'pass' ? 'Pass' : checkOk.decision === 'refuse' ? 'Refuse' : 'Cannot verify'}
                        />
                        <Text style={styles.body}>{checkOk.reason}</Text>
                        {checkOk.missingEvidence.map((missing) => (
                            <Text key={missing} style={styles.body}>
                                Missing: {missing}
                            </Text>
                        ))}
                        {checkOk.decision === 'refuse' && step !== null ? (
                            pageForStep !== undefined ? (
                                <Image
                                    accessibilityLabel="Cited manual page"
                                    source={{ uri: bytesToDataUri(pageForStep.bytes, pageForStep.mimeType) }}
                                    style={styles.pageImage}
                                    resizeMode="contain"
                                />
                            ) : (
                                <ManualDiagram title={step.title} simulated={simulated} />
                            )
                        ) : null}
                        {checkOk.decision === 'pass' ? (
                            <Notice text="Pass: the photo matches the cited manual step. Still compare with the physical manual." />
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
                    onPartTarget={(partId) => dispatchQuestion({ type: 'targetChanged', target: { kind: 'part', partId } })}
                    onClearTarget={() => dispatchQuestion({ type: 'targetChanged', target: null })}
                    onAsk={() => void askQuestion()}
                />
            ) : null}

            <LocalizationPanel
                state={locate}
                ready={localizationReady(locate) && capture !== null && capture.observation !== null}
                disabledReason={
                    capture === null
                        ? unavailableReason
                        : simulated
                          ? 'Part search runs against the simulated photo in fixture mode.'
                          : null
                }
                onPromptChange={(prompt) => dispatchLocate({ type: 'promptChanged', prompt })}
                onLocate={() => void locatePart()}
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
