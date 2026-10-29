import { layoutCoachBubble, pressCoach } from './coach-test-support'
/// <reference types="node" />

import { resolve } from 'node:path'
import type * as ReactModule from 'react'
import { DeviceEventEmitter } from 'react-native'
import { act, cleanup, fireEvent, screen, waitFor, type RenderResult } from '@testing-library/react-native'
import { createDemoManual, type ParsedManual } from '@truebuild/contracts'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'
import { jpegHeader } from '../../media/test-fixtures'
import { onboardingStorage } from './coach-storage'
import { resetTipsSkipLatchForTests } from './coach-skip'
import { ONBOARDING_STORAGE_KEY } from './onboarding-store'
import { CaptureController } from '../capture/controller'
import { createController } from '../capture/controller-factory'
import { LibraryStorage, type KeyValueStorage, type LibraryEntry } from '../capture/library'

// The production root layout, provider, Stack, route files, screens and controller run unchanged. Only construction
// at the device/transport boundary is injected; a mocked router or controller would hide the lifetime regressions.
// Expo's optional animation setup replaces our working native stand-in with an empty object in this installation.
// Keep this repository's animation stand-in. This also omits the optional gesture-handler setup and expo-linking
// stand-in from that file; neither supplies native gesture/OS deep-link proof here. Router state/components stay real.
jest.mock('expo-router/build/testing-library/mocks', () => ({}))
// Inject only the device persistence port and OS geometry; the root provider, overlay, routes, actions and controller stay real.
jest.mock('./coach-storage', () => ({ onboardingStorage: { getItem: jest.fn(), setItem: jest.fn() } }))
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): { width: number; height: number; scale: number; fontScale: number } => ({
        width: 390,
        height: 844,
        scale: 3,
        fontScale: 1,
    }),
}))
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
jest.mock('../capture/controller-factory', () => ({ createController: jest.fn(), createScreens: jest.fn(() => null) }))
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
    renderRouter: (directory: string) => Promise<RenderResult & { getPathname: () => string }>
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

const previousSkip = process.env.EXPO_PUBLIC_SKIP_TIPS

beforeAll(() => {
    // Existing development restore-delay support reads this optional browser query even in the Jest native globals.
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
})

