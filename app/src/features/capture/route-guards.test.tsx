/// <reference types="node" />

import { resolve } from 'node:path'
import type * as ReactModule from 'react'
import { router } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import { act, cleanup, fireEvent, screen, waitFor, within, type RenderResult } from '@testing-library/react-native'
import { createDemoManual } from '@truebuild/contracts'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'
import { jpegHeader } from '../../media/test-fixtures'
import { MediaRejectedError } from '../../media/media-errors'
import { CaptureController } from './controller'
import { createController } from './controller-factory'
import { LibraryStorage, type KeyValueStorage, type LibraryEntry } from './library'

// Real router, route files, screens and controller, as in navigation.test.tsx; only the device/transport boundary is
// injected. These cover what a URL may show (Done, Guide) and the Quick check header, which need no network.
// Expo's optional animation setup replaces our working native stand-in with an empty object in this installation.
// Keep this repository's animation stand-in; no router, navigation state or route component is replaced.
jest.mock('expo-router/build/testing-library/mocks', () => ({}))
// The installed test-renderer reconciler predates React 19.3's Effect Event dispatcher. Supply its stable latest-commit
// callback semantics locally; navigation reducers, effects, subscriptions and the remaining React hooks stay real.
jest.mock('react', () => {
    const actual = jest.requireActual<typeof ReactModule>('react')
    return {
        ...actual,
        useEffectEvent: (callback: (...args: unknown[]) => unknown): ((...args: unknown[]) => unknown) => {
            const committed = actual.useRef(callback)
            actual.useLayoutEffect(() => {
                committed.current = callback
            })
            return actual.useCallback((...args: unknown[]) => committed.current(...args), [])
        },
    }
})
jest.mock('./controller-factory', () => ({
    createController: jest.fn(),
    createScreens: jest.fn(() => null),
    createDocuments: jest.fn(
        () =>
            new (jest.requireActual('../document-runtime/store').DocumentStore)({
                mode: 'off',
                id: (): string => 'route-test',
            }),
    ),
}))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('expo-camera', () => ({
    useCameraPermissions: (): unknown[] => [{ granted: false, canAskAgain: false }, jest.fn()],
    CameraView: 'CameraView',
}))

// Load the actual harness without its old matcher declaration, which clashes with RNTL 14's typed matchers.
const { renderRouter } = jest.requireActual<{
    renderRouter: (directory: string) => Promise<RenderResult & { getPathname: () => string }>
}>('expo-router/testing-library')

const bytes = Uint8Array.from(jpegHeader(600, 800))
const digest = async (): Promise<string> => 'a'.repeat(64)
const source = { uri: 'file:///synthetic-navigation-source.jpg', width: 600, height: 800 }
const image = { ...source, bytes, mimeType: 'image/jpeg' as const }
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')

beforeAll(() => {
    // Existing development restore-delay support reads this optional browser query even in the Jest native globals.
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
})

afterAll(() => {
    if (originalLocation === undefined) {
        Reflect.deleteProperty(window, 'location')
    } else {
        Object.defineProperty(window, 'location', originalLocation)
    }
})

function entry(manualId = 'guard-manual', stage: 'unparsed' | 'unreviewed' | 'reviewed' = 'reviewed'): LibraryEntry {
    const session = createDemoManual()
    session.manualId = manualId
    session.title = manualId
    session.pages[0]!.contentHash = 'a'.repeat(64)
    session.reviewStatus = stage === 'reviewed' ? 'reviewed' : 'unreviewed'
    if (stage === 'unparsed') {
        session.rawExtraction = null
        session.reviewedSteps = []
        session.parts = []
    } else {
        const steps = structuredClone(session.reviewedSteps)
        for (const step of steps) {
            if (step.correction !== null) step.correction.reviewed = false
        }
        session.rawExtraction = { parts: session.parts, steps, unknowns: [] }
    }
    return { session, stepIndex: 0, completedStepIds: [], capture: null }
}

