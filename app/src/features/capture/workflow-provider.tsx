import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
    type ReactElement,
    type ReactNode,
} from 'react'
import { AppUnavailableScreen } from './app-unavailable'
import type { CaptureController, WorkflowState } from './controller'
import { createController } from './controller-factory'
import type { LibraryEntry } from './library'
import { testRestoreDelayMs } from './test-controls'

export type WorkflowValue = {
    readonly controller: CaptureController
    readonly state: WorkflowState
    // The selected manual, or undefined on Home. Derived from the same snapshot as `state`.
    readonly entry: LibraryEntry | undefined
}

const WorkflowContext = createContext<WorkflowValue | null>(null)

/**
 * The one owner of the capture controller. It is created and restored once above the native Stack and is disposed only
 * when this provider unmounts (app teardown), never on screen blur, push or pop. Production creates the real controller;
 * tests and previews pass their own.
 */
export function WorkflowProvider({
    controller,
    children,
}: {
    readonly controller?: CaptureController
    readonly children: ReactNode
}): ReactElement {
    const [runtime] = useState((): { controller: CaptureController | null } => {
        if (controller !== undefined) {
            return { controller }
        }
        try {
            return { controller: createController() }
        } catch {
            return { controller: null }
        }
    })
    return runtime.controller === null ? (
        <AppUnavailableScreen />
    ) : (
        <ControllerHost controller={runtime.controller}>{children}</ControllerHost>
    )
}

function ControllerHost({
    controller,
    children,
}: {
    readonly controller: CaptureController
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
    const value = useMemo(
        (): WorkflowValue => ({
            controller,
            state,
            entry: state.entries.find((candidate) => candidate.session.manualId === state.selectedId),
        }),
        [controller, state],
    )
    return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>
}

export function useWorkflow(): WorkflowValue {
    const value = useContext(WorkflowContext)
    if (value === null) {
        throw new Error('useWorkflow must be used inside WorkflowProvider')
    }
    return value
}
