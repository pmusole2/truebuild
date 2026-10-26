import { createDemoManual } from '@truebuild/contracts'
import { createWorkspaceState, hasUnsavedChanges, isDemoSession, workspaceReducer } from './workspace-state'

describe('workspaceReducer', () => {
    it('labels the built-in demo and never treats it as saved', () => {
        const state = createWorkspaceState(createDemoManual(), null)

        expect(isDemoSession(state.session)).toBe(true)
        expect(hasUnsavedChanges(state)).toBe(true)
    })

    it('moves selection between steps and ignores unknown step identities', () => {
        const state = createWorkspaceState(createDemoManual(), null)
        const moved = workspaceReducer(state, { type: 'select-step', stepId: 'step-2' })

        expect(moved.selectedStepId).toBe('step-2')
        expect(workspaceReducer(moved, { type: 'select-step', stepId: 'missing' })).toBe(moved)
    })

    it('an edit marks the saved revision stale until the new revision is written', () => {
        const saved = createWorkspaceState(createDemoManual(), 1)
        const edited = workspaceReducer(saved, { type: 'edit', edit: { kind: 'rename', title: 'Renamed' } })

        expect(hasUnsavedChanges(edited)).toBe(true)
        const written = workspaceReducer(edited, { type: 'saved', revision: edited.session.revision })
        expect(hasUnsavedChanges(written)).toBe(false)
    })

    it('reports a failed edit as a fixed user message and keeps the session unchanged', () => {
        const state = createWorkspaceState(createDemoManual(), null)
        const failed = workspaceReducer(state, {
            type: 'edit',
            edit: {
                kind: 'set-step-part-quantity',
                stepId: 'step-1',
                partId: 'side-panel',
                quantity: { state: 'known', quantity: 2.5, pageId: 'demo-page-1' },
            },
        })

        expect(failed.session).toBe(state.session)
        expect(failed.notice).toBe('Quantity must be a whole number of at least 1.')
    })

    it('refuses review while a critical fact is unknown and says so without echoing domain text', () => {
        const unknownOrientation = workspaceReducer(createWorkspaceState(createDemoManual(), null), {
            type: 'edit',
            edit: { kind: 'set-step-orientation', stepId: 'step-1', description: { state: 'unknown' } },
        })
        const reviewed = workspaceReducer(unknownOrientation, { type: 'review' })

        expect(reviewed.session.reviewStatus).toBe('unreviewed')
        expect(reviewed.notice).toMatch(/^Not reviewed: every critical fact/)
    })

    it('marks a clean demo reviewed through the explicit review action', () => {
        const state = createWorkspaceState(createDemoManual(), null)
        const reviewed = workspaceReducer(state, { type: 'review' })

        expect(reviewed.session.reviewStatus).toBe('reviewed')
        expect(reviewed.notice).toBeNull()
    })
})
