import { createDemoManual, manualSessionSchema, type ManualSession } from '@truebuild/contracts'
import { fireEvent, render, within } from '@testing-library/react-native'
import { CHECK_BLOCKED_TEXT } from './workspace-state'
import { ManualScreen } from './manual-screen'
import { localStore } from './local-store'

jest.mock('./local-store', () => ({
    localStore: {
        saveManual: jest.fn(async (): Promise<void> => undefined),
        loadManual: jest.fn(async (): Promise<null> => null),
        deleteManual: jest.fn(async (): Promise<void> => undefined),
        loadPageAsset: jest.fn(async (): Promise<null> => null),
    },
}))

const demo = createDemoManual()

type RenderedScreen = Awaited<ReturnType<typeof render>>

async function openScreen(
    session: ManualSession,
    savedRevision: number | null,
    onOpenCheck: (stepId: string) => void,
): Promise<RenderedScreen> {
    return render(
        <ManualScreen
            initialSession={session}
            initialSavedRevision={savedRevision}
            onOpenCheck={onOpenCheck}
            onDeleted={() => undefined}
        />,
    )
}

function openCheckButton(view: RenderedScreen): ReturnType<RenderedScreen['getByRole']> {
    return view.getByRole('button', { name: 'Open step check' })
}

describe('ManualScreen', () => {
    it('labels the built-in demo as simulated and blocks saving or deleting it', async () => {
        const view = await openScreen(demo, demo.revision, () => undefined)

        expect(view.getAllByText('Demo data — simulated results').length).toBeGreaterThan(0)
        expect(view.getByRole('button', { name: 'Save to device' }).props.accessibilityState?.disabled).toBe(true)
        expect(view.getByRole('button', { name: 'Delete manual' }).props.accessibilityState?.disabled).toBe(true)
    })

    it('marks an edited demo unreviewed until the explicit review action runs', async () => {
        const view = await openScreen(demo, demo.revision, () => undefined)
        await fireEvent.changeText(view.getByLabelText('Manual title'), 'Renamed copy')
        await fireEvent.press(view.getByRole('button', { name: 'Rename' }))

        expect(view.getAllByText('Unreviewed').length).toBeGreaterThan(0)
        await fireEvent.press(view.getByRole('button', { name: 'Mark reviewed' }))
        expect(view.getAllByText('Reviewed').length).toBeGreaterThan(0)
    })

    it('opens the step check for an unedited reviewed demo', async () => {
        const onOpenCheck = jest.fn()
        const view = await openScreen(demo, demo.revision, onOpenCheck)

        await fireEvent.press(openCheckButton(view))
        expect(onOpenCheck).toHaveBeenCalledWith('step-1')
    })

    it('blocks the step check after an edit to the demo and never opens the original', async () => {
        const onOpenCheck = jest.fn()
        const view = await openScreen(demo, demo.revision, onOpenCheck)
        await fireEvent.changeText(view.getByLabelText('Manual title'), 'Renamed copy')
        await fireEvent.press(view.getByRole('button', { name: 'Rename' }))

        expect(openCheckButton(view).props.accessibilityState?.disabled).toBe(true)
        expect(view.getByText(CHECK_BLOCKED_TEXT.demo)).toBeTruthy()
        await fireEvent.press(openCheckButton(view))
        expect(onOpenCheck).not.toHaveBeenCalled()
    })

    it('blocks the step check for a reviewed saved manual with unsaved edits until it is saved', async () => {
        const onOpenCheck = jest.fn()
        const saved: ManualSession = { ...demo, manualId: 'saved-manual' }
        const view = await openScreen(saved, saved.revision, onOpenCheck)
        await fireEvent.changeText(view.getByLabelText('Manual title'), 'Renamed copy')
        await fireEvent.press(view.getByRole('button', { name: 'Rename' }))

        expect(view.getByText(CHECK_BLOCKED_TEXT.save)).toBeTruthy()
        await fireEvent.press(openCheckButton(view))
        expect(onOpenCheck).not.toHaveBeenCalled()
    })

    it('blocks the step check for an unreviewed saved draft and asks for review', async () => {
        const onOpenCheck = jest.fn()
        const draft: ManualSession = { ...demo, manualId: 'saved-draft', reviewStatus: 'unreviewed' }
        const view = await openScreen(draft, draft.revision, onOpenCheck)

        expect(view.getByText(CHECK_BLOCKED_TEXT.review)).toBeTruthy()
        await fireEvent.press(openCheckButton(view))
        expect(onOpenCheck).not.toHaveBeenCalled()
    })

    it('preserves edits made after reload request and does not apply stale loaded copy', async () => {
        const onOpenCheck = jest.fn()
        const saved: ManualSession = { ...demo, manualId: 'saved-manual', title: 'Original title' }

        ;(localStore.loadManual as jest.Mock).mockImplementation(
            () =>
                new Promise<ManualSession>((resolve) => {
                    setTimeout(() => {
                        resolve({ ...saved, title: 'Saved title', revision: saved.revision })
                    }, 50)
                }),
        )

        const view = await openScreen(saved, saved.revision, onOpenCheck)

        expect(view.getByText('Original title')).toBeTruthy()

        await fireEvent.press(view.getByRole('button', { name: 'Reload saved copy' }))

        await fireEvent.changeText(view.getByLabelText('Manual title'), 'Edited title')
        await fireEvent.press(view.getByRole('button', { name: 'Rename' }))

        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(view.getByText('Edited title')).toBeTruthy()
        expect(view.queryByText('Saved title')).toBeNull()
    })

    it('shows a fact cited only to page 3 as page 3, with page 1 as the page the next save will cite', async () => {
        const [first] = demo.pages

        if (first === undefined) {
            throw new Error('demo fixture has no page')
        }

        const threePages = manualSessionSchema.parse({
            ...demo,
            manualId: 'three-page',
            pages: [
                first,
                { ...first, pageId: 'page-2', assetId: 'asset-2', contentHash: 'c'.repeat(64) },
                { ...first, pageId: 'page-3', assetId: 'asset-3', contentHash: 'd'.repeat(64) },
            ],
            reviewedSteps: demo.reviewedSteps.map((step) =>
                step.stepId === 'step-1'
                    ? {
                          ...step,
                          orientation: {
                              state: 'known',
                              value: { partId: 'side-panel', description: 'Groove faces inward.' },
                              sourceRefs: [{ pageId: 'page-3', region: null }],
                          },
                      }
                    : step,
            ),
        })
        const view = await openScreen(threePages, threePages.revision, () => undefined)

        expect(
            within(view.getByTestId('fact-orientation')).getByText(
                'Known — cited to page 3. Next save will cite page 1.',
            ),
        ).toBeTruthy()
    })

    it('reports a refused empty connection selection and keeps the saved connection in place', async () => {
        const view = await openScreen(demo, demo.revision, () => undefined)
        const connection = within(view.getByTestId('fact-connection'))

        await fireEvent.press(view.getByRole('checkbox', { name: 'Side panel' }))
        await fireEvent.press(connection.getByRole('button', { name: 'Save fact' }))

        expect(
            view.getByText('Select at least one part this connection involves, or mark the connection unknown.'),
        ).toBeTruthy()
        expect(connection.getByText('Known — cited to page 1.')).toBeTruthy()
    })
})