async function runtime(entries: LibraryEntry[]): Promise<CaptureController> {
    const data = new Map<string, string>()
    const kv: KeyValueStorage = {
        getItem: async (key) => data.get(key) ?? null,
        setItem: async (key, value) => void data.set(key, value),
        removeItem: async (key) => void data.delete(key),
        getAllKeys: async () => [...data.keys()],
    }
    const storage = new LibraryStorage(kv, digest)
    await storage.restore()
    await storage.save(
        entries,
        entries.flatMap((item) => item.session.pages.map((page) => ({ assetId: page.assetId, bytes }))),
    )
    let sequence = 0
    const fetch: ModelFetch = async () => {
        throw new Error('No network in this test')
    }
    const controller = new CaptureController({
        storage,
        client: new ModelApiClient({ baseUrl: 'https://guard.invalid', secret: '', fetch }),
        digest,
        normalize: async (): Promise<typeof image> => image,
        id: (): string => `guard-${++sequence}`,
    })
    jest.mocked(createController).mockReturnValue(controller)
    return controller
}

async function mount(): Promise<Awaited<ReturnType<typeof renderRouter>>> {
    const view = await renderRouter(resolve(__dirname, '../../../app'))
    await waitFor(() => expect(screen.getByTestId('library-screen')).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a manual' })).toBeEnabled())
    return view
}

afterEach(async () => {
    await cleanup()
    jest.restoreAllMocks()
    jest.mocked(createController).mockReset()
})

it.each([
    ['unsupported', false, 'Use a JPEG, PNG or WebP photo.'],
    ['unreadable', true, 'This photo will not open. Save it again as JPEG, PNG or WebP.'],
] as const)(
    'shows a rejected %s import on Add and retries the photo picker once',
    async (failure, hasPages, message) => {
        const item = entry('guard-manual', 'unparsed')
        if (!hasPages) item.session.pages = []
        const controller = await runtime([item])
        const view = await mount()
        await act(async () => controller.open('guard-manual'))
        await act(async () => router.push('/add'))
        await waitFor(() => expect(view.getPathname()).toBe('/add'))
        await act(async () => {
            await controller.importPages(async () => {
                throw new MediaRejectedError(failure)
            })
        })
        expect(await screen.findByText(message)).toBeTruthy()
        expect(controller.getSnapshot().pending).toBeNull()
        jest.spyOn(ImagePicker, 'requestMediaLibraryPermissionsAsync').mockResolvedValue({
            status: ImagePicker.PermissionStatus.GRANTED,
            granted: true,
            canAskAgain: true,
            expires: 'never',
            accessPrivileges: 'all',
        })
        const picker = jest
            .spyOn(ImagePicker, 'launchImageLibraryAsync')
            .mockResolvedValue({ canceled: true, assets: null })
        await fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(picker).toHaveBeenCalledTimes(1))
        expect(picker).toHaveBeenCalledWith(expect.objectContaining({ selectionLimit: hasPages ? 11 : 12 }))
        expect(view.getPathname()).toBe('/add')
    },
)

it('retries storage recovery on Add after an import save failure instead of reopening the picker', async () => {
    const controller = await runtime([entry('guard-manual', 'unparsed')])
    const view = await mount()
    await act(async () => controller.open('guard-manual'))
    await act(async () => router.push('/add'))
    await waitFor(() => expect(view.getPathname()).toBe('/add'))
    jest.spyOn(LibraryStorage.prototype, 'save').mockRejectedValueOnce(new Error('Synthetic write failure'))
    await act(async () => controller.importPages(async () => [source]))
    expect(controller.getSnapshot().storageReadOnly).toBe(true)
    expect(
        await screen.findByText('We could not save on this device. Your earlier work is safe. Try again.'),
    ).toBeTruthy()
    const restore = jest.spyOn(controller, 'restore')
    const picker = jest.spyOn(ImagePicker, 'launchImageLibraryAsync')
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(controller.getSnapshot().storageReadOnly).toBe(false))
    expect(picker).not.toHaveBeenCalled()
})

