import { describe, expect, it } from 'vitest'
import { checkResultSchema, manualSessionSchema, questionResultSchema } from '@truebuild/contracts'
import { WORKFLOW_PREVIEW_CASES, workflowPreviewFixture } from './workflow-fixtures'

describe('synthetic workflow preview fixtures', () => {
    it('keeps every selectable workflow state valid and all imagery inline', () => {
        expect(WORKFLOW_PREVIEW_CASES).toHaveLength(19)
        for (const preview of WORKFLOW_PREVIEW_CASES) {
            const { state, entry } = workflowPreviewFixture(preview.id)
            expect(manualSessionSchema.safeParse(entry.session).success, preview.id).toBe(true)
            for (const uri of Object.values(state.pageUris)) {
                expect(uri.startsWith('data:image/'), preview.id).toBe(true)
            }
            if (state.capture !== null) {
                expect(state.capture.observation.uri.startsWith('data:image/'), preview.id).toBe(true)
                expect(state.capture.observation.bytes.byteLength).toBeGreaterThan(0)
            }
            if (state.check !== null) {
                expect(checkResultSchema.safeParse(state.check).success, preview.id).toBe(true)
            }
            if (state.answer !== null) {
                expect(questionResultSchema.safeParse(state.answer).success, preview.id).toBe(true)
                expect(state.check).toBeNull()
            }
        }
    })

    it('creates independent synthetic snapshots and keeps unresolved facts unknown', () => {
        const unresolved = workflowPreviewFixture('review-unresolved')
        expect(unresolved.entry.session.reviewStatus).not.toBe('reviewed')
        expect(unresolved.entry.session.reviewedSteps[0]?.orientation.state).toBe('unknown')
        unresolved.entry.session.title = 'Local draft'
        expect(workflowPreviewFixture('review-ready').entry.session.title).not.toBe('Local draft')
        expect(workflowPreviewFixture('home-empty').state.entries).toEqual([])
        expect(workflowPreviewFixture('guide-empty').state.capture).toBeNull()
    })
})
