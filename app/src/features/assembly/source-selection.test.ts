import { createDemoManual } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { selectedStepSourcePageIds } from './source-selection'

describe('shared full-context source selector', () => {
    it('retains all twenty manual pages in manual order, including pages not cited by this step', () => {
        const session = createDemoManual()
        const first = session.pages[0]!
        session.pages.push(
            ...Array.from({ length: 19 }, (_, index) => ({
                ...first,
                pageId: `page-${19 - index}`,
                assetId: `asset-${19 - index}`,
            })),
        )
        expect(selectedStepSourcePageIds(session, session.reviewedSteps[0]!)).toEqual(
            session.pages.map((page) => page.pageId),
        )
    })
    it('fails closed for an unknown step or more than twenty pages', () => {
        const session = createDemoManual()
        const step = session.reviewedSteps[0]!
        expect(selectedStepSourcePageIds(session, { ...step, stepId: 'unknown' })).toEqual([])
        session.pages.push(
            ...Array.from({ length: 20 }, (_, index) => ({
                ...session.pages[0]!,
                pageId: `extra-${index}`,
                assetId: `asset-${index}`,
            })),
        )
        expect(selectedStepSourcePageIds(session, step)).toEqual([])
    })
})
