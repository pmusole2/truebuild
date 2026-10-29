import { createContext, useContext } from 'react'
import type { CaptureController, WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import type { ScreenStore } from '../screens/screen-store'

export type WorkflowValue = {
    readonly controller: CaptureController
    readonly state: WorkflowState
    // The selected manual, or undefined on Home. Derived from the same snapshot as `state`.
    readonly entry: LibraryEntry | undefined
    // Composes the session's screens. Null when generated screens are off or the owner did not provide one.
    readonly screens: ScreenStore | null
}

export const WorkflowContext = createContext<WorkflowValue | null>(null)

export function useWorkflow(): WorkflowValue {
    const value = useContext(WorkflowContext)
    if (value === null) {
        throw new Error('useWorkflow must be used inside WorkflowProvider')
    }
    return value
}

/** For parts that may render outside the provider (previews, isolated tests): null instead of throwing. */
export function useOptionalWorkflow(): WorkflowValue | null {
    return useContext(WorkflowContext)
}
