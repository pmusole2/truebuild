import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { READING_CANCELLATION_V2 } from '@truebuild/contracts'
import { AppUnavailableScreen } from './app-unavailable'
import type { CaptureController } from './controller'
import { createController, createDocuments } from './controller-factory'
import { WorkflowContext, type WorkflowValue } from './workflow-context'
import type { ScreenStore } from '../screens/screen-store'
import { sessionForPrecompute, sessionForScreens } from '../screens/screen-spec'
import { testRestoreDelayMs } from './test-controls'
import type { DocumentStore } from '../document-runtime/store'
import { manualPieceInputs, stepPiecesForStep, type PieceRegistry, type PieceSnapshot } from '../pieces/piece-registry'
import { createPieces } from '../pieces/piece-runtime'
import { homeUiState, pagesUiState, reviewUiState } from '../screens/ui-state'
import { editableQuestions } from './quick-check-model'
import { homeAfterConfirmInputs, newManualInputs } from './document-inputs'

/**
 * The one owner of the capture controller. It is created and restored once above the native Stack and is disposed only
 * when this provider unmounts (app teardown), never on screen blur, push or pop. Production creates the real controller;
 * tests and previews pass their own.
 */
export function WorkflowProvider({
    controller,
    screens,
    documents,
    pieces,
    children,
}: {
    readonly controller?: CaptureController
    readonly screens?: ScreenStore | null
    readonly documents?: DocumentStore | null
    readonly pieces?: PieceRegistry | null
    readonly children: ReactNode
}): ReactElement {
    const [runtime] = useState(
        (): {
            controller: CaptureController | null
            screens: ScreenStore | null
            documents: DocumentStore | null
            pieces: PieceRegistry | null
        } => {
            if (controller !== undefined) {
                return { controller, screens: screens ?? null, documents: documents ?? null, pieces: pieces ?? null }
            }
            try {
                const created = documents ?? createDocuments()
                return {
                    controller: createController(null, created),
                    screens: screens ?? null,
                    documents: created,
                    pieces: pieces ?? createPieces(),
                }
            } catch {
                return { controller: null, screens: null, documents: null, pieces: null }
            }
        },
    )
    return runtime.controller === null ? (
        <AppUnavailableScreen />
    ) : (
        <ControllerHost
            controller={runtime.controller}
            screens={runtime.screens}
            documents={runtime.documents}
            pieces={runtime.pieces}
        >
            {children}
        </ControllerHost>
    )
}

const NO_SUBSCRIPTION = (): (() => void) => (): void => undefined
const NO_PIECES: PieceSnapshot = {
    status: 'idle',
    contentHash: null,
    pieces: [],
    cutouts: {},
    cards: [],
    cardCutouts: {},
    timing: { requestedAt: null, startedAt: null, readyAt: null },
}
const NO_PIECES_SNAPSHOT = (): PieceSnapshot => NO_PIECES

function ControllerHost({
    controller,
    screens,
    documents,
    pieces,
    children,
}: {
    readonly controller: CaptureController
    readonly screens: ScreenStore | null
    readonly documents: DocumentStore | null
    readonly pieces: PieceRegistry | null
    readonly children: ReactNode
}): ReactElement {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    const piecesSnapshot = useSyncExternalStore(
        pieces?.subscribe ?? NO_SUBSCRIPTION,
        pieces?.getSnapshot ?? NO_PIECES_SNAPSHOT,
        NO_PIECES_SNAPSHOT,
    )
    useEffect(() => {
        // Test-only delay (development builds, query parameter) keeps the initial loading state visible for evidence capture.
        const delay = testRestoreDelayMs()
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        if (delay > 0) {
            timer = setTimeout((): void => {
                if (!cancelled) {
                    void controller.restore()
                }
            }, delay)
        } else {
            void controller.restore()
        }
        return (): void => {
            cancelled = true
            if (timer !== undefined) {
                clearTimeout(timer)
            }
            controller.dispose()
        }
    }, [controller])
    const entry = state.entries.find((candidate) => candidate.session.manualId === state.selectedId)
    const session = entry?.session
    // A parsed manual starts its piece registry once: stored results answer, otherwise one background run begins.
    useEffect(() => {
        if (pieces === null || session === undefined || session.parts.length === 0) return
        const firstStepId = session.reviewedSteps[0]?.stepId ?? session.rawExtraction?.steps[0]?.stepId ?? null
        void pieces.prepare(
            { pages: session.pages, parts: manualPieceInputs(session) },
            () => controller.pageImages(session.manualId, session.revision),
            stepPiecesForStep(session, firstStepId).map((piece) => piece.pieceId),
        )
    }, [controller, pieces, session])
    // The context moved on: a newer revision of the selected manual aborts and forgets the older screens. A reviewed
    // manual starts composing every step page in the background, current step first; a fresh read starts them before review.
    useEffect(() => {
        if (screens === null || session === undefined) return
        screens.invalidateManual(session.manualId, session.revision)
        if (session.reviewStatus === 'reviewed') {
            screens.precompute(sessionForScreens(session), session.reviewedSteps[entry?.stepIndex ?? 0]?.stepId ?? null)
        } else if ((session.rawExtraction?.steps.length ?? 0) > 0) {
            // A fresh read starts every step's page at once, before Quick check; confirming then re-grounds them.
            screens.precompute(sessionForPrecompute(session), null)
        }
        // The step index only picks which page goes first; it must not restart a job already running.
    }, [screens, session])
    useEffect(() => {
        if (documents === null || session === undefined || state.loading) return
        documents.observeSession(session)
        const afterConfirm = homeAfterConfirmInputs(state, entry)
        documents.prepareFlow(
            session,
            `guide:${session.reviewedSteps[entry?.stepIndex ?? 0]?.stepId ?? session.rawExtraction?.steps[0]?.stepId ?? ''}`,
            entry === undefined
                ? undefined
                : {
                      kind: 'quick-check',
                      session,
                      stepId: null,
                      captureId: null,
                      result: null,
                      failure: null,
                      uiState: { ...reviewUiState(entry, { current: editableQuestions(session)[0] }), busy: null },
                  },
            {
                ...homeUiState(state.entries),
                ...(entry === undefined ? {} : pagesUiState(entry)),
                reading: { cancellation: READING_CANCELLATION_V2 },
            },
            afterConfirm === null ? [] : [afterConfirm],
        )
    }, [documents, session, state.loading, state.entries])
    // While Home shows, prepare what its two entry points open: Add for the manual it would create (its id and time are
    // reserved by the controller, so the keys match the real ones) and that manual's page camera.
    const homeVisible = state.route === 'library' && state.selectedId === null
    useEffect(() => {
        if (documents === null || documents.mode !== 'full' || !homeVisible || state.loading || state.pending !== null)
            return
        const reserved = controller.reserveManual()
        if (reserved !== null) documents.warmup(newManualInputs(state, reserved))
    }, [controller, documents, homeVisible, state.loading, state.pending, state.storageReadOnly, state.entries])
    useEffect(() => (): void => screens?.dispose(), [screens])
    useEffect(() => (): void => documents?.dispose(), [documents])
    const value = useMemo(
        (): WorkflowValue => ({
            controller,
            state,
            entry,
            screens,
            documents,
            pieces,
            piecesSnapshot,
        }),
        [controller, state, entry, screens, documents, pieces, piecesSnapshot],
    )
    return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>
}

export { useOptionalWorkflow, useWorkflow, type WorkflowValue } from './workflow-context'
