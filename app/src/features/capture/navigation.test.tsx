/// <reference types="node" />

import { resolve } from 'node:path'
import type * as ReactModule from 'react'
import { AppState, DeviceEventEmitter, Linking } from 'react-native'
import { router } from 'expo-router'
import { act, cleanup, fireEvent, screen, waitFor, type RenderResult } from '@testing-library/react-native'
import { createDemoManual, screenDocumentV2Schema, type CheckResult, type ParsedManual } from '@truebuild/contracts'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'
import { jpegHeader } from '../../media/test-fixtures'
import { CaptureController } from './controller'
import { createController } from './controller-factory'
import RootLayout from '../../../app/_layout'
import IndexRoute from '../../../app/index'
import { DocumentRouteBoundary } from '../documents/ownership'
import { DocumentRenderer } from '../documents/document-renderer'
import { hostsOutsideDocuments, type OwnershipTree } from '../documents/ownership-audit'
import { View } from 'react-native'
import { BottomSheet } from '../../ui/sheet'
import { DocumentSurface } from './document-surface'
import { LibraryStorage, type KeyValueStorage, type LibraryEntry } from './library'

// The production root layout, provider, Stack, route files, screens and controller run unchanged. Only construction
// at the device/transport boundary is injected; a mocked router or controller would hide the lifetime regressions.
// Expo's optional animation setup replaces our working native stand-in with an empty object in this installation.
// Keep this repository's animation stand-in. This also omits the optional gesture-handler setup and expo-linking
// stand-in from that file; neither supplies native gesture/OS deep-link proof here. Router state/components stay real.
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
jest.unmock('react-native/Libraries/AppState/AppState')
// Use real AppState subscriptions/currentState updates over the native OS bridge, rather than Jest's inert AppState.
jest.mock('react-native/Libraries/AppState/NativeAppState', () => ({
    __esModule: true,
    default: {
        getConstants: (): { initialAppState: string } => ({ initialAppState: 'active' }),
        getCurrentAppState: (success: (value: { app_state: string }) => void): void => success({ app_state: 'active' }),
        addListener: jest.fn(),
        removeListeners: jest.fn(),
    },
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
const { renderRouter, testRouter } = jest.requireActual<{
    renderRouter: (
        directory: string | { appDir: string; overrides: Record<string, unknown> },
    ) => Promise<RenderResult & { getPathname: () => string }>
    testRouter: {
        push: (path: string) => Promise<void>
        back: (path?: string) => Promise<void>
        canGoBack: () => boolean
    }
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

type Metadata = {
    requestId: string
    binding: Record<string, unknown>
    pages?: { pageId: string }[]
    sourcePageIds?: string[]
    language?: string
}

function parsed(pageId: string): ParsedManual {
    const manual = createDemoManual()
    const value = JSON.parse(
        JSON.stringify({ parts: manual.parts, steps: manual.reviewedSteps, unknowns: [] }).replaceAll(
            'demo-page-1',
            pageId,
        ),
    ) as ParsedManual
    for (const step of value.steps) {
        if (step.correction !== null) step.correction.reviewed = false
    }
    return value
}

function entry(manualId = 'navigation-manual', stage: 'reviewed' | 'unparsed' = 'reviewed'): LibraryEntry {
    const session = createDemoManual()
    session.manualId = manualId
    session.title = manualId
    session.pages[0]!.contentHash = 'a'.repeat(64)
    session.reviewStatus = stage === 'reviewed' ? 'reviewed' : 'unreviewed'
    session.rawExtraction = stage === 'unparsed' ? null : parsed(session.pages[0]!.pageId)
    if (stage === 'unparsed') {
        session.reviewedSteps = []
        session.parts = []
    }
    return { session, stepIndex: 0, completedStepIds: [], capture: null }
}

async function runtime(
    entries: LibraryEntry[] = [],
    gates: {
        parse?: ReturnType<typeof deferred<void>>
        check?: ReturnType<typeof deferred<void>>
        parseFailureOnce?: boolean
        storageUnavailable?: boolean
    } = {},
): Promise<{
    controller: CaptureController
    storage: LibraryStorage
    calls: string[]
    capturedLanguages: string[]
    restore: jest.SpyInstance
    dispose: jest.SpyInstance
    writes: string[]
}> {
    const data = new Map<string, string>()
    const writes: string[] = []
    let controllerRestore = false
    const kv: KeyValueStorage = {
        getItem: async (key) => {
            if (controllerRestore && gates.storageUnavailable === true) throw new Error('Synthetic storage unavailable')
            return data.get(key) ?? null
        },
        setItem: async (key, value) => {
            writes.push(key)
            data.set(key, value)
        },
        removeItem: async (key) => {
            writes.push(key)
            data.delete(key)
        },
        getAllKeys: async () => [...data.keys()],
    }
    const storage = new LibraryStorage(kv, digest)
    await storage.restore()
    if (entries.length > 0) {
        await storage.save(
            entries,
            entries.flatMap((item) => item.session.pages.map((page) => ({ assetId: page.assetId, bytes }))),
        )
    }
    controllerRestore = true
    const calls: string[] = []
    const capturedLanguages: string[] = []
    const fetch: ModelFetch = async (url, init) => {
        calls.push(url)
        const meta = JSON.parse(String((init.body as FormData).get('metadata'))) as Metadata
        if (url.endsWith('/parse')) {
            if (typeof meta.language !== 'string') {
                throw new Error('Missing parse language at the fixture transport boundary')
            }
            capturedLanguages.push(meta.language)
            if (gates.parseFailureOnce && capturedLanguages.length === 1) {
                throw new Error('Synthetic one-time parse transport failure')
            }
            await gates.parse?.promise
        } else if (url.endsWith('/checks')) {
            await gates.check?.promise
        }
        const value = url.endsWith('/parse')
            ? parsed(meta.pages![0]!.pageId)
            : url.endsWith('/questions')
              ? {
                    answer: 'The groove faces inward.',
                    sourceRefs: [{ pageId: meta.sourcePageIds![0]!, region: null }],
                    missingEvidence: [],
                }
              : ({
                    decision: 'pass',
                    reason: 'The groove faces inward.',
                    sourceRefs: [{ pageId: meta.sourcePageIds![0]!, region: null }],
                    observedRegion: null,
                    missingEvidence: [],
                } satisfies CheckResult)
        return new Response(
            JSON.stringify({ status: 'ok', mode: 'model', requestId: meta.requestId, binding: meta.binding, value }),
            { headers: { 'content-type': 'application/json' } },
        )
    }
    let sequence = 0
    const controller = new CaptureController({
        storage,
        client: new ModelApiClient({ baseUrl: 'https://navigation.invalid', secret: '', fetch }),
        digest,
        normalize: async (): Promise<typeof image> => image,
        id: (): string => `navigation-${++sequence}`,
    })
    const restore = jest.spyOn(controller, 'restore')
    const dispose = jest.spyOn(controller, 'dispose')
    jest.mocked(createController).mockReturnValue(controller)
    return { controller, storage, calls, capturedLanguages, restore, dispose, writes }
}

async function mount(): Promise<Awaited<ReturnType<typeof renderRouter>>> {
    const view = await renderRouter(resolve(__dirname, '../../../app'))
    await waitFor(() => expect(screen.getByTestId('library-screen')).toBeTruthy())
    await waitFor(() => expect(screen.queryByText('Getting your builds ready.')).toBeNull())
    return view
}

async function press(name: string): Promise<void> {
    const stable: Record<string, string> = {
        'Add manual': 'home-add',
        'Keep building': 'keep-building',
        'Read my manual': 'read-manual',
        'Start building': 'quick-check-start',
        'Take photo': 'guide-primary',
        'Next step': 'guide-primary',
        Finish: 'guide-primary',
        'All builds': 'done-home',
        'Back to Home': 'done-home',
        'Answer a few questions': 'keep-building',
        'Add a page': 'add-page',
        'Close sheet': 'close-sheet',
        'Go back': 'camera-close',
    }
    await fireEvent.press(
        stable[name] === undefined ? screen.getByRole('button', { name }) : screen.getByTestId(stable[name]!),
    )
}

afterEach(async () => {
    await cleanup()
    jest.restoreAllMocks()
    jest.mocked(createController).mockReset()
    jest.useRealTimers()
})

it('offers one authored Home restore action after a real storage read failure, with no writes or model dispatch', async () => {
    const gates = { storageUnavailable: true }
    const { controller, restore, writes, calls } = await runtime([], gates)
    await mount()
    expect(await screen.findByText('Saving is paused until your saved builds open again.')).toBeTruthy()
    expect(controller.getSnapshot().storageReadOnly).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1)
    expect(screen.getByTestId('retry-library')).toBeTruthy()
    expect(writes).toEqual([])
    await fireEvent.press(screen.getByTestId('retry-library'))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
    expect(controller.getSnapshot().storageReadOnly).toBe(true)
    expect(writes).toEqual([])
    gates.storageUnavailable = false
    await fireEvent.press(screen.getByTestId('retry-library'))
    await waitFor(() => expect(controller.getSnapshot().storageReadOnly).toBe(false))
    expect(screen.getByTestId('home-add')).toBeTruthy()
    expect(writes).toEqual([])
    expect(calls).toEqual([])
})

it('keeps the authored Home More device-settings action on its native OS port', async () => {
    const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue()
    const { calls } = await runtime()
    await mount()
    await press('More')
    await fireEvent.press(await screen.findByRole('button', { name: 'Open device settings' }))
    expect(settings).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
})

it('replaces Reading with Quick check, keeps Add in Back history, and explicitly confirms before Guide', async () => {
    const parse = deferred<void>()
    const { controller, calls, restore, dispose } = await runtime([], { parse })
    const view = await mount()
    await press('Add manual')
    expect(view.getPathname()).toBe('/add')
    await act(async () => controller.importPages(async () => [source]))
    await press('Read my manual')
    expect(view.getPathname()).toBe('/reading/manual-navigation-1')
    expect(screen.getByTestId('reading-screen')).toBeTruthy()
    await act(async () => parse.resolve())
    await waitFor(() => expect(view.getPathname()).toBe('/check/manual-navigation-1'))
    expect(controller.current?.session.reviewStatus).toBe('unreviewed')
    expect(screen.getByTestId('quick-check-start')).toBeTruthy()
    await testRouter.back('/add')
    expect(controller.current?.session.pages).toHaveLength(1)
    await testRouter.back('/')
    await press('Answer a few questions')
    expect(view.getPathname()).toBe('/check/manual-navigation-1')
    await press('Start building')
    await waitFor(() => expect(view.getPathname()).toBe('/guide/manual-navigation-1'))
    expect(controller.current?.session.reviewStatus).toBe('reviewed')
    await testRouter.back('/')
    expect(calls).toEqual(['https://navigation.invalid/api/manuals/parse'])
    expect(restore).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
})

it('keeps the same photo, result and question draft across native Back, Home resume and push/pop', async () => {
    const { controller, calls, restore, dispose } = await runtime([entry()])
    const view = await mount()
    await press('Keep building')
    expect(view.getPathname()).toBe('/guide/navigation-manual')
    await press('Take photo')
    expect(view.getPathname()).toBe('/camera')
    await act(async () => controller.shutter(async () => source))
    await waitFor(() => expect(view.getPathname()).toBe('/guide/navigation-manual'))
    expect(controller.getSnapshot().check?.decision).toBe('pass')
    await act(async () => {
        controller.questionChanged('Should this groove face inward?')
        controller.targetChanged({ kind: 'part', partId: 'side-panel' })
    })
    const before = controller.getSnapshot()
    const manual = controller.current
    await testRouter.back('/')
    expect(controller.getSnapshot().capture).toBe(before.capture)
    expect(controller.getSnapshot().check).toBe(before.check)
    await press('Keep building')
    expect(view.getPathname()).toBe('/guide/navigation-manual')
    await testRouter.push('/check/navigation-manual')
    await testRouter.back('/guide/navigation-manual')
    expect(controller.current).toBe(manual)
    expect(controller.getSnapshot()).toMatchObject({
        capture: before.capture,
        check: before.check,
        question: 'Should this groove face inward?',
        target: { kind: 'part', partId: 'side-panel' },
    })
    await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
        nativeEvent: { layout: { width: 300, height: 200 } },
    })
    await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
    expect(screen.getByText('The groove faces inward.')).toBeTruthy()
    expect(calls).toHaveLength(1)
    await act(async () => controller.ask())
    const answer = controller.getSnapshot().answer
    expect(answer?.answer).toBe('The groove faces inward.')
    await testRouter.back('/')
    await press('Keep building')
    expect(controller.getSnapshot().answer).toBe(answer)
    expect(controller.getSnapshot().capture).toBe(before.capture)
    expect(controller.getSnapshot().question).toBe('Should this groove face inward?')
    expect(calls).toHaveLength(2)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
    await view.unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
})

it('keeps one pending check alive across background, foreground and route changes until its reply arrives', async () => {
    const check = deferred<void>()
    const { controller, calls, restore, dispose } = await runtime([entry()], { check })
    const view = await mount()
    await press('Keep building')
    await press('Take photo')
    let capture!: Promise<void>
    await act(async () => {
        capture = controller.shutter(async () => source)
    })
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(view.getPathname()).toBe('/guide/navigation-manual')
    const before = controller.getSnapshot()
    expect(AppState.currentState).toBe('active')
    await act(async () => DeviceEventEmitter.emit('appStateDidChange', { app_state: 'background' }))
    expect(AppState.currentState).toBe('background')
    await testRouter.push('/')
    await act(async () => DeviceEventEmitter.emit('appStateDidChange', { app_state: 'active' }))
    expect(AppState.currentState).toBe('active')
    await testRouter.back('/guide/navigation-manual')
    expect(controller.getSnapshot().capture).toBe(before.capture)
    expect(controller.getSnapshot().pending).toBe(before.pending)
    expect(calls).toHaveLength(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
    await act(async () => {
        check.resolve()
        await capture
    })
    expect(controller.getSnapshot().pending).toBeNull()
    expect(controller.getSnapshot().check?.decision).toBe('pass')
    await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
        nativeEvent: { layout: { width: 300, height: 200 } },
    })
    await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
    expect(screen.getByText('The groove faces inward.')).toBeTruthy()
    expect(calls).toHaveLength(1)
})

