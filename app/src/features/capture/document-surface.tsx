import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Linking, Platform } from 'react-native'
import { MoreSheet, useSheetDismiss } from '../../ui/sheet'
import { useIsFocused, usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
    baseKindV2,
    visitVariantNodesV2,
    type AppIntent,
    type ScreenKindV2,
    type VariantState,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import { activeDocumentVariant, useDocument } from '../document-runtime/use-document'
import { documentKey } from '../document-runtime/store'
import { DocumentRenderer } from '../documents/document-renderer'
import { useDocumentOwner, useDocumentVisibility } from '../documents/ownership'
import type { FrameBindings } from '../documents/types'
import { useCoach, useCoachScreen } from '../onboarding/coach-provider'
import type { CoachCandidate, OnboardingScreen } from '../onboarding/coach-types'
import { useJudge } from '../screens/judge-context'
import { CompareNavigationContext, type CompareNavigation } from '../screens/compare-flow'
import { resolveIntent, type ResolvedIntent } from '../screens/intents'
import { useNavigationPreparation, useWorkflowActions } from './native-routes'
import { readingLanguage, setReadingLanguage } from './reading-language'
import { useMoreState, type MoreMode } from './screen-header'
import type { QuickProgress } from '../screens/quick-progress'
import { documentInputs } from './document-inputs'
export { documentInputs } from './document-inputs'
import { useWorkflow, type WorkflowValue } from './workflow-context'
import { isProblemNotice, plainNotice } from './plain-copy'
import { documentMatchesInputs } from '../../api/document-client'

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
    holdQuestion = false,
    onQuestionDismiss,
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
    /** The parent Answer has arrived, but its native held-photo gate has not witnessed a ready page yet. */
    holdQuestion?: boolean
    onQuestionDismiss?: () => void
    requestQuestionComposer?: () => void
    runContextAction?: (run: () => void) => void
    testID?: string
}): ReactElement {
    const actualWorkflow = useWorkflow()
    const routeFocused = useIsFocused()
    const visible = useDocumentVisibility()
    const focused = routeFocused && visible
    const pathname = usePathname()
    const preparation = useNavigationPreparation()
    // Compare is prepared by its own control, which shows the busy state; the screen under it and its sheets stay as they are.
    const navigationPreparing =
        focused &&
        onClose === undefined &&
        preparation !== null &&
        preparation.sourcePath === pathname &&
        preparation.kind !== 'compare'
    const retained = useRef<{
        readonly workflow: WorkflowValue
        readonly quick: QuickProgress | undefined
        readonly document: ScreenDocumentV2
        readonly key: string
        readonly activeState: 'ready' | VariantState
        readonly stableKey: string
        readonly path: string
    } | null>(null)
    const shownQuestion = useRef<typeof retained.current>(null)
    // A storage write alone does not invalidate an already displayed fact set. Never apply this to checking/asking,
    // a changed capture/manual/step/result, or newly published saved facts: those must select their actual context.
    const previous = retained.current
    const savingInputs =
        previous === null ? null : documentInputs(previous.document.kind, actualWorkflow, quick, contextualMore)
    const savingKey =
        savingInputs === null
            ? null
            : documentKey({ ...savingInputs, uiState: { ...savingInputs.uiState, busy: null } })
    const savingPreparing =
        focused &&
        onClose === undefined &&
        previous?.activeState === 'ready' &&
        previous.path === pathname &&
        actualWorkflow.state.pending?.startsWith('Saving') === true &&
        !actualWorkflow.state.storageReadOnly &&
        !actualWorkflow.state.loading &&
        savingKey === previous.stableKey
    const preparing = navigationPreparing || savingPreparing
    const questionInputs =
        holdQuestion && kind === 'questions' ? documentInputs(kind, actualWorkflow, quick, contextualMore) : null
    const questionHeld =
        questionInputs !== null &&
        shownQuestion.current?.path === pathname &&
        shownQuestion.current.stableKey ===
            documentKey({ ...questionInputs, uiState: { ...questionInputs.uiState, busy: null } })
            ? shownQuestion.current
            : null
    const held = preparing ? retained.current : questionHeld
    const workflow = held?.workflow ?? actualWorkflow
    const progress = held === null ? quick : held.quick
    const { state, entry } = workflow
    const { controller, nav, compare: compareLauncher } = useWorkflowActions()
    const comparing = preparation?.kind === 'compare'
    const compareNavigation = useMemo(
        (): CompareNavigation => ({ busy: comparing, open: compareLauncher.open }),
        [comparing, compareLauncher.open],
    )
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
    // A new answer can need its own native image load (there may be no Result below this sheet). Keep the complete
    // question waiting presentation until that Answer actually witnesses ready; never show the ready composer again.
    // The automatic handoff skips the sheet's closing animation. The person's own Back and Close retain it.
    const [seenAnswer, setSeenAnswer] = useState(state.answer)
    const questionClosing = useRef(false)
    if (!more.open || more.mode !== 'ask') questionClosing.current = false
    const awaitingAnswer = state.answer !== null && seenAnswer !== state.answer && more.open && more.mode === 'ask'
    if (seenAnswer !== state.answer && !awaitingAnswer) {
        setSeenAnswer(state.answer)
    }
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
                  : state.check !== null ||
                      (state.capture !== null && workflow.controller.pendingCheckCapture === state.capture.binding)
                    ? 'result'
                    : state.pending === null && state.notice !== null && isProblemNotice(state.notice)
                      ? 'recovery'
                      : 'guide'
              : kind
    const inputs = documentInputs(effectiveKind, workflow, progress, contextualMore)
    const cancelledPages = effectiveKind === 'pages' && state.notice?.startsWith('Cancelled.') === true
    const notice =
        operationNotice ??
        (state.notice !== null && (isProblemNotice(state.notice) || cancelledPages) ? plainNotice(state.notice) : null)
    if (['error', 'recovery', 'reading'].includes(effectiveKind))
        inputs.uiState = { ...inputs.uiState, failure: notice === null ? null : { notice: true } }
    if (cancelledPages) inputs.uiState = { ...inputs.uiState, cancelled: { reading: true } }
    if (effectiveKind === 'camera' && camera !== undefined && inputs.uiState?.camera != null)
        inputs.uiState.camera = {
            ...inputs.uiState.camera,
            permission: camera.permission,
            failed: camera.failed ?? false,
            canAskAgain: camera.canAskAgain ?? null,
        }
    const busy = state.pending !== null || state.loading || preparing
    const contextualParent = ['guide', 'result', 'answer', 'recovery'].includes(effectiveKind)
    const moreWarmInput = documentInputs('more', workflow, progress, true)
    const moreWarmKey =
        contextualParent && !busy && focused && !more.open && !judgeOpen ? documentKey(moreWarmInput) : null
    const warmInput = useRef(moreWarmInput)
    warmInput.current = moreWarmInput
    useEffect(() => {
        if (moreWarmKey !== null) workflow.documents?.warmup([warmInput.current])
    }, [workflow.documents, moreWarmKey])
    const queried = useDocument(inputs, {
        focused: focused && !preparing && !more.open && !judgeOpen,
        state:
            readingConfirmation?.open === true
                ? 'confirming'
                : camera?.failed === true
                  ? 'error'
                  : (requestedState ?? (busy ? 'busy' : 'ready')),
    })
    const reading =
        held === null
            ? queried
            : {
                  ...queried,
                  document: held.document,
                  ...activeDocumentVariant(
                      held.document,
                      questionHeld !== null && held.activeState === 'ready' ? 'pending' : held.activeState,
                  ),
                  status: 'ready' as const,
                  issue: null,
              }
    const ownsRoute =
        kind === 'home'
            ? state.route === 'library'
            : kind === 'reading'
              ? state.route === 'pages'
              : kind === 'quick-check'
                ? state.route === 'overview'
                : kind === 'guide'
                  ? state.route === 'guide'
                  : true
    const currentKey = documentKey(inputs)
    useLayoutEffect(() => {
        if (
            !preparing &&
            ownsRoute &&
            retained.current !== null &&
            (retained.current.key !== currentKey || retained.current.document !== queried.document)
        )
            retained.current = null
    }, [preparing, ownsRoute, currentKey, queried.document, queried.activeState])
    // A sheet obscures content without blurring the actual native route and its navigation frame.
    useDocumentOwner(reading.document, focused && !more.open && !judgeOpen, reading.activeState, focused)
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
        if (preparing)
            return intent.intent === 'navigate' && intent.target === 'back'
                ? { enabled: true, reason: null, run: nav.back }
                : { enabled: false, reason: null, run: (): void => {} }
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
                    else if (closeSheet !== undefined) {
                        onQuestionDismiss?.()
                        closeSheet()
                    } else nav.back()
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
                reason: enabled ? null : 'Open settings on your device.',
                run: (): void => {
                    if (enabled) {
                        if (effectiveKind === 'camera' && camera?.openSettings !== undefined) camera.openSettings()
                        else void Linking.openSettings().catch((): void => undefined)
                    }
                },
            }
        }
        if (intent.intent === 'retry' && intent.target === 'screen')
            return { enabled: !busy, reason: busy ? state.pending : null, run: reading.retry }
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
                        const stopping = state.pending?.startsWith('Reading') === true
                        if (entry !== undefined) workflow.documents?.cancelReading(entry.session.manualId)
                        if (stopping) controller.cancel()
                        readingConfirmation?.onChange(false)
                        if (intent.target === 'home') setTimeout((): void => nav.leave(), 0)
                        else setTimeout((): void => nav.editPages(stopping ? { keepNotice: true } : undefined), 0)
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
        if (node.type === 'CoachMark') {
            const origin = reading.document.metadata.origins[path]
            if (origin === undefined) throw new Error(`missing-origin:${path}`)
            candidates.push({
                id: node.targetId,
                kind: node.targetId === 'guide-hero' || node.targetId === 'guide-hero-frame' ? 'surface' : 'control',
                heading: node.heading,
                sentence: node.body,
                textOrigin: origin,
                documentId: reading.document.screenId,
                documentState: reading.activeState,
                documentPath: path,
            })
        }
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
            ...(progress === undefined ? {} : { quick: progress }),
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
                : closeSheet !== undefined &&
                    reading.variant.header.back === null &&
                    reading.variant.bar.primary.intent.intent === 'navigate' &&
                    reading.variant.bar.primary.intent.target === 'back'
                  ? { primary: 'close-sheet' }
                  : kind === 'home' && state.storageReadOnly
                    ? { primary: 'retry-library' }
                    : undefined,
        workInProgress: busy || more.open || judgeOpen,
        preparingDocument: preparing,
        onVariantShown: (document, activeState): void => {
            if (kind === 'questions' && !holdQuestion && document === queried.document)
                shownQuestion.current = {
                    workflow: actualWorkflow,
                    quick,
                    document,
                    key: currentKey,
                    activeState,
                    path: pathname,
                    stableKey: documentKey({ ...inputs, uiState: { ...inputs.uiState, busy: null } }),
                }
            if (
                awaitingAnswer &&
                !questionClosing.current &&
                focused &&
                ownsRoute &&
                onClose === undefined &&
                document.kind === 'answer' &&
                activeState === 'ready' &&
                document === queried.document &&
                documentMatchesInputs(document, inputs)
            ) {
                setSeenAnswer(state.answer)
                more.hide()
            }
            if (
                !preparing &&
                focused &&
                ownsRoute &&
                onClose === undefined &&
                queried.status === 'ready' &&
                document === queried.document &&
                document.metadata.source === 'generated' &&
                documentMatchesInputs(document, inputs)
            )
                retained.current = {
                    workflow: actualWorkflow,
                    quick,
                    document,
                    key: currentKey,
                    activeState,
                    path: pathname,
                    stableKey: documentKey({ ...inputs, uiState: { ...inputs.uiState, busy: null } }),
                }
        },
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
                          ? 'Test fixture'
                          : reading.document.metadata.source,
                  onShowDetails: (): void => setJudgeOpen(true),
              }
            : null,
    }
    return (
        <CompareNavigationContext.Provider value={compareNavigation}>
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
                        holdQuestion={awaitingAnswer}
                        onQuestionDismiss={(): void => {
                            questionClosing.current = true
                        }}
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
        </CompareNavigationContext.Provider>
    )
}
