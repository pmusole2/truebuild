import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture, type WorkflowPreviewCase } from '../../ui/preview/workflow-fixtures'
import { LibraryScreen } from './library-screen'
import type { WorkflowState } from './controller'
import type { WorkflowController } from './workflow-types'

const mockWindow = { width: 390, height: 844, fontScale: 1 }
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): typeof mockWindow & { scale: number } => ({ ...mockWindow, scale: 2 }),
}))
beforeEach(() => {
    Object.assign(mockWindow, { width: 390, height: 844, fontScale: 1 })
})

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

async function setup(
    id: WorkflowPreviewCase,
    patch: Partial<WorkflowState> = {},
    onOpenSettings?: () => void,
): Promise<{ createManual: jest.Mock; open: jest.Mock; restore: jest.Mock }> {
    const { state } = workflowPreviewFixture(id)
    const createManual = jest.fn(async (): Promise<void> => undefined)
    const open = jest.fn(async (): Promise<void> => undefined)
    const restore = jest.fn(async (): Promise<void> => undefined)
    const controller: WorkflowController = { ...INERT_WORKFLOW_CONTROLLER, createManual, open, restore }
    await render(
        <LibraryScreen state={{ ...state, ...patch }} controller={controller} onOpenSettings={onOpenSettings} />,
    )
    return { createManual, open, restore }
}

describe('first run', () => {
    it('sets out the three stages without seeding a demo or promising results', async () => {
        await setup('home-empty')
        expect(screen.getByText('No manuals yet.')).toBeTruthy()
        expect(screen.getByLabelText('Step 1, Not started: Photograph your manual pages')).toBeTruthy()
        expect(screen.getByLabelText('Step 2, Not started: Confirm the facts read from them')).toBeTruthy()
        expect(screen.getByLabelText('Step 3, Not started: Follow guided assembly and check steps')).toBeTruthy()
        expect(screen.getByText("Follow one step at a time, with your manual's own pages beside you.")).toBeTruthy()
        expect(screen.queryByText('Use sample manual')).toBeNull()
    })

    it('does not show the outline over a retained but unreadable library, loading, or saved manuals', async () => {
        for (const [id, patch] of [
            ['home-error', {}],
            ['home-loading', {}],
            ['home-populated', {}],
        ] as const) {
            await setup(id, patch)
            expect(screen.queryByText('How it works')).toBeNull()
            await screen.unmount()
        }
    })

    it('adds a manual from one primary action, only when pressed', async () => {
        const { createManual } = await setup('home-empty')
        expect(createManual).not.toHaveBeenCalled()
        await fireEvent.press(screen.getByRole('button', { name: 'Add manual' }))
        expect(createManual).toHaveBeenCalledTimes(1)
    })
})

describe('Add manual placement', () => {
    it('anchors the action in a dock outside the scroll at a normal height', async () => {
        await setup('home-empty')
        expect(screen.getByRole('button', { name: 'Add manual' })).toBeTruthy()
        expect(within(screen.getByTestId('library-scroll')).queryByRole('button', { name: 'Add manual' })).toBeNull()
    })

    it.each([
        ['a short phone', { width: 320, height: 568, fontScale: 1 }],
        ['large system text', { width: 390, height: 844, fontScale: 2 }],
    ])('keeps the title, content and action in one reachable scroll with %s', async (_label, dimensions) => {
        Object.assign(mockWindow, dimensions)
        await setup('home-empty', {}, (): void => undefined)
        const scroll = within(screen.getByTestId('library-scroll'))
        expect(scroll.getByText('Your manuals')).toBeTruthy()
        expect(scroll.getByText('No manuals yet.')).toBeTruthy()
        expect(scroll.getByRole('button', { name: 'Settings' })).toBeTruthy()
        expect(scroll.getByRole('button', { name: 'Add manual' })).toBeTruthy()
    })
})

describe('unavailable states', () => {
    it.each([
        ['home-loading', {}, 'Available once your library has loaded.'],
        ['home-error', {}, 'Adding is paused until the saved library is restored.'],
        ['home-empty', { pending: 'Reading your pages…' }, 'Available when the current request finishes.'],
    ] as const)('%s disables Add manual, says why and never calls a controller', async (id, patch, hint) => {
        const { createManual, open, restore } = await setup(id, patch)
        expect(screen.getByRole('button', { name: 'Add manual' }).props.accessibilityState.disabled).toBe(true)
        expect(screen.getByText(hint)).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Add manual' }))
        expect(createManual).not.toHaveBeenCalled()
        expect(open).not.toHaveBeenCalled()
        expect(restore).not.toHaveBeenCalled()
    })

    it('labels the restoring state and reassures that saved data is untouched', async () => {
        await setup('home-loading')
        expect(screen.getByLabelText('Restoring local library…')).toBeTruthy()
        expect(screen.getByText(/not changed while this loads/)).toBeTruthy()
        expect(screen.queryByText('No manuals yet.')).toBeNull()
    })

    it('explains an unreadable library plainly and leaves retry to the explicit control', async () => {
        const { restore } = await setup('home-error')
        expect(screen.getByText('Saved library unavailable')).toBeTruthy()
        expect(screen.getByText(/Original local data is retained/)).toBeTruthy()
        expect(restore).not.toHaveBeenCalled()
    })
})

describe('saved manuals', () => {
    it('opens a manual and reports progress as marked complete by the user, not as verified', async () => {
        const fixture = workflowPreviewFixture('home-populated')
        const total = fixture.entry.session.reviewedSteps.length
        const entry = {
            ...fixture.entry,
            completedStepIds: fixture.entry.session.reviewedSteps.slice(0, 1).map((s) => s.stepId),
        }
        const { open } = await setup('home-populated', { entries: [entry] })
        const title = fixture.entry.session.title
        expect(screen.getByText(new RegExp(`${total} steps · 1 marked complete by you`))).toBeTruthy()
        expect(screen.getByRole('progressbar', { name: `Steps you marked complete: 1 of ${total}` })).toBeTruthy()
        expect(screen.queryByText(/verified/i)).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: `Open ${title}` }))
        expect(open).toHaveBeenCalledWith(entry.session.manualId)
    })

    it('invokes the optional settings callback and omits the control without it', async () => {
        const onOpenSettings = jest.fn()
        await setup('home-populated', {}, onOpenSettings)
        await fireEvent.press(screen.getByRole('button', { name: 'Settings' }))
        expect(onOpenSettings).toHaveBeenCalledTimes(1)
        await screen.unmount()
        await setup('home-populated')
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    })
})