it('asks before native Back cancels Reading, preserves pages, and ignores the stopped read’s late reply', async () => {
    const parse = deferred<void>()
    const { controller, calls, storage, dispose } = await runtime([], { parse })
    const view = await mount()
    await press('Add manual')
    await act(async () => controller.importPages(async () => [source]))
    const pages = controller.current!.session.pages
    await press('Read my manual')
    await waitFor(() => expect(calls).toHaveLength(1))
    await act(async () => router.back())
    expect(view.getPathname()).toBe('/reading/manual-navigation-1')
    expect(screen.getByRole('button', { name: 'Stop reading' })).toBeTruthy()
    await press('Keep reading')
    expect(controller.getSnapshot().pending).not.toBeNull()
    expect(calls).toHaveLength(1)
    await act(async () => router.back())
    await press('Stop reading')
    await waitFor(() => expect(view.getPathname()).toBe('/add'))
    await act(async () => parse.resolve())
    expect(screen.getAllByText('Stopped, so nothing more will be shown.')).toHaveLength(1)
    expect(controller.current?.session.pages).toEqual(pages)
    expect(controller.current?.session.rawExtraction).toBeNull()
    expect(controller.current?.session.reviewStatus).toBe('unreviewed')
    expect((await storage.restore()).entries[0]?.session.pages).toEqual(pages)
    expect(calls).toHaveLength(1)
    expect(dispose).not.toHaveBeenCalled()
    await testRouter.back('/')
})

