import {
    createDemoManual,
    manualSessionSchema,
    type Fact,
    type ManualSession,
    type ManualStep,
} from '@truebuild/contracts'
import { applyManualEdit, ManualEditError } from './manual-edits'

function knownValue<T>(fact: Fact<T>): T {
    if (fact.state !== 'known') {
        throw new Error(`expected a known fact, found ${fact.state}`)
    }

    return fact.value
}

function stepOf(session: ManualSession, stepId: string): ManualStep {
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)

    if (step === undefined) {
        throw new Error(`fixture is missing ${stepId}`)
    }

    return step
}

describe('applyManualEdit', () => {
    it('any structural edit bumps the revision and clears the reviewed status', () => {
        const demo = createDemoManual()
        const edited = applyManualEdit(demo, { kind: 'rename', title: 'Shelf kit, my copy' })

        expect(edited.revision).toBe(demo.revision + 1)
        expect(edited.reviewStatus).toBe('unreviewed')
        expect(edited.title).toBe('Shelf kit, my copy')
    })

    it('moving a step swaps the order values of its neighbour', () => {
        const edited = applyManualEdit(createDemoManual(), { kind: 'move-step', stepId: 'step-1', direction: 1 })
        const orders = Object.fromEntries(edited.reviewedSteps.map((step) => [step.stepId, step.order]))

        expect(orders).toEqual({ 'step-1': 2, 'step-2': 1 })
    })

    it('rejects a quantity that is not a whole number of at least one, with a user-facing message', () => {
        expect(() =>
            applyManualEdit(createDemoManual(), {
                kind: 'set-step-part-quantity',
                stepId: 'step-1',
                partId: 'side-panel',
                quantity: { state: 'known', quantity: 0, pageId: 'demo-page-1' },
            }),
        ).toThrow(new ManualEditError('Quantity must be a whole number of at least 1.'))
    })

    it('records an unknown orientation explicitly instead of inventing a value', () => {
        const edited = applyManualEdit(createDemoManual(), {
            kind: 'set-step-orientation',
            stepId: 'step-2',
            description: { state: 'unknown' },
        })

        expect(stepOf(edited, 'step-2').orientation.state).toBe('unknown')
        expect(edited.reviewStatus).toBe('unreviewed')
    })

    it('refuses a known connection on a step that requires no parts', () => {
        const withoutParts = applyManualEdit(createDemoManual(), {
            kind: 'remove-step-part',
            stepId: 'step-1',
            partId: 'side-panel',
        })

        expect(() =>
            applyManualEdit(withoutParts, {
                kind: 'set-step-connection',
                stepId: 'step-1',
                description: { state: 'known', text: 'Seats in the groove', pageId: 'demo-page-1' },
            }),
        ).toThrow(ManualEditError)
    })

    it('keeps the immutable raw extraction separate from reviewed edits', () => {
        const demo = createDemoManual()
        const edited = applyManualEdit(demo, { kind: 'set-step-title', stepId: 'step-1', title: 'Stand the panel' })

        expect(edited.rawExtraction).toEqual(demo.rawExtraction)
    })

    it('moves a page without changing identifiers, citations or raw extraction, and unreviews the manual', () => {
        const demo = createDemoManual()
        const second = { ...demo.pages[0], pageId: 'page-2', assetId: 'asset-2', contentHash: 'f'.repeat(64) }
        const twoPages = manualSessionSchema.parse({ ...demo, pages: [...demo.pages, second] })

        const moved = applyManualEdit(twoPages, { kind: 'move-page', pageId: 'page-2', direction: -1 })

        expect(moved.pages.map((page) => page.pageId)).toEqual(['page-2', 'demo-page-1'])
        expect(moved.pages.map((page) => page.assetId)).toEqual(['asset-2', 'demo-asset-1'])
        expect(moved.revision).toBe(twoPages.revision + 1)
        expect(moved.reviewStatus).toBe('unreviewed')
        expect(moved.rawExtraction).toEqual(twoPages.rawExtraction)
        expect(moved.reviewedSteps).toEqual(twoPages.reviewedSteps)
        expect(() => applyManualEdit(moved, { kind: 'move-page', pageId: 'page-2', direction: -1 })).toThrow(
            ManualEditError,
        )
    })
})

