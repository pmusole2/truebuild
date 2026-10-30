import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Linking, Platform } from 'react-native'
import { MoreSheet, useSheetDismiss } from '../../ui/sheet'
import { useIsFocused } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
    baseKindV2,
    visitVariantNodesV2,
    type AppIntent,
    type ScreenContextInputsV2,
    type ScreenKindV2,
    type VariantState,
    type BusyActivityV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import { useDocument } from '../document-runtime/use-document'
import { documentKey } from '../document-runtime/store'
import { DocumentRenderer } from '../documents/document-renderer'
import { useDocumentOwner } from '../documents/ownership'
import type { FrameBindings } from '../documents/types'
import { useCoach, useCoachScreen } from '../onboarding/coach-provider'
import type { CoachCandidate, OnboardingScreen } from '../onboarding/coach-types'
import { useJudge } from '../screens/judge-context'
import { resolveIntent, type ResolvedIntent } from '../screens/intents'
import { captureUiState, homeUiState, moreUiState, pagesUiState, reviewUiState } from '../screens/ui-state'
import { publishableResult } from '../screens/screen-spec'
import { useWorkflowActions } from './native-routes'
import { readingLanguage, setReadingLanguage } from './reading-language'
import { useMoreState, type MoreMode } from './screen-header'
import type { QuickProgress } from './review-screen'
import { useWorkflow } from './workflow-context'
import { isProblemNotice, plainNotice } from './plain-copy'

function activityOf(pending: string | null): BusyActivityV2 | null {
    if (pending === null) return null
    if (pending.startsWith('Taking a closer look') || pending.startsWith('Second opinion')) return 'second-opinion'
    if (pending.startsWith('Still thinking')) return 'question-waiting'
    if (pending.startsWith('Reading')) return 'reading'
    if (pending.startsWith('Checking') || pending.startsWith('Freezing')) return 'checking'
    if (pending.startsWith('Asking')) return 'asking'
    if (pending.startsWith('Saving')) return 'saving'
    return 'working'
}

export function documentInputs(
    kind: ScreenKindV2,
    workflow: Pick<ReturnType<typeof useWorkflow>, 'state' | 'entry'>,
    quick?: QuickProgress,
    contextualMore = false,
): ScreenContextInputsV2 {
    const { state, entry } = workflow
    const step = entry?.session.reviewedSteps[entry.stepIndex]
    const moreContext =
        kind === 'more' && contextualMore && entry?.session.reviewStatus === 'reviewed' && step !== undefined
    const held =
        state.capture !== null &&
        entry !== undefined &&
        step !== undefined &&
        state.capture.binding.manualId === entry.session.manualId &&
        state.capture.binding.revision === entry.session.revision &&
        state.capture.binding.stepId === step.stepId
    const answered =
        state.answer !== null && state.answeredQuestion != null
            ? { question: state.answeredQuestion, value: state.answer }
            : null
    const result =
        (kind === 'answer' || (moreContext && held && state.check === null)) && answered !== null
            ? publishableResult({ kind: 'question', ...answered })
            : (kind === 'result' || (moreContext && held)) && state.check !== null
              ? publishableResult({ kind: 'check', value: state.check })
              : null
    return {
        kind,
        session:
            ['home', 'compare', 'judge', 'error'].includes(kind) || (kind === 'more' && !moreContext)
                ? null
                : (entry?.session ?? null),
        stepId:
            moreContext || ['guide', 'result', 'answer', 'questions', 'recovery', 'camera'].includes(kind)
                ? (step?.stepId ?? null)
                : null,
        captureId:
            (moreContext && held) || ['result', 'answer', 'questions', 'camera'].includes(kind)
                ? (state.capture?.binding.captureId ?? null)
                : null,
        result,
        ...(moreContext && result?.kind === 'check' && answered !== null ? { companionAnswer: answered } : {}),
        failure: kind === 'error' || kind === 'recovery' ? 'provider_error' : null,
        ...(kind === 'completion' ? { completedStepIds: entry?.completedStepIds ?? [] } : {}),
        uiState:
            kind === 'home' || kind === 'compare'
                ? homeUiState(state.entries)
                : kind === 'add' || kind === 'pages'
                  ? entry === undefined
                      ? null
                      : pagesUiState(entry)
                  : kind === 'quick-check'
                    ? entry === undefined
                        ? null
                        : reviewUiState(entry, quick)
                    : kind === 'more' || kind === 'judge'
                      ? {
                            ...moreUiState({ tips: true }),
                            ...(kind === 'more'
                                ? {
                                      ...(moreContext ? (held ? captureUiState(state) : { capture: null }) : {}),
                                      language: { options: ['en', 'es', 'fr', 'de', 'pt-BR'] },
                                      settings: { storage: true as const },
                                  }
                                : {}),
                        }
                      : kind === 'reading'
                        ? { reading: { cancellation: 'confirm-before-stop' as const } }
                        : kind === 'camera'
                          ? {
                                camera: {
                                    mode: state.cameraIntent?.kind === 'page' ? 'manual-page' : 'build-photo',
                                    permission: 'undetermined',
                                },
                            }
                          : captureUiState(state),
    }
}