it('returns from Camera through native Back and its close control without losing the selected manual’s pages', async () => {
    const { controller, calls, dispose } = await runtime()
    const view = await mount()
    await press('Add manual')
    await act(async () => controller.importPages(async () => [source]))
    const pages = controller.current!.session.pages
    await press('Add a page')
    expect(view.getPathname()).toBe('/camera')
    await act(async () => router.back())
    await waitFor(() => expect(view.getPathname()).toBe('/add'))
    expect(controller.getSnapshot().cameraIntent).toBeNull()
    expect(controller.current?.session.manualId).toBe('manual-navigation-1')
    expect(controller.current?.session.pages).toEqual(pages)
    await press('Add a page')
    expect(view.getPathname()).toBe('/camera')
    // The denied-permission hardware boundary still renders the production CameraStage Back control.
    await press('Go back')
    await waitFor(() => expect(view.getPathname()).toBe('/add'))
    expect(controller.getSnapshot().cameraIntent).toBeNull()
    expect(controller.current?.session.manualId).toBe('manual-navigation-1')
    expect(controller.current?.session.pages).toEqual(pages)
    expect(calls).toEqual([])
    expect(dispose).not.toHaveBeenCalled()
    await testRouter.back('/')
})

it('restores the manual belonging to a retained Guide after another manual’s deep link is popped', async () => {
    const { controller, calls } = await runtime([entry('first-manual'), entry('second-manual')])
    const view = await mount()
    await press('Open first-manual')
    expect(view.getPathname()).toBe('/guide/first-manual')
    await act(async () => controller.step(1))
    await testRouter.push('/guide/second-manual')
    await waitFor(() => expect(controller.current?.session.manualId).toBe('second-manual'))
    await testRouter.back('/guide/first-manual')
    await waitFor(() => expect(controller.current?.session.manualId).toBe('first-manual'))
    expect(controller.current?.stepIndex).toBe(1)
    expect(screen.getByTestId('guide-screen')).toBeTruthy()
    expect(calls).toEqual([])
})

