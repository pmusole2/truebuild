import { createDemoManual, manualSessionSchema, type ManualSession, type ManualStep } from '@truebuild/contracts'
import { fireEvent, render, within } from '@testing-library/react-native'
import { applyManualEdit, ManualEditError, type ManualEdit } from './manual-edits'
import { PartsEditor } from './parts-editor'
import { StepEditor } from './step-editor'

type RenderedView = Awaited<ReturnType<typeof render>>
type EditSpy = jest.Mock<void, [ManualEdit]>

const demo = createDemoManual()
const UNKNOWN = { state: 'unknown' as const, reason: 'Not confirmed from the imported manual pages.' }

function stepById(session: ManualSession, stepId: string): ManualStep {
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)

    if (step === undefined) {
        throw new Error(`fixture is missing ${stepId}`)
    }

    return step
}

// Unreviewed, so that unknown critical facts are valid fixtures.
function draftWith(session: ManualSession, update: (steps: ManualStep[]) => ManualStep[]): ManualSession {
    return manualSessionSchema.parse({
        ...session,
        reviewStatus: 'unreviewed',
        reviewedSteps: update(session.reviewedSteps),
    })
}

function replaceStep(session: ManualSession, stepId: string, change: (step: ManualStep) => ManualStep): ManualSession {
    return draftWith(session, (steps) => steps.map((step) => (step.stepId === stepId ? change(step) : step)))
}

async function renderStep(
    session: ManualSession,
    stepId: string,
    citePageId = 'demo-page-1',
): Promise<{ view: RenderedView; onEdit: EditSpy }> {
    const onEdit: EditSpy = jest.fn<void, [ManualEdit]>((_edit: ManualEdit): void => undefined)
    const view = await render(
        <StepEditor
            session={session}
            step={stepById(session, stepId)}
            citePageId={citePageId}
            isFirst={false}
            isLast={false}
            onEdit={onEdit}
            onOpenCheck={(): void => undefined}
            checkBlockedReason={null}
        />,
    )

    return { view, onEdit }
}

// The edit the editor most recently sent. Applying it through the real edit layer shows the resulting fact.
function lastEdit(onEdit: EditSpy): ManualEdit {
    const edit = onEdit.mock.calls.at(-1)?.[0]

    if (edit === undefined) {
        throw new Error('the editor sent no edit')
    }

    return edit
}

function within_(view: RenderedView, testID: string): ReturnType<typeof within> {
    return within(view.getByTestId(testID))
}

function isChecked(view: RenderedView, name: string): boolean | undefined {
    return view.getByRole('checkbox', { name }).props.accessibilityState?.checked
}

