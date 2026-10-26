import type { ManualSession, ManualStep } from '@truebuild/contracts'
import { markManualReviewed } from '../../domain/manual-session'
import { applyManualEdit, ManualEditError, type ManualEdit } from './manual-edits'
import { reviewBlockers } from './raw-review'
import { applyPreview, ExtractionError, type ExtractionPreview } from './model-extraction'

export const DEMO_MANUAL_ID = 'demo-divider'

export type WorkspaceState = {
    readonly session: ManualSession
    // Revision last written to local storage, or the built-in demo's baseline revision; null for an unsaved draft.
    readonly savedRevision: number | null
    readonly selectedStepId: string | null
    readonly notice: string | null
}

export type WorkspaceAction =
    | { readonly type: 'loaded'; readonly session: ManualSession; readonly savedRevision: number | null }
    | { readonly type: 'select-step'; readonly stepId: string }
    | { readonly type: 'edit'; readonly edit: ManualEdit }
    | { readonly type: 'review' }
    | { readonly type: 'apply-extraction'; readonly preview: ExtractionPreview; readonly now: string }
    | { readonly type: 'saved'; readonly revision: number }
    | { readonly type: 'notice'; readonly text: string | null }

function orderedSteps(steps: readonly ManualStep[]): ManualStep[] {
    return [...steps].sort((left, right) => left.order - right.order)
}

function defaultStepId(session: ManualSession): string | null {
    return orderedSteps(session.reviewedSteps)[0]?.stepId ?? null
}

const GENERIC_EDIT_TEXT = 'This change would leave the manual invalid, so it was not applied.'
const GENERIC_EXTRACTION_TEXT = 'This extraction could not be applied. Nothing was changed.'
const GENERIC_REVIEW_TEXT =
    'every critical fact must be known and cited, and each step needs parts, a visible check and a source page.'

function editErrorText(error: unknown): string {
    return error instanceof ManualEditError ? error.message : GENERIC_EDIT_TEXT
}

export function createWorkspaceState(session: ManualSession, savedRevision: number | null): WorkspaceState {
    return {
        session,
        savedRevision,
        selectedStepId: defaultStepId(session),
        notice: null,
    }
}

export function isDemoSession(session: ManualSession): boolean {
    return session.manualId === DEMO_MANUAL_ID
}

// Unsaved edits are those whose revision differs from the last written revision.
export function hasUnsavedChanges(state: WorkspaceState): boolean {
    return state.savedRevision !== state.session.revision
}

export const CHECK_BLOCKED_TEXT = {
    save: 'Save this manual to this device before checking a step. The check reads the saved copy.',
    demo: 'Built-in demo edits are not saved, and the check would load the original demo. Reopen the demo from the library to check it.',
    review: 'Mark the manual reviewed before checking a step.',
} as const

// A step check may only open for the exact state that is saved and reviewed; otherwise it would read an older copy.
export function checkBlockReason(state: WorkspaceState): string | null {
    if (hasUnsavedChanges(state)) {
        return isDemoSession(state.session) ? CHECK_BLOCKED_TEXT.demo : CHECK_BLOCKED_TEXT.save
    }
    if (state.session.reviewStatus !== 'reviewed') {
        return CHECK_BLOCKED_TEXT.review
    }
    return null
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
    switch (action.type) {
        case 'loaded':
            return createWorkspaceState(action.session, action.savedRevision)
        case 'select-step':
            return state.session.reviewedSteps.some((step) => step.stepId === action.stepId)
                ? { ...state, selectedStepId: action.stepId, notice: null }
                : state
        case 'edit':
            try {
                const session = applyManualEdit(state.session, action.edit)
                const selectedStillExists = session.reviewedSteps.some((step) => step.stepId === state.selectedStepId)
                return {
                    ...state,
                    session,
                    selectedStepId: selectedStillExists ? state.selectedStepId : defaultStepId(session),
                    notice: null,
                }
            } catch (error: unknown) {
                return { ...state, notice: editErrorText(error) }
            }
        case 'review':
            try {
                return { ...state, session: markManualReviewed(state.session), notice: null }
            } catch {
                // Keeps the existing label and adds what is specifically missing (an unknown fact or an unconfirmed correction).
                const blockers = reviewBlockers(state.session)
                return {
                    ...state,
                    notice:
                        blockers.length === 0
                            ? `Not reviewed: ${GENERIC_REVIEW_TEXT}.`
                            : `Not reviewed: ${GENERIC_REVIEW_TEXT}. Specifically: ${blockers.slice(0, 3).join(' ')}`,
                }
            }
        case 'apply-extraction':
            // Raw evidence only: reviewed steps and the selected step are untouched. A stale preview is refused here.
            try {
                return { ...state, session: applyPreview(state.session, action.preview, action.now), notice: null }
            } catch (error: unknown) {
                return { ...state, notice: error instanceof ExtractionError ? error.message : GENERIC_EXTRACTION_TEXT }
            }
        case 'saved':
            return { ...state, savedRevision: action.revision, notice: null }
        case 'notice':
            return { ...state, notice: action.text }
    }
}