it('marks each passed step before moving forward and reaches Done through the actual Finish action', async () => {
    const { controller, calls, storage } = await runtime([entry()])
    const view = await mount()
    await press('Keep building')
    await press('Take photo')
    await act(async () => controller.shutter(async () => source))
    await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
        nativeEvent: { layout: { width: 300, height: 200 } },
    })
    await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
    await press('Next step')
    expect(controller.current?.stepIndex).toBe(1)
    expect(controller.current?.completedStepIds).toEqual(['step-1'])
    await press('Take photo')
    await act(async () => controller.shutter(async () => source))
    await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
        nativeEvent: { layout: { width: 300, height: 200 } },
    })
    await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
    await press('Finish')
    await waitFor(() => expect(view.getPathname()).toBe('/done/navigation-manual'))
    expect(screen.getByTestId('done-screen')).toBeTruthy()
    expect(controller.current?.completedStepIds).toEqual(['step-1', 'step-2'])
    expect((await storage.restore()).entries[0]?.completedStepIds).toEqual(['step-1', 'step-2'])
    await press('Back to Home')
    expect(view.getPathname()).toBe('/')
    expect(testRouter.canGoBack()).toBe(false)
    expect(calls).toHaveLength(2)
})

it('does not claim completion when an unfinished manual’s Done URL is opened directly', async () => {
    const { controller } = await runtime([entry()])
    const view = await mount()
    await press('Keep building')
    await act(async () => router.push('/done/navigation-manual'))
    await waitFor(() => expect(view.getPathname()).toBe('/guide/navigation-manual'))
    expect(screen.queryByTestId('done-screen')).toBeNull()
    expect(controller.current?.completedStepIds).toEqual([])
})