describe('StepEditor connection targets', () => {
    it('lets a fresh unknown connection on a one-part step select its part and saves that explicit selection', async () => {
        const session = replaceStep(demo, 'step-1', (step) => ({ ...step, connection: UNKNOWN }))
        const { view, onEdit } = await renderStep(session, 'step-1')
        const connection = within_(view, 'fact-connection')

        expect(isChecked(view, 'Side panel')).toBe(false)
        await fireEvent.press(view.getByRole('checkbox', { name: 'Side panel' }))
        expect(isChecked(view, 'Side panel')).toBe(true)
        expect(view.getByText('Target parts: Side panel')).toBeTruthy()

        await fireEvent.changeText(connection.getByLabelText('Connection description'), 'Seats in the groove')
        await fireEvent.press(connection.getByRole('button', { name: 'Save fact' }))

        expect(lastEdit(onEdit)).toEqual({
            kind: 'set-step-connection',
            stepId: 'step-1',
            description: { state: 'known', text: 'Seats in the groove', pageId: 'demo-page-1' },
            partIds: ['side-panel'],
        })
        const saved = stepById(applyManualEdit(session, lastEdit(onEdit)), 'step-1')
        expect(saved.connection).toMatchObject({ state: 'known', value: { partIds: ['side-panel'] } })
    })

    it('still requires a choice for a one-part unknown connection: nothing selected is refused, never filled in', async () => {
        const session = replaceStep(demo, 'step-1', (step) => ({ ...step, connection: UNKNOWN }))
        const { view, onEdit } = await renderStep(session, 'step-1')
        const connection = within_(view, 'fact-connection')

        expect(view.getByText('Select at least one target part.')).toBeTruthy()
        await fireEvent.changeText(connection.getByLabelText('Connection description'), 'Seats in the groove')
        await fireEvent.press(connection.getByRole('button', { name: 'Save fact' }))

        expect(lastEdit(onEdit)).toMatchObject({ kind: 'set-step-connection', partIds: [] })
        expect(() => applyManualEdit(session, lastEdit(onEdit))).toThrow(ManualEditError)
        expect(stepById(session, 'step-1').connection.state).toBe('unknown')
    })

    it('refuses deselect-all on a known connection and leaves the saved connection in place', async () => {
        const { view, onEdit } = await renderStep(demo, 'step-1')
        const connection = within_(view, 'fact-connection')

        expect(isChecked(view, 'Side panel')).toBe(true)
        await fireEvent.press(view.getByRole('checkbox', { name: 'Side panel' }))
        await fireEvent.press(connection.getByRole('button', { name: 'Save fact' }))

        expect(lastEdit(onEdit)).toMatchObject({ kind: 'set-step-connection', partIds: [] })
        expect(() => applyManualEdit(demo, lastEdit(onEdit))).toThrow(ManualEditError)
        expect(stepById(demo, 'step-1').connection).toMatchObject({
            state: 'known',
            value: { partIds: ['side-panel'] },
        })
    })

    it('saves an explicit subset of a two-part connection and never widens it to every required part', async () => {
        const { view, onEdit } = await renderStep(demo, 'step-2')

        await fireEvent.press(view.getByRole('checkbox', { name: 'Divider shelf' }))
        await fireEvent.press(within_(view, 'fact-connection').getByRole('button', { name: 'Save fact' }))

        expect(lastEdit(onEdit)).toMatchObject({ kind: 'set-step-connection', partIds: ['side-panel'] })
        const saved = stepById(applyManualEdit(demo, lastEdit(onEdit)), 'step-2')
        expect(saved.connection).toMatchObject({ state: 'known', value: { partIds: ['side-panel'] } })
    })

    it('keeps every existing connection target on a description-only save', async () => {
        const { view, onEdit } = await renderStep(demo, 'step-2')
        const connection = within_(view, 'fact-connection')

        await fireEvent.changeText(connection.getByLabelText('Connection description'), 'Rests in the groove')
        await fireEvent.press(connection.getByRole('button', { name: 'Save fact' }))

        expect(lastEdit(onEdit)).toMatchObject({ partIds: ['side-panel', 'divider'] })
        const saved = stepById(applyManualEdit(demo, lastEdit(onEdit)), 'step-2')
        expect(saved.connection).toMatchObject({
            state: 'known',
            value: { partIds: ['side-panel', 'divider'], description: 'Rests in the groove' },
        })
    })
})

describe('StepEditor orientation target', () => {
    it('keeps the existing oriented part when only the description is saved', async () => {
        const { view, onEdit } = await renderStep(demo, 'step-2')

        await fireEvent.press(within_(view, 'fact-orientation').getByRole('button', { name: 'Save fact' }))

        const saved = stepById(applyManualEdit(demo, lastEdit(onEdit)), 'step-2')
        expect(saved.orientation).toMatchObject({ state: 'known', value: { partId: 'divider' } })
    })
})

