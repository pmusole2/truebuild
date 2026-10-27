import { useSyncExternalStore, type ReactElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { createDemoManual } from '@truebuild/contracts'
import { ModelApiClient } from '../../api/model-client'
import { CaptureController } from './controller'
import { LibraryStorage, type KeyValueStorage, type LibraryEntry } from './library'
import { LibraryScreen, noticeTone, OverviewScreen, PagesScreen, SettingsScreen } from './screens'

function setup(entry?: LibraryEntry): { controller: CaptureController; storage: LibraryStorage; kv: KeyValueStorage } {
    const data = new Map<string, string>()
    const kv: KeyValueStorage = {
        getItem: async (key): Promise<string | null> => data.get(key) ?? null,
        setItem: async (key, value): Promise<void> => {
            data.set(key, value)
        },
        removeItem: async (key): Promise<void> => {
            data.delete(key)
        },
        getAllKeys: async (): Promise<string[]> => [...data.keys()],
    }
    const storage = new LibraryStorage(kv, async (): Promise<string> => '0'.repeat(64))
    const controller = new CaptureController({
        storage,
        client: new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: '' }),
        normalize: async (): Promise<never> => {
            throw new Error('No camera in this screen test')
        },
        digest: async (): Promise<string> => '0'.repeat(64),
        id: (): string => 'ui-manual',
    })
    if (entry !== undefined) {
        entry.session.pages[0]!.contentHash = '0'.repeat(64)
    }
    return { controller, storage, kv }
}
function Screens({ controller }: { controller: CaptureController }): ReactElement {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    const entry = controller.current
    return state.route === 'pages' && entry !== undefined ? (
        <PagesScreen state={state} controller={controller} entry={entry} choosePages={(): void => undefined} />
    ) : state.route === 'overview' && entry !== undefined ? (
        <OverviewScreen state={state} controller={controller} entry={entry} />
    ) : (
        <LibraryScreen state={state} controller={controller} />
    )
}
// Reanimated's native runtime is not loaded under Jest; the ui stand-in records the animation intent instead.
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

const controllers: CaptureController[] = []
afterEach(() => {
    for (const controller of controllers.splice(0)) {
        controller.dispose()
    }
})

it('shows an empty real library and creates a page editor without seeding a demo', async () => {
    const { controller } = setup()
    controllers.push(controller)
    await controller.restore()
    await render(<Screens controller={controller} />)
    expect(screen.getByText('No manuals yet.')).toBeTruthy()
    expect(screen.getByText('Scan or choose your own manual pages to start.')).toBeTruthy()
    expect(screen.queryByText('Use sample manual')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Add manual' }))
    expect(await screen.findByText('Manual pages')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Scan a page' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose pages from photos' })).toBeTruthy()
    expect(controller.current?.session.pages).toEqual([])
})

it('requires an explicit fact-review checkbox before confirmation and displays unknown critical facts', async () => {
    const session = createDemoManual()
    session.reviewStatus = 'unreviewed'
    session.rawExtraction = { parts: session.parts, steps: session.reviewedSteps, unknowns: [] }
    for (const step of session.reviewedSteps) {
        if (step.correction !== null) {
            step.correction.reviewed = false
        }
    }
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await controller.open(session.manualId)
    await render(<Screens controller={controller} />)
    const confirm = screen.getByRole('button', { name: 'Confirm reviewed facts' })
    expect(confirm.props.accessibilityState.disabled).toBe(true)
    await fireEvent.press(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Confirm reviewed facts' }).props.accessibilityState.disabled).toBe(false)
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm reviewed facts' }))
    expect(await screen.findByText('Facts confirmed by you.')).toBeTruthy()
    await act(async () => {
        await controller.editPage(0, 'remove')
    })
    expect(controller.current?.session.reviewStatus).toBe('unreviewed')
})

it.each([false, true])(
    'shows critical review requirements without blocking noncritical annotations (unresolved=%s)',
    async (unresolved) => {
        const session = createDemoManual()
        session.reviewStatus = 'unreviewed'
        for (const step of session.reviewedSteps) {
            if (step.correction !== null) {
                step.correction.reviewed = false
            }
        }
        if (unresolved) {
            session.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Arrow is not visible.' }
        }
        session.rawExtraction = {
            parts: session.parts,
            steps: session.reviewedSteps,
            unknowns: ['Packaging colour could not be read.'],
        }
        const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
        const { controller, storage } = setup(entry)
        controllers.push(controller)
        await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
        await controller.restore()
        await controller.open(session.manualId)
        await render(<Screens controller={controller} />)
        expect(screen.getByText('Extraction note: Packaging colour could not be read.')).toBeTruthy()
        if (unresolved) {
            expect(screen.getByText('Unresolved critical fact: Step 1 orientation: Arrow is not visible.')).toBeTruthy()
            expect(screen.getByText(/Add or retake clearer pages/)).toBeTruthy()
            expect(screen.getByRole('checkbox').props.accessibilityState.disabled).toBe(true)
        } else {
            await fireEvent.press(screen.getByRole('checkbox'))
            expect(
                screen.getByRole('button', { name: 'Confirm reviewed facts' }).props.accessibilityState.disabled,
            ).toBe(false)
        }
    },
)

it('retains confirmed facts during a transient restore failure and offers an explicit nondestructive retry', async () => {
    const session = createDemoManual()
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage, kv } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await controller.open(session.manualId)
    await render(<Screens controller={controller} />)
    const originalGet = kv.getItem
    kv.getItem = async (): Promise<never> => {
        throw new Error('Temporary IO failure')
    }
    await act(async () => {
        await controller.restore()
    })
    expect(controller.getSnapshot().storageReadOnly).toBe(true)
    expect(screen.getByText('Facts confirmed by you.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry local library' })).toBeTruthy()
    kv.getItem = originalGet
    await fireEvent.press(screen.getByRole('button', { name: 'Retry local library' }))
    await waitFor(() => expect(controller.getSnapshot().storageReadOnly).toBe(false))
    expect(screen.getByText('Facts confirmed by you.')).toBeTruthy()
})

it.each([
    ['Manual reading unavailable (provider_error). Check your connection.', 'error'],
    ['Local library images could not be read. Original data is retained.', 'error'],
    ['Cancelled. No late reply will be shown. Retry is a new request.', 'info'],
    ['Review every fact against the page diagrams before confirming.', 'info'],
])('notice tone reads failures as errors and progress or cancellation as information: %s', (text, tone) => {
    expect(noticeTone(text)).toBe(tone)
})

it('shows the restoring state while the local library loads, before any manual is listed', async () => {
    const { controller } = setup()
    controllers.push(controller)
    expect(controller.getSnapshot().loading).toBe(true)
    await render(<LibraryScreen state={controller.getSnapshot()} controller={controller} />)
    expect(screen.getByText('Restoring local library…')).toBeTruthy()
    expect(screen.queryByText('No manuals yet.')).toBeNull()
})

it('settings explain storage, what leaves the phone and camera access, with counts from the real library', async () => {
    const session = createDemoManual()
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await render(<SettingsScreen state={controller.getSnapshot()} onBack={(): void => undefined} />)
    expect(screen.getByText('1 manual is stored on this device.')).toBeTruthy()
    expect(screen.getByText('What leaves this phone')).toBeTruthy()
    expect(screen.getByText(/A frozen photo leaves only when you check/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open device settings' })).toBeTruthy()
})