describe('orientation target rules', () => {
    it('keeps the existing oriented part for a description-only save of a known orientation', () => {
        const demo = createDemoManual()
        const edited = applyManualEdit(demo, {
            kind: 'set-step-orientation',
            stepId: 'step-2',
            description: {
                state: 'known',
                text: 'Divider is horizontal and square to the upright panel.',
                pageId: 'demo-page-1',
            },
        })

        expect(knownValue(stepOf(demo, 'step-2').orientation).partId).toBe('divider')
        expect(knownValue(stepOf(edited, 'step-2').orientation)).toEqual({
            partId: 'divider',
            description: 'Divider is horizontal and square to the upright panel.',
        })
    })

    it('uses an explicit orientation target when one is selected', () => {
        const edited = applyManualEdit(createDemoManual(), {
            kind: 'set-step-orientation',
            stepId: 'step-2',
            description: { state: 'known', text: 'The panel is vertical', pageId: 'demo-page-1' },
            partId: 'side-panel',
        })

        expect(knownValue(stepOf(edited, 'step-2').orientation).partId).toBe('side-panel')
    })

    it('refuses a description-only orientation save when there is no known target to keep', () => {
        const demo = createDemoManual()
        const unknownTarget = applyManualEdit(demo, {
            kind: 'set-step-orientation',
            stepId: 'step-2',
            description: { state: 'unknown' },
        })

        expect(() =>
            applyManualEdit(unknownTarget, {
                kind: 'set-step-orientation',
                stepId: 'step-2',
                description: { state: 'known', text: 'Horizontal', pageId: 'demo-page-1' },
            }),
        ).toThrow(ManualEditError)
    })
})

describe('connection target rules', () => {
    const connectionText = { state: 'known' as const, text: 'Rests in the groove', pageId: 'demo-page-1' }

    it('keeps the saved target set, including a two-part subset, on a description-only save', () => {
        const demo = createDemoManual()
        const edited = applyManualEdit(demo, {
            kind: 'set-step-connection',
            stepId: 'step-2',
            description: connectionText,
        })

        expect(knownValue(stepOf(demo, 'step-2').connection).partIds).toEqual(['side-panel', 'divider'])
        expect(knownValue(stepOf(edited, 'step-2').connection)).toEqual({
            partIds: ['side-panel', 'divider'],
            description: 'Rests in the groove',
        })
    })

    it('saves exactly the selected subset and never widens it to every required part', () => {
        const edited = applyManualEdit(createDemoManual(), {
            kind: 'set-step-connection',
            stepId: 'step-2',
            description: connectionText,
            partIds: ['divider'],
        })

        expect(knownValue(stepOf(edited, 'step-2').connection).partIds).toEqual(['divider'])
    })

    it('refuses an explicit empty selection and keeps the existing known connection untouched', () => {
        const demo = createDemoManual()

        expect(() =>
            applyManualEdit(demo, {
                kind: 'set-step-connection',
                stepId: 'step-1',
                description: connectionText,
                partIds: [],
            }),
        ).toThrow(ManualEditError)
        expect(knownValue(stepOf(demo, 'step-1').connection).partIds).toEqual(['side-panel'])
    })

    it('refuses a description-only save of an unknown connection instead of choosing all required parts', () => {
        const unknown = applyManualEdit(createDemoManual(), {
            kind: 'set-step-connection',
            stepId: 'step-2',
            description: { state: 'unknown' },
        })

        expect(() =>
            applyManualEdit(unknown, { kind: 'set-step-connection', stepId: 'step-2', description: connectionText }),
        ).toThrow(ManualEditError)
    })

    it('refuses an explicit selection of an unknown connection with no parts selected', () => {
        const unknown = applyManualEdit(createDemoManual(), {
            kind: 'set-step-connection',
            stepId: 'step-2',
            description: { state: 'unknown' },
        })

        expect(() =>
            applyManualEdit(unknown, {
                kind: 'set-step-connection',
                stepId: 'step-2',
                description: connectionText,
                partIds: [],
            }),
        ).toThrow(ManualEditError)
    })

    it('refuses a selection that names a part the step does not require', () => {
        expect(() =>
            applyManualEdit(createDemoManual(), {
                kind: 'set-step-connection',
                stepId: 'step-1',
                description: connectionText,
                partIds: ['divider'],
            }),
        ).toThrow(ManualEditError)
    })

    it('refuses a selection that names the same part twice', () => {
        expect(() =>
            applyManualEdit(createDemoManual(), {
                kind: 'set-step-connection',
                stepId: 'step-2',
                description: connectionText,
                partIds: ['divider', 'divider'],
            }),
        ).toThrow(ManualEditError)
    })

    it('shows user-facing wording, never an internal identifier, when a selection is refused', () => {
        let message = ''

        try {
            applyManualEdit(createDemoManual(), {
                kind: 'set-step-connection',
                stepId: 'step-1',
                description: connectionText,
                partIds: ['divider'],
            })
        } catch (error: unknown) {
            message = error instanceof Error ? error.message : ''
        }

        expect(message).toBe('A selected part is no longer required by this step. Update the connection parts.')
        expect(message).not.toContain('divider')
    })
})