it.each([
    ['English', 'en'],
    ['French', 'fr'],
])('retries a manual in its submitted %s language after another manual’s picker draft', async (name, language) => {
    const { controller, calls, capturedLanguages } = await runtime(
        [entry('french-manual', 'unparsed'), entry('english-manual', 'unparsed')],
        { parseFailureOnce: true },
    )
    const view = await mount()
    await press('Open french-manual')
    expect(view.getPathname()).toBe('/add')
    await press('More')
    await fireEvent.press(screen.getByRole('radio', { name: 'French' }))
    expect(screen.getByRole('radio', { name: 'French' }).props.accessibilityState.checked).toBe(true)
    await press('Close sheet')
    await waitFor(() => expect(screen.queryByRole('radio', { name: 'French' })).toBeNull())
    await testRouter.back('/')

    await press('Open english-manual')
    expect(controller.current?.session.manualId).toBe('english-manual')
    await press('More')
    expect(screen.getByRole('radio', { name: 'English' }).props.accessibilityState.checked).toBe(true)
    if (language !== 'en') {
        await fireEvent.press(screen.getByRole('radio', { name }))
    }
    await press('Close sheet')
    await waitFor(() => expect(screen.getByTestId('read-manual')).toBeTruthy())
    await press('Read my manual')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy())
    expect(view.getPathname()).toBe('/reading/english-manual')
    expect(capturedLanguages).toEqual([language])
    expect(calls).toHaveLength(1)

    await press('Try again')
    await waitFor(() => expect(view.getPathname()).toBe('/check/english-manual'))
    expect(capturedLanguages).toEqual([language, language])
    expect(calls).toEqual([
        'https://navigation.invalid/api/manuals/parse',
        'https://navigation.invalid/api/manuals/parse',
    ])
})

