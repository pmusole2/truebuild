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
import { homeUiState, pagesUiState } from '../screens/ui-state'

/**
 * The one owner of the capture controller. It is created and restored once above the native Stack and is disposed only
 * when this provider unmounts (app teardown), never on screen blur, push or pop. Production creates the real controller;
 * tests and previews pass their own.
 */
export function WorkflowProvider({
    controller,
    screens,
    documents,
    children,
}: {
    readonly controller?: CaptureController
    readonly screens?: ScreenStore | null
    readonly documents?: DocumentStore | null
    readonly children: ReactNode
}): ReactElement {
    const [runtime] = useState(
        (): { controller: CaptureController | null; screens: ScreenStore | null; documents: DocumentStore | null } => {
            if (controller !== undefined) {
                return { controller, screens: screens ?? null, documents: documents ?? null }
            }
            try {
                const created = documents ?? createDocuments()
                return { controller: createController(null, created), screens: screens ?? null, documents: created }
            } catch {
                return { controller: null, screens: null, documents: null }
            }
        },
    )
    return runtime.controller === null ? (
        <AppUnavailableScreen />
    ) : (
        <ControllerHost controller={runtime.controller} screens={runtime.screens} documents={runtime.documents}>
            {children}
        </ControllerHost>
    )
}

function ControllerHost({
    controller,
    screens,
    documents,
    children,
}: {
    readonly controller: CaptureController
    readonly screens: ScreenStore | null
    readonly documents: DocumentStore | null
    readonly children: ReactNode
}): ReactElement {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
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
        documents.precompute(
            session,
            session.reviewStatus === 'reviewed'
                ? `guide:${session.reviewedSteps[entry?.stepIndex ?? 0]?.stepId ?? ''}`
                : null,
            {
                ...homeUiState(state.entries),
                ...(entry === undefined ? {} : pagesUiState(entry)),
                reading: { cancellation: READING_CANCELLATION_V2 },
            },
            entry?.completedStepIds,
        )
    }, [documents, session, state.loading, state.entries])
    useEffect(() => (): void => screens?.dispose(), [screens])
    useEffect(() => (): void => documents?.dispose(), [documents])
    const value = useMemo(
        (): WorkflowValue => ({ controller, state, entry, screens, documents }),
        [controller, state, entry, screens, documents],
    )
    return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>
}

export { useOptionalWorkflow, useWorkflow, type WorkflowValue } from './workflow-context'