it.each([
    ['not read yet', 'unparsed', '/add'],
    ['read but not confirmed', 'unreviewed', '/check/guard-manual'],
] as const)(
    'a Done URL for a manual that is %s goes to its own stop and never confirms it',
    async (_name, stage, to) => {
        const controller = await runtime([entry('guard-manual', stage)])
        const view = await mount()
        await act(async () => router.push('/done/guard-manual'))
        await waitFor(() => expect(view.getPathname()).toBe(to))
        expect(screen.queryByTestId('done-screen')).toBeNull()
        expect(controller.current?.session.reviewStatus).toBe('unreviewed')
        expect(controller.current?.completedStepIds).toEqual([])
    },
)

it('a Guide URL for a manual that is not confirmed shows Quick check instead of a guide with no steps', async () => {
    await runtime([entry('guard-manual', 'unreviewed')])
    const view = await mount()
    await act(async () => router.push('/guide/guard-manual'))
    await waitFor(() => expect(view.getPathname()).toBe('/check/guard-manual'))
    expect(screen.queryByTestId('guide-screen')).toBeNull()
    expect(screen.getByTestId('quick-check-start')).toBeTruthy()
})

it('a Done or Guide URL for a manual that does not exist goes Home', async () => {
    await runtime([entry()])
    const view = await mount()
    await act(async () => router.push('/done/nothing-here'))
    await waitFor(() => expect(view.getPathname()).toBe('/'))
})

it('keeps “Question 2 of 2” in the header after the first fact is accepted', async () => {
    const item = entry('guard-manual', 'unreviewed')
    item.session.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Arrow is not visible.' }
    item.session.reviewedSteps[1]!.visibleChecks = []
    const controller = await runtime([item])
    const view = await mount()
    await act(async () => router.push('/check/guard-manual'))
    await waitFor(() => expect(controller.current?.session.manualId).toBe('guard-manual'))
    // The native header carries the position as its plain title; the progress bar on screen carries it too.
    expect(await screen.findByRole('progressbar', { name: 'Question 1 of 2' })).toBeTruthy()
    expect(
        within(screen.getByRole('header', { name: 'Quick check' }).parent!).getByText('Question 1 of 2'),
    ).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Orientation'), 'Groove faces inward.')
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(controller.current?.session.revision).toBe(2))
    expect(await screen.findByRole('progressbar', { name: 'Question 2 of 2' })).toBeTruthy()
    expect(
        within(screen.getByRole('header', { name: 'Quick check' }).parent!).getByText('Question 2 of 2'),
    ).toBeTruthy()
    expect(screen.queryByText('Question 1 of 1')).toBeNull()
    expect(screen.queryByRole('progressbar', { name: 'Question 1 of 1' })).toBeNull()
    expect(view.getPathname()).toBe('/check/guard-manual')
})

it('asks once to open a manual that does not open, then offers one in-place Try again instead of a skeleton', async () => {
    const controller = await runtime([entry('first-manual'), entry('second-manual')])
    const view = await mount()
    const open = jest.spyOn(controller, 'open').mockResolvedValue(undefined)
    await act(async () => router.push('/guide/second-manual'))
    expect(await screen.findByTestId('retry-route')).toBeTruthy()
    expect(screen.getByText('We could not open this build.')).toBeTruthy()
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRestore()
    await fireEvent.press(screen.getByTestId('retry-route'))
    await waitFor(() => expect(controller.current?.session.manualId).toBe('second-manual'))
    expect(screen.getByTestId('guide-screen')).toBeTruthy()
    expect(view.getPathname()).toBe('/guide/second-manual')
})

it('uses the document wrapping header while preserving the native navigator and a single More control', async () => {
    await runtime([entry('guard-manual')])
    const view = await mount()
    expect(screen.getByRole('header', { name: 'Your manuals' }).props.maxFontSizeMultiplier).toBe(0)
    await act(async () => router.push('/guide/guard-manual'))
    await waitFor(() => expect(view.getPathname()).toBe('/guide/guard-manual'))
    await screen.findByTestId('guide-screen')
    expect(screen.getByText('Step 1 of 2').props.maxFontSizeMultiplier).toBe(0)
    expect(
        screen.getByRole('header', { name: entry('guard-manual').session.reviewedSteps[0]!.title }).props
            .maxFontSizeMultiplier,
    ).toBe(0)
    // One trailing control only: More. Back is the platform's own chevron.
    expect(screen.getAllByRole('button', { name: 'More' })).toHaveLength(1)
})