afterAll(() => {
    if (previousSkip === undefined) delete process.env.EXPO_PUBLIC_SKIP_TIPS
    else process.env.EXPO_PUBLIC_SKIP_TIPS = previousSkip
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

async function runtime(entries: LibraryEntry[] = []): Promise<{
    controller: CaptureController
    calls: string[]
    restore: jest.SpyInstance
    dispose: jest.SpyInstance
}> {
    const data = new Map<string, string>()
    const kv: KeyValueStorage = {
        getItem: async (key) => data.get(key) ?? null,
        setItem: async (key, value) => void data.set(key, value),
        removeItem: async (key) => void data.delete(key),
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
    const calls: string[] = []
    const fetch: ModelFetch = async (url) => {
        calls.push(url)
        throw new Error('Unexpected API dispatch in the coach navigation regression')
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
    return { controller, calls, restore, dispose }
}

async function mount(): Promise<Awaited<ReturnType<typeof renderRouter>>> {
    const view = await renderRouter(resolve(__dirname, '../../../app'))
    await waitFor(() => expect(screen.getByTestId('library-screen')).toBeTruthy())
    await waitFor(() => expect(screen.queryByText('Getting your builds ready.')).toBeNull())
    return view
}

async function press(name: string): Promise<void> {
    await layoutCoachBubble()
    await fireEvent.press(screen.getByRole('button', { name }))
}

beforeEach(() => {
    delete process.env.EXPO_PUBLIC_SKIP_TIPS
    resetTipsSkipLatchForTests()
    jest.mocked(onboardingStorage.getItem).mockResolvedValue(null)
    jest.mocked(onboardingStorage.setItem).mockResolvedValue(undefined)
    const methods = jest.requireActual<{ default: { measureInWindow: jest.Mock } }>(
        '@react-native/jest-preset/jest/MockNativeMethods',
    ).default
    methods.measureInWindow.mockImplementation(
        (callback: (x: number, y: number, width: number, height: number) => void) => {
            callback(16, 650, 358, 56)
        },
    )
})

async function settle(): Promise<void> {
    await act(async () => {
        await jest.advanceTimersByTimeAsync(400)
    })
}

function handlerFor(id: string): (() => void) | null {
    // RNTL 14 exposes host nodes; capture its actual enabled handler before rerender to model a burst of queued taps.
    const { findEventHandler } = jest.requireActual<{
        findEventHandler: (
            node: ReturnType<typeof screen.getByTestId>,
            event: string,
            options: { bubbles: boolean },
        ) => { handler: (() => void) | null }
    }>('@testing-library/react-native/dist/events/propagation')
    const tap = findEventHandler(screen.getByTestId(id), 'press', { bubbles: true }).handler
    expect(tap).not.toBeNull()
    return tap
}

function seen(): string[] {
    const last = jest.mocked(onboardingStorage.setItem).mock.calls.at(-1)
    if (last === undefined) return []
    expect(last[0]).toBe(ONBOARDING_STORAGE_KEY)
    return (JSON.parse(last[1]) as { seen: string[] }).seen
}

function nativeScreenOption(routePrefix: string, option: string): unknown {
    const walk = (node: unknown): unknown => {
        if (node === null || typeof node !== 'object') return undefined
        if (Array.isArray(node)) {
            for (const child of [...node].reverse()) {
                const value = walk(child)
                if (value !== undefined) return value
            }
            return undefined
        }
        const host = node as { type?: string; props?: Record<string, unknown>; children?: unknown }
        if (
            host.type === 'RNSScreen' &&
            typeof host.props?.screenId === 'string' &&
            host.props.screenId.startsWith(routePrefix)
        )
            return host.props[option]
        return walk(host.children)
    }
    return walk(screen.toJSON())
}

afterEach(async () => {
    await cleanup()
    jest.restoreAllMocks()
    jest.mocked(onboardingStorage.getItem).mockReset()
    jest.mocked(onboardingStorage.setItem).mockReset()
    jest.mocked(createController).mockReset()
    jest.useRealTimers()
})

it('runs the real Home action once, keeps seen above Stack across push/pop, and offers Pages only when focused', async () => {
    const { controller, calls, restore, dispose } = await runtime()
    const create = jest.spyOn(controller, 'createManual')
    const view = await mount()
    expect(await screen.findByText('Tap here to add your paper manual.')).toBeTruthy()
    await layoutCoachBubble()
    const tap = handlerFor('coach-target-hole')
    await act(async () => {
        tap?.()
        tap?.()
    })
    await waitFor(() => expect(view.getPathname()).toBe('/add'))
    expect(create).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Take a photo of each page.')).toBeTruthy()
    expect(seen()).toEqual(['home'])
    expect(jest.mocked(onboardingStorage.getItem)).toHaveBeenCalledTimes(1)
    await press('Skip tips')
    expect(seen()).toEqual(['home', 'pages'])
    await testRouter.back('/')
    await settle()
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
    expect(calls).toEqual([])
    expect(restore).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
})

it('resets all tips from the actual More sheet and reoffers the already mounted Home route', async () => {
    jest.mocked(onboardingStorage.getItem).mockResolvedValue(JSON.stringify({ version: 1, seen: ['home', 'guide'] }))
    const { controller, calls } = await runtime()
    const create = jest.spyOn(controller, 'createManual')
    await mount()
    await settle()
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
    await press('More')
    await fireEvent.press(await screen.findByTestId('show-tips-again'))
    expect(await screen.findByText('Tap here to add your paper manual.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Close sheet' })).toBeNull()
    expect(seen()).toEqual([])
    expect(create).not.toHaveBeenCalled()
    expect(calls).toEqual([])
})

it('pauses the real Pages tour during pending work and background without burning seen', async () => {
    const gate = deferred<(typeof source)[]>()
    const { controller, calls } = await runtime()
    const view = await mount()
    await pressCoach('coach-skip')
    await press('Add manual')
    expect(view.getPathname()).toBe('/add')
    expect(await screen.findByText('Take a photo of each page.')).toBeTruthy()
    let importing!: Promise<void>
    await act(async () => {
        importing = controller.importPages(() => gate.promise)
    })
    await settle()
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
    expect(seen()).toEqual(['home'])
    await act(async () => DeviceEventEmitter.emit('appStateDidChange', { app_state: 'background' }))
    await act(async () => {
        gate.resolve([])
        await importing
    })
    await settle()
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
    await act(async () => DeviceEventEmitter.emit('appStateDidChange', { app_state: 'active' }))
    expect(await screen.findByText('Take a photo of each page.')).toBeTruthy()
    expect(seen()).toEqual(['home'])
    expect(calls).toEqual([])
})

it('binds the native-header More target to the current route sheet and suppresses the tour until it closes', async () => {
    await runtime()
    await mount()
    await screen.findByTestId('coach-next')
    await pressCoach('coach-next')
    expect(await screen.findByText('Tap More for help and settings.')).toBeTruthy()
    await pressCoach('coach-target-hole')
    expect(await screen.findByTestId('show-tips-again')).toBeTruthy()
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
    expect(seen()).toEqual(['home'])
    await fireEvent.press(screen.getByTestId('show-tips-again'))
    expect(await screen.findByText('Tap here to add your paper manual.')).toBeTruthy()
})

it('keeps the focused Guide tour after another manual Guide is pushed and popped', async () => {
    jest.mocked(onboardingStorage.getItem).mockResolvedValue(JSON.stringify({ version: 1, seen: ['home'] }))
    const { controller, calls } = await runtime([entry('first-manual'), entry('second-manual')])
    const camera = jest.spyOn(controller, 'camera')
    const view = await mount()
    await press('Open first-manual')
    expect(await screen.findByText('This picture shows what to build.')).toBeTruthy()
    // iOS 26 defaults to full-screen pop, which otherwise steals the hero's previous-step swipe.
    expect(nativeScreenOption('guide/', 'gestureResponseDistance')).toEqual({ start: -1, end: 44, top: -1, bottom: -1 })
    expect(nativeScreenOption('index:', 'gestureResponseDistance')).toEqual({ start: -1, end: -1, top: -1, bottom: -1 })
    await pressCoach('coach-next')
    expect(await screen.findByText('Take a photo to check your work.')).toBeTruthy()
    await testRouter.push('/guide/second-manual')
    await waitFor(() => expect(controller.current?.session.manualId).toBe('second-manual'))
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
    // The native test bridge does not deliver onAppear for a second instance of the same route.
    // Deliver that OS boundary explicitly; the real Stack handler emits transitionEnd.
    await act(async () => (nativeScreenOption('guide/', 'onAppear') as () => void)())
    expect(await screen.findByText('Take a photo to check your work.')).toBeTruthy()
    await testRouter.back('/guide/first-manual')
    await waitFor(() => expect(controller.current?.session.manualId).toBe('first-manual'))
    await act(async () => (nativeScreenOption('guide/', 'onAppear') as () => void)())
    expect(await screen.findByText('Take a photo to check your work.')).toBeTruthy()
    expect(seen()).toEqual([])
    await pressCoach('coach-target-hole')
    await waitFor(() => expect(view.getPathname()).toBe('/camera'))
    expect(camera).toHaveBeenCalledTimes(1)
    expect(controller.current?.session.manualId).toBe('first-manual')
    expect(seen()).toEqual(['home', 'guide'])
    expect(calls).toEqual([])
})

it('latches the development URL skip across real navigation without writing seen', async () => {
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '?truebuildSkipTips=1' } })
    try {
        await runtime()
        const view = await mount()
        await settle()
        expect(screen.queryByTestId('coach-overlay')).toBeNull()
        await press('Add manual')
        expect(view.getPathname()).toBe('/add')
        Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
        await settle()
        expect(screen.queryByTestId('coach-overlay')).toBeNull()
        expect(onboardingStorage.setItem).not.toHaveBeenCalled()
    } finally {
        Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
    }
})

it('ignores an old route target callback after focus moves and a new tour is visible', async () => {
    const { controller, calls } = await runtime([entry()])
    const camera = jest.spyOn(controller, 'camera')
    await mount()
    expect(await screen.findByText('Tap here to pick up where you left off.')).toBeTruthy()
    await layoutCoachBubble()
    const staleHomeTap = handlerFor('coach-target-hole')
    await testRouter.push('/guide/navigation-manual')
    expect(await screen.findByText('This picture shows what to build.')).toBeTruthy()
    await act(async () => staleHomeTap?.())
    await settle()
    // An already queued event from a blurred route must not consume the focused route's different step.
    expect(screen.getByText('This picture shows what to build.')).toBeTruthy()
    expect(screen.queryByText('Take a photo to check your work.')).toBeNull()
    expect(camera).not.toHaveBeenCalled()
    expect(onboardingStorage.setItem).not.toHaveBeenCalled()
    expect(calls).toEqual([])
})