type TestFiber = { type: unknown; memoizedProps?: Record<string, unknown>; return: TestFiber | null }
function actualDocumentIds(): Set<string> {
    const ids = new Set<string>()
    for (const host of screen.container.queryAll(() => true)) {
        let fiber = host.unstable_fiber as unknown as TestFiber | null
        while (fiber !== null) {
            if (fiber.type === DocumentRenderer) {
                const parsed = screenDocumentV2Schema.parse(fiber.memoizedProps?.document)
                ids.add(parsed.screenId)
            }
            fiber = fiber.return
        }
    }
    expect(ids.size).toBeGreaterThan(0)
    return ids
}
function actualRoot(): OwnershipTree {
    const root = screen.getByTestId('document-navigation-root')
    let fiber = root.unstable_fiber as unknown as TestFiber | null
    let found = false
    while (fiber !== null) {
        if (fiber.type === RootLayout) found = true
        fiber = fiber.return
    }
    expect(found).toBe(true)
    return root as unknown as OwnershipTree
}

it('owns the real production RootLayout navigator and routes through validated v2 documents', async () => {
    await runtime([entry()])
    await mount()
    const checkOwnership = (): void => expect(hostsOutsideDocuments(actualRoot(), actualDocumentIds())).toEqual([])
    await waitFor(checkOwnership)
    await press('Keep building')
    await waitFor(checkOwnership)
    await testRouter.push('/check/navigation-manual')
    await waitFor(checkOwnership)
    await testRouter.back('/guide/navigation-manual')
    await press('Take photo')
    await waitFor(checkOwnership)
})

it('rejects a stray native route sibling even inside the real document-owned navigator', async () => {
    await runtime()
    await renderRouter({
        appDir: resolve(__dirname, '../../../app'),
        overrides: {
            index: {
                default: (): ReactModule.ReactElement => (
                    <DocumentRouteBoundary>
                        <IndexRoute />
                        <View testID="unowned-route-leftover" />
                    </DocumentRouteBoundary>
                ),
            },
        },
    })
    await waitFor(() => expect(screen.getByTestId('library-screen')).toBeTruthy())
    await waitFor(() =>
        expect(hostsOutsideDocuments(actualRoot(), actualDocumentIds())).toContain('View#unowned-route-leftover'),
    )
})

