import { createContext, useContext } from 'react'
import type { ManualSession, ScreenContextInputsV2 } from '@truebuild/contracts'
import type { LibraryEntry } from '../capture/library'

// What the Compare screen and the navigation that opens it must agree on. This stays a leaf (no screen or route
// imports): native-routes already reaches the judge controls through the document renderer, so a shared import there
// would be a cycle.

export function comparable(entry: LibraryEntry): boolean {
    return entry.session.reviewStatus === 'reviewed' && entry.session.reviewedSteps.length > 0
}

/** The finished manuals in library order, and the first two, which Compare shows until a person chooses others. */
export function compareChoices(entries: readonly LibraryEntry[]): {
    readonly available: readonly string[]
    readonly defaults: readonly string[]
} {
    const available = entries.filter(comparable).map((entry) => entry.session.manualId)
    return { available, defaults: available.slice(0, 2) }
}

/** The manuals drawn for these chosen ids. */
export function compareEntries(entries: readonly LibraryEntry[], ids: readonly string[]): LibraryEntry[] {
    return ids.flatMap((id) => entries.filter((entry) => entry.session.manualId === id && comparable(entry)))
}

/** The manuals Compare shows when it opens. */
export function compareOpeningEntries(entries: readonly LibraryEntry[]): LibraryEntry[] {
    return compareEntries(entries, compareChoices(entries).defaults)
}

/** The exact document a pane requests: a real v2 guide on its manual's first reviewed step, with no photo or result. */
export function comparePaneInputs(session: ManualSession): ScreenContextInputsV2 {
    return {
        kind: 'guide',
        session,
        stepId: session.reviewedSteps[0]?.stepId ?? null,
        captureId: null,
        result: null,
        failure: null,
    }
}

/**
 * Opens Compare for the judge controls. With generated screens on, the outer Compare and both opening panes are
 * prepared while the caller stays as it is; `dismiss` closes the caller's sheets only once Compare is about to open.
 * The returned function ends the wait if the control that asked leaves the screen.
 */
export type CompareNavigation = {
    readonly busy: boolean
    readonly open: (dismiss?: () => void) => () => void
}

export const CompareNavigationContext = createContext<CompareNavigation | null>(null)

/** Null outside a document surface (previews, isolated tests): the control then opens Compare at once. */
export function useCompareNavigation(): CompareNavigation | null {
    return useContext(CompareNavigationContext)
}