/** One production route adapter. It binds live mechanics, never screen content or a parallel action bar. */
export function DocumentSurface({
    kind,
    quick,
    choosePages,
    camera,
    compare,
    onClose,
    dismissParents,
    state: requestedState,
    readingConfirmation,
    resultEvidence,
    retry,
    primaryTestId,
    requestQuestionPhoto,
    operationNotice,
    contextualMore = false,
    requestQuestionComposer,
    runContextAction,
    testID,
}: {
    kind: ScreenKindV2
    quick?: QuickProgress
    choosePages?: () => void
    camera?: FrameBindings['camera']
    compare?: FrameBindings['compare']
    onClose?: () => void
    dismissParents?: () => void
    state?: 'ready' | VariantState
    readingConfirmation?: { readonly open: boolean; readonly onChange: (open: boolean) => void }
    resultEvidence?: { readonly document: ScreenDocumentV2; readonly arrivedAt: number | null } | null
    retry?: () => void
    primaryTestId?: string
    requestQuestionPhoto?: () => void
    operationNotice?: string
    contextualMore?: boolean
    requestQuestionComposer?: () => void
    runContextAction?: (run: () => void) => void
    testID?: string
}): ReactElement {
    const workflow = useWorkflow()
    const { state, entry } = workflow
    const { controller, nav } = useWorkflowActions()
    const focused = useIsFocused()
    const more = useMoreState()
    const coach = useCoach()
    const judge = useJudge()
    const insets = useSafeAreaInsets()
    const sheetDismiss = useSheetDismiss()
    const closeSheet = sheetDismiss ?? onClose
    const [judgeOpen, setJudgeOpen] = useState(false)
    const dismissOverlays = (): void => {
        more.hide()
        setJudgeOpen(false)
        closeSheet?.()
        dismissParents?.()
    }
    const questionCapture = useRef<{ before: string | null; manualId: string | null; entered: boolean } | null>(null)
    const previousAnswer = useRef(state.answer)
    const [dismissedAnswer, setDismissedAnswer] = useState<typeof state.answer>(null)
    const [presentedResult, setPresentedResult] = useState<{
        document: ScreenDocumentV2
        arrivedAt: number | null
    } | null>(null)
    const [language, setLanguage] = useState(() =>
        entry === undefined ? 'en' : readingLanguage(entry.session.manualId),
    )
    useEffect(() => {
        setLanguage(entry === undefined ? 'en' : readingLanguage(entry.session.manualId))
    }, [entry?.session.manualId])
    const effectiveKind =
        kind === 'home' && state.storageReadOnly
            ? 'error'
            : kind === 'guide'
              ? state.answer !== null && state.answeredQuestion != null && state.answer !== dismissedAnswer
                  ? 'answer'
                  : state.check !== null
                    ? 'result'
                    : state.pending === null && state.notice !== null && isProblemNotice(state.notice)
                      ? 'recovery'
                      : 'guide'
              : kind
    const inputs = documentInputs(effectiveKind, workflow, quick, contextualMore)
    const cancelledPages = effectiveKind === 'pages' && state.notice?.startsWith('Cancelled.') === true
    const notice =
        operationNotice ??
        (state.notice !== null && (isProblemNotice(state.notice) || cancelledPages) ? plainNotice(state.notice) : null)
    if (['error', 'recovery', 'reading'].includes(effectiveKind))
        inputs.uiState = { ...inputs.uiState, failure: notice === null ? null : { notice: true } }
    if (cancelledPages) inputs.uiState = { ...inputs.uiState, cancelled: { reading: true } }
    const activity = activityOf(state.pending)
    inputs.uiState = { ...inputs.uiState, busy: activity === null ? null : { activity } }
    if (effectiveKind === 'camera' && camera !== undefined && inputs.uiState?.camera != null)
        inputs.uiState.camera = {
            ...inputs.uiState.camera,
            permission: camera.permission,
            failed: camera.failed ?? false,
            canAskAgain: camera.canAskAgain ?? null,
        }
    const busy = state.pending !== null || state.loading
    const contextualParent = ['guide', 'result', 'answer', 'recovery'].includes(effectiveKind)
    const moreWarmInput = documentInputs('more', workflow, quick, true)
    const moreWarmKey =
        contextualParent && !busy && focused && !more.open && !judgeOpen ? documentKey(moreWarmInput) : null
    const warmInput = useRef(moreWarmInput)
    warmInput.current = moreWarmInput
    useEffect(() => {
        if (moreWarmKey !== null) workflow.documents?.warmup([warmInput.current])
    }, [workflow.documents, moreWarmKey])
    const reading = useDocument(inputs, {
        focused: focused && !more.open && !judgeOpen,
        state:
            readingConfirmation?.open === true
                ? 'confirming'
                : camera?.failed === true
                  ? 'error'
                  : (requestedState ?? (busy ? 'busy' : 'ready')),
    })
    useDocumentOwner(reading.document, focused && !more.open && !judgeOpen)
    useEffect(() => {
        if (presentedResult !== null && presentedResult.document.bound.captureId !== state.capture?.binding.captureId)
            setPresentedResult(null)
        if (
            !focused ||
            more.open ||
            judgeOpen ||
            reading.document.kind !== 'result' ||
            reading.document.bound.captureId !== state.capture?.binding.captureId
        )
            return
        const entry = workflow.documents?.peek(inputs)
        const arrivedAt =
            entry?.document === reading.document
                ? (workflow.documents?.readyAt(inputs) ?? null)
                : presentedResult?.document === reading.document
                  ? presentedResult.arrivedAt
                  : null
        if (presentedResult?.document !== reading.document || presentedResult.arrivedAt !== arrivedAt)
            setPresentedResult({ document: reading.document, arrivedAt })
    }, [
        focused,
        more.open,
        judgeOpen,
        reading.document,
        state.capture?.binding.captureId,
        workflow.documents,
        presentedResult,
    ])
    const resultOnScreen = presentedResult ?? resultEvidence ?? null
    useEffect(() => {
        const waiting = questionCapture.current
        if (waiting === null) return
        if (state.route === 'library' || state.selectedId !== waiting.manualId) {
            questionCapture.current = null
            return
        }
        if (state.route === 'camera' && state.cameraIntent?.kind === 'question') waiting.entered = true
        if (focused && waiting.entered && state.route === 'guide' && state.pending === null) {
            questionCapture.current = null
            if (state.capture?.reusable === true && state.capture.binding.captureId !== waiting.before) more.show('ask')
        }
    }, [focused, state.route, state.selectedId, state.cameraIntent, state.capture, state.pending, more])
    useEffect(() => {
        if (state.answer !== null && previousAnswer.current !== state.answer && effectiveKind === 'questions')
            closeSheet?.()
        previousAnswer.current = state.answer
    }, [state.answer, effectiveKind, closeSheet])
    const takeQuestionPhoto = (): void => {
        questionCapture.current = {
            before: state.capture?.binding.captureId ?? null,
            manualId: state.selectedId,
            entered: false,
        }
        more.hide()
        controller.camera({ kind: 'question' })
    }
    const showMore = (mode: MoreMode): void => {
        if (mode === 'ask' && (state.capture === null || !state.capture.reusable)) takeQuestionPhoto()
        else more.show(mode)
    }
    const resolve = (intent: AppIntent): ResolvedIntent => {
        if (effectiveKind === 'more' && intent.intent === 'ask' && requestQuestionComposer !== undefined) {
            const resolved = resolveIntent(intent, {
                kind: 'more',
                state,
                entry,
                controller,
                nav,
                extras: { contextualMore, showMore: (): void => requestQuestionComposer() },
            })
            return resolved
        }
        if (effectiveKind === 'camera' && intent.intent === 'capture') {
            const enabled = !busy && camera?.ready === true
            return {
                enabled,
                reason: enabled ? null : 'The camera is not ready.',
                run: (): void => {
                    if (enabled) camera?.capture()
                },
            }
        }
        if (intent.intent === 'navigate' && intent.target === 'back') {
            return {
                enabled: !state.loading,
                reason: state.loading ? 'Your builds are opening.' : null,
                run: (): void => {
                    if (state.loading) return
                    if (effectiveKind === 'camera') controller.cancel()
                    else if (effectiveKind === 'reading' && state.pending?.startsWith('Reading') === true)
                        readingConfirmation?.onChange(true)
                    else if (closeSheet !== undefined) closeSheet()
                    else nav.back()
                },
            }
        }
        if (effectiveKind === 'questions' && intent.intent === 'capture' && requestQuestionPhoto !== undefined) {
            const enabled = !busy && !state.storageReadOnly && entry?.session.reviewStatus === 'reviewed'
            return {
                enabled,
                reason: enabled ? null : 'Wait for the current request to finish.',
                run: (): void => {
                    if (enabled) requestQuestionPhoto()
                },
            }
        }
        if (effectiveKind === 'answer' && intent.intent === 'navigate' && intent.target === 'guide')
            return {
                enabled: !busy,
                reason: busy ? state.pending : null,
                run: (): void => {
                    if (!busy) setDismissedAnswer(state.answer)
                },
            }
        if (intent.intent === 'confirm' && intent.target === 'camera-permission') {
            const enabled =
                effectiveKind === 'camera' &&
                camera?.permission !== 'granted' &&
                camera?.canAskAgain !== false &&
                camera !== undefined &&
                camera.requestPermission !== undefined &&
                !busy
            return {
                enabled,
                reason: enabled ? null : 'Camera access is not ready.',
                run: (): void => {
                    if (enabled) camera?.requestPermission?.()
                },
            }
        }
        if (intent.intent === 'retry' && intent.target === 'camera') {
            const enabled = effectiveKind === 'camera' && camera?.failed === true && camera.retry !== undefined && !busy
            return {
                enabled,
                reason: enabled ? null : 'The camera is not ready.',
                run: (): void => {
                    if (enabled) camera?.retry?.()
                },
            }
        }
        if (intent.intent === 'open-details' && intent.target === 'device-settings') {
            const supported =
                camera?.openSettings !== undefined ||
                (Platform.OS !== 'web' && typeof Linking.openSettings === 'function')
            const enabled =
                !busy &&
                supported &&
                (effectiveKind === 'more' || (effectiveKind === 'camera' && camera?.canAskAgain === false))
            return {
                enabled,
                reason: enabled ? null : 'Open device settings on your phone.',
                run: (): void => {
                    if (enabled) {
                        if (effectiveKind === 'camera' && camera?.openSettings !== undefined) camera.openSettings()
                        else void Linking.openSettings().catch((): void => undefined)
                    }
                },
            }
        }
        if (retry !== undefined && intent.intent === 'retry')
            return { enabled: !busy, reason: busy ? state.pending : null, run: retry }
        if (intent.intent === 'retry' && state.storageReadOnly)
            return {
                enabled: !state.loading,
                reason: state.loading ? 'Your builds are opening.' : null,
                run: (): void => {
                    if (!state.loading) void controller.restore()
                },
            }
        if (intent.intent === 'open-details' && intent.target === 'about-check')
            return { enabled: !busy, reason: busy ? state.pending : null, run: (): void => setJudgeOpen(true) }
        if (effectiveKind === 'reading' && intent.intent === 'navigate')
            return {
                enabled: true,
                reason: null,
                run: (): void => {
                    if (intent.target === 'reading') readingConfirmation?.onChange(false)
                    else if (state.pending?.startsWith('Reading') === true && readingConfirmation?.open !== true)
                        readingConfirmation?.onChange(true)
                    else {
                        controller.cancel()
                        readingConfirmation?.onChange(false)
                        setTimeout(nav.back, 0)
                    }
                },
            }
        if (effectiveKind === 'questions' && intent.intent === 'ask') {
            const ready =
                !busy &&
                state.capture?.reusable === true &&
                state.target !== null &&
                state.question.trim() !== '' &&
                entry?.session.reviewStatus === 'reviewed'
            return {
                enabled: ready,
                reason: ready
                    ? null
                    : busy
                      ? 'Wait for the current request to finish.'
                      : 'Choose a part and write your question.',
                run: (): void => {
                    if (ready) void controller.ask()
                },
            }
        }
        if (effectiveKind === 'camera' && intent.intent === 'navigate')
            return { enabled: !busy, reason: null, run: controller.cancel }
        const resolved = resolveIntent(intent, {
            kind: baseKindV2(effectiveKind),
            state,
            entry,
            controller,
            nav,
            extras: {
                choosePages,
                showMore,
                showTips: (): void => {
                    coach?.showTipsAgain()
                    closeSheet?.()
                    more.hide()
                },
                refresh: reading.retry,
                language: entry === undefined ? 'en' : readingLanguage(entry.session.manualId),
                contextualMore: effectiveKind === 'more' && contextualMore,
            },
        })
        return effectiveKind === 'more' &&
            runContextAction !== undefined &&
            (intent.intent === 'capture' || intent.intent === 'confirm') &&
            resolved.enabled
            ? { ...resolved, run: (): void => runContextAction(resolved.run) }
            : resolved
    }
    const screen: OnboardingScreen =
        kind === 'home'
            ? 'home'
            : kind === 'pages' || kind === 'add'
              ? 'pages'
              : kind === 'quick-check'
                ? 'quick-check'
                : kind === 'camera'
                  ? 'camera'
                  : 'guide'
    const candidates: CoachCandidate[] = []
    const variantPrefix = reading.activeState === 'ready' ? '' : `states.${reading.activeState}.`
    visitVariantNodesV2(reading.variant, variantPrefix, ({ node, path }): void => {
        if (node.type === 'CoachMark')
            candidates.push({
                id: node.targetId,
                kind: node.targetId === 'guide-hero' || node.targetId === 'guide-hero-frame' ? 'surface' : 'control',
                heading: node.heading,
                sentence: node.body,
                textOrigin: reading.document.metadata.origins[path] ?? 'fallback',
            })
    })
    useCoachScreen(screen, {
        suppressed: busy || more.open || judgeOpen || reading.status === 'pending' || requestedState === 'error',
        candidates,
    })
    const bindings: FrameBindings = {
        resolve,
        live: {
            state,
            entry,
            controller,
            nav,
            more,
            ...(quick === undefined ? {} : { quick }),
            pages: {
                open: (pageId): void => {
                    const index = entry?.session.pages.findIndex((page) => page.pageId === pageId) ?? -1
                    if (index >= 0) more.show('details')
                },
                arriving: new Set(),
            },
            closeSheet: more.hide,
        },
        session: entry?.session,
        pageUris: state.pageUris,
        pageImageStatus: state.storageReadOnly
            ? 'unavailable'
            : state.loading ||
                entry?.session.pages.some((page) => typeof state.pageUris[page.pageId] !== 'string') === true
              ? 'pending'
              : 'ready',
        capture: state.capture,
        marks: state.stages?.captureId === state.capture?.binding.captureId ? (state.stages?.masks ?? []) : [],
        heroMode: 'inline',
        operationNotice: notice,
        answeredQuestion:
            inputs.companionAnswer?.question ?? (inputs.result?.kind === 'question' ? inputs.result.question : null),
        insetTop: onClose === undefined ? insets.top : 0,
        testIds:
            primaryTestId !== undefined
                ? { primary: primaryTestId }
                : kind === 'home' && state.storageReadOnly
                  ? { primary: 'retry-library' }
                  : undefined,
        workInProgress: busy || more.open || judgeOpen,
        language: {
            value: language,
            onChange: (value): void => {
                if (entry !== undefined) setReadingLanguage(entry.session.manualId, value)
                setLanguage(value)
            },
        },
        inspect: judge.showBuilt,
        closeOverlays: dismissOverlays,
        camera,
        compare,
        resultDocument: resultOnScreen?.document ?? null,
        resultArrivedAt: resultOnScreen?.arrivedAt ?? null,
        toggles: { 'built-view': { value: judge.showBuilt, onChange: judge.setShowBuilt } },
        judge: judge.showBuilt
            ? {
                  summary:
                      reading.document.metadata.evidence === 'synthetic-fixture'
                          ? 'Simulated fixture · no model call'
                          : reading.document.metadata.source,
                  onShowDetails: (): void => setJudgeOpen(true),
              }
            : null,
    }
    return (
        <>
            <DocumentRenderer
                document={reading.document}
                bindings={bindings}
                variant={
                    ['result', 'answer'].includes(effectiveKind) && reading.status === 'pending' && !busy
                        ? 'ready'
                        : reading.activeState
                }
                testID={
                    testID ??
                    (kind === 'home' ? 'library-screen' : undefined) ??
                    (
                        {
                            home: 'library-screen',
                            add: 'pages-screen',
                            pages: 'pages-screen',
                            reading: 'reading-screen',
                            'quick-check': 'overview-screen',
                            guide: 'guide-screen',
                            result: 'guide-screen',
                            answer: 'guide-screen',
                            completion: 'done-screen',
                            camera: 'camera-screen',
                        } as Partial<Record<ScreenKindV2, string>>
                    )[effectiveKind]
                }
            />
            {more.open ? (
                <MoreSheet visible documentFrame onClose={more.hide} detents={['tall', 'full']}>
                    <DocumentSurface
                        kind={more.mode === 'ask' ? 'questions' : 'more'}
                        onClose={more.hide}
                        dismissParents={dismissOverlays}
                        requestQuestionPhoto={takeQuestionPhoto}
                        requestQuestionComposer={(): void => showMore('ask')}
                        runContextAction={(run): void => {
                            more.hide()
                            run()
                        }}
                        contextualMore={contextualParent || contextualMore}
                        resultEvidence={resultOnScreen}
                    />
                </MoreSheet>
            ) : null}
            {judgeOpen ? (
                <MoreSheet visible documentFrame onClose={(): void => setJudgeOpen(false)} detents={['tall', 'full']}>
                    <DocumentSurface
                        kind="judge"
                        onClose={(): void => setJudgeOpen(false)}
                        dismissParents={dismissOverlays}
                        resultEvidence={resultOnScreen}
                    />
                </MoreSheet>
            ) : null}
        </>
    )
}