it.each([false, true])(
    'audits actual document-frame Modal content with an injected stray sibling=%s',
    async (stray) => {
        await runtime()
        await renderRouter({
            appDir: resolve(__dirname, '../../../app'),
            overrides: {
                index: {
                    default: (): ReactModule.ReactElement => (
                        <DocumentRouteBoundary>
                            <BottomSheet visible title="" documentFrame onClose={(): void => undefined}>
                                <DocumentSurface kind="more" />
                                {stray ? <View testID="unowned-modal-leftover" /> : null}
                            </BottomSheet>
                        </DocumentRouteBoundary>
                    ),
                },
            },
        })
        await screen.findByTestId('bottom-sheet')
        await waitFor(() => {
            const failures = hostsOutsideDocuments(actualRoot(), actualDocumentIds())
            if (stray) expect(failures).toContain('View#unowned-modal-leftover')
            else expect(failures).toEqual([])
        })
    },
)

it('the actual More and nested judge entry publish document owners while their Modal is open', async () => {
    await runtime([entry()])
    await mount()
    await press('Keep building')
    await press('More')
    await screen.findByTestId('more-sheet')
    const check = (count: number): void => {
        const ids = actualDocumentIds()
        const modals = screen.container
            .queryAll(() => true)
            .filter((host) => (host as unknown as OwnershipTree).type === 'Modal')
        expect(modals).toHaveLength(count)
        for (const modal of modals) {
            const id = (modal as unknown as OwnershipTree).props.nativeID
            expect(typeof id).toBe('string')
            expect(ids.has(String(id).replace('truebuild-document-root:', ''))).toBe(true)
        }
        expect(hostsOutsideDocuments(actualRoot(), ids)).toEqual([])
    }
    await waitFor(() => check(1))
    await fireEvent.press(screen.getByTestId('judge-entry'))
    await screen.findByRole('switch', { name: 'Show how Meta AI built this' })
    await waitFor(() => check(2))
    await fireEvent.press(screen.getByTestId('close-sheet'))
    await waitFor(() => check(1))
    await fireEvent.press(screen.getByTestId('close-sheet'))
    await waitFor(() => check(0))
})

it('dismisses both real sheets for Compare even when navigation keeps their parent mounted', async () => {
    await runtime([entry()])
    await mount()
    await press('Keep building')
    await press('More')
    await fireEvent.press(screen.getByTestId('judge-entry'))
    await fireEvent.press(await screen.findByRole('switch', { name: 'Show how Meta AI built this' }))
    const modalCount = (): number =>
        screen.container.queryAll(() => true).filter((host) => (host as unknown as OwnershipTree).type === 'Modal')
            .length
    await waitFor(() => expect(modalCount()).toBe(2))
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined)
    try {
        await fireEvent.press(await screen.findByTestId('judge-compare'))
        expect(push).toHaveBeenCalledWith('/compare')
        await waitFor(() => expect(modalCount()).toBe(0))
    } finally {
        push.mockRestore()
    }
})

it('the main document ends a failed manual picture read instead of keeping a loading figure', async () => {
    const { controller, storage, calls } = await runtime([entry()])
    await mount()
    await press('Keep building')
    const read = jest.spyOn(storage, 'readAsset').mockRejectedValue(new Error('Synthetic local read failure'))
    try {
        await act(async () => controller.open('navigation-manual', 'guide'))
        await waitFor(() => expect(controller.getSnapshot().storageReadOnly).toBe(true))
        expect(await screen.findByText('This manual picture is unavailable.')).toBeTruthy()
        await fireEvent.press((await screen.findAllByRole('button', { name: 'See it in the manual' }))[0]!)
        expect(screen.getAllByText('This manual picture is unavailable.')).toHaveLength(2)
        expect(screen.queryByText('Loading page…')).toBeNull()
        expect(calls).toHaveLength(0)
    } finally {
        read.mockRestore()
    }
})