describe('StepEditor citation attribution', () => {
    // Three pages in the manual; the demo page stays first so the selected-page hint can say page 1.
    const threePages = (): ManualSession => {
        const [first] = demo.pages

        if (first === undefined) {
            throw new Error('fixture has no page')
        }

        return {
            ...demo,
            pages: [
                first,
                { ...first, pageId: 'page-2', assetId: 'asset-2', contentHash: 'c'.repeat(64) },
                { ...first, pageId: 'page-3', assetId: 'asset-3', contentHash: 'd'.repeat(64) },
            ],
        }
    }

    const orientationCitedOnlyToPageThree = (session: ManualSession): ManualSession =>
        replaceStep(session, 'step-1', (step) => ({
            ...step,
            orientation: {
                state: 'known',
                value: { partId: 'side-panel', description: 'Groove faces inward.' },
                sourceRefs: [{ pageId: 'page-3', region: null }],
            },
        }))

    it('shows the real page of a fact cited only to page 3, with page 1 as the next-save hint, and no raw identifiers', async () => {
        const session = orientationCitedOnlyToPageThree(threePages())
        const { view } = await renderStep(session, 'step-1', 'demo-page-1')

        expect(
            within_(view, 'fact-orientation').getByText('Known — cited to page 3. Next save will cite page 1.'),
        ).toBeTruthy()
        expect(view.queryByText(/page-3|demo-page|side-panel/)).toBeNull()
    })

    it('shows a fact cited to pages 1 and 3 as those two pages, and no hint when page 3 is the selected page', async () => {
        const session = replaceStep(threePages(), 'step-1', (step) => ({
            ...step,
            connection: {
                state: 'known',
                value: { partIds: ['side-panel'], description: 'Seats in the groove.' },
                sourceRefs: [
                    { pageId: 'page-3', region: null },
                    { pageId: 'demo-page-1', region: null },
                    { pageId: 'page-3', region: null },
                ],
            },
        }))
        const { view } = await renderStep(session, 'step-1', 'page-3')

        expect(within_(view, 'fact-connection').getByText('Known — cited to pages 1, 3.')).toBeTruthy()
    })

    it('shows a quantity cited only to page 3 by its page number rather than by its position among cited pages', async () => {
        const session = replaceStep(threePages(), 'step-1', (step) => ({
            ...step,
            parts: step.parts.map((part) => ({
                ...part,
                quantity: { state: 'known', value: 1, sourceRefs: [{ pageId: 'page-3', region: null }] },
            })),
        }))
        const { view } = await renderStep(session, 'step-1', 'demo-page-1')

        expect(
            within_(view, 'fact-quantity-side-panel').getByText('Known — cited to page 3. Next save will cite page 1.'),
        ).toBeTruthy()
    })

    it('shows a part name cited only to page 3 by its page number in the parts editor', async () => {
        const session = manualSessionSchema.parse({
            ...threePages(),
            parts: demo.parts.map((part) =>
                part.partId === 'side-panel'
                    ? {
                          ...part,
                          name: {
                              state: 'known',
                              value: 'Side panel',
                              sourceRefs: [{ pageId: 'page-3', region: null }],
                          },
                      }
                    : part,
            ),
        })
        const view = await render(
            <PartsEditor session={session} citePageId="demo-page-1" onEdit={(): void => undefined} />,
        )

        expect(
            within_(view, 'fact-part-name-side-panel').getByText(
                'Known — cited to page 3. Next save will cite page 1.',
            ),
        ).toBeTruthy()
    })

    it('follows the stable page when the manual is reordered', async () => {
        const session = orientationCitedOnlyToPageThree(threePages())
        const { view } = await renderStep(session, 'step-1', 'demo-page-1')
        const [first, second, third] = session.pages

        if (first === undefined || second === undefined || third === undefined) {
            throw new Error('fixture needs three pages')
        }

        const reordered = manualSessionSchema.parse({ ...session, pages: [third, first, second] })
        await view.rerender(
            <StepEditor
                session={reordered}
                step={stepById(reordered, 'step-1')}
                citePageId="demo-page-1"
                isFirst={false}
                isLast={false}
                onEdit={(): void => undefined}
                onOpenCheck={(): void => undefined}
                checkBlockedReason={null}
            />,
        )

        expect(
            within_(view, 'fact-orientation').getByText('Known — cited to page 1. Next save will cite page 2.'),
        ).toBeTruthy()
    })
})
