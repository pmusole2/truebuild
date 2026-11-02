import type { CaptureController, WorkflowState } from './controller'

/** Rendering only needs these public actions; previews can provide inert actions without constructing application IO. */
export type WorkflowController = Pick<
    CaptureController,
    | 'acceptStepFacts'
    | 'ask'
    | 'camera'
    | 'canCompose'
    | 'cancel'
    | 'completeStep'
    | 'confirm'
    | 'coverageNotice'
    | 'createManual'
    | 'editPage'
    | 'home'
    | 'navigate'
    | 'open'
    | 'parse'
    | 'questionChanged'
    | 'rename'
    | 'restore'
    | 'step'
    | 'targetChanged'
> &
    Partial<Pick<CaptureController, 'pageImages'>>

export type WorkflowScreenProps = { state: WorkflowState; controller: WorkflowController }
