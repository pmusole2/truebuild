import type { ReactElement } from 'react'
import type { WorkflowState } from '../capture/controller'
import type { LibraryEntry } from '../capture/library'
import type { QuickProgress } from '../capture/review-screen'
import type { MoreControl } from '../capture/screen-header'
import type { ScreenNav } from '../capture/screen-nav'
import type { WorkflowController } from '../capture/workflow-types'

/**
 * The live app facts a composed block reads at render time. A block never carries data of its own: titles, thumbnails,
 * progress, the current question and the held photo come from here, so a document can choose what to show and where
 * but can never state a value the app did not read from its own library and controller.
 */
export type LiveScreen = {
    readonly state: WorkflowState
    readonly entry: LibraryEntry | undefined
    readonly controller: WorkflowController
    readonly nav: ScreenNav
    readonly more: MoreControl
    /** Quick check: the questions and the one being asked. */
    readonly quick?: QuickProgress
    /** Add/Pages: what a tapped page does and which pages are still arriving. */
    readonly pages?: {
        readonly open: (pageId: string) => void
        readonly arriving: ReadonlySet<string>
    }
    /** Guide: the held photo at hero size with its returned regions, as the guide draws it. */
    readonly heroCapture?: (height: number) => ReactElement | null
    /** Guide: parts of the current step a question can be about, and whether asking is blocked. */
    readonly ask?: {
        readonly choices: readonly { readonly partId: string; readonly label: string }[]
        readonly editable: boolean
        readonly blocked: boolean
        readonly targetSummary: string
    }
    /** Called after a composed editor saved or was cancelled. */
    readonly closeSheet?: () => void
}
