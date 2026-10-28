/// <reference types="node" />

import { resolve } from 'node:path'
import type * as ReactModule from 'react'
import { AppState, DeviceEventEmitter } from 'react-native'
import { router } from 'expo-router'
import { act, cleanup, fireEvent, screen, waitFor, type RenderResult } from '@testing-library/react-native'
import { createDemoManual, type CheckResult, type ParsedManual } from '@truebuild/contracts'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'
import { jpegHeader } from '../../media/test-fixtures'
import { CaptureController } from './controller'
import { createController } from './controller-factory'
import { LibraryStorage, type KeyValueStorage, type LibraryEntry } from './library'

// The production root layout, provider, Stack, route files, screens and controller run unchanged. Only construction
// at the device/transport boundary is injected; a mocked router or controller would hide the lifetime regressions.
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
jest.mock('./controller-factory', () => ({ createController: jest.fn() }))
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
    } = {},
): Promise<{
    controller: CaptureController
    storage: LibraryStorage
    calls: string[]
    capturedLanguages: string[]
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
    return { controller, storage, calls, capturedLanguages, restore, dispose }
}

async function mount(): Promise<Awaited<ReturnType<typeof renderRouter>>> {
    const view = await renderRouter(resolve(__dirname, '../../../app'))
    await waitFor(() => expect(screen.getByTestId('library-screen')).toBeTruthy())
    await waitFor(() => expect(screen.queryByText('Getting your builds ready.')).toBeNull())
    return view
}

async function press(name: string): Promise<void> {
    await fireEvent.press(screen.getByRole('button', { name }))
}

afterEach(async () => {
    await cleanup()
    jest.restoreAllMocks()
    jest.mocked(createController).mockReset()
    jest.useRealTimers()
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
    expect(screen.getByRole('button', { name: 'Start building' })).toBeTruthy()
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
    expect(screen.getByText('Looks right. The groove faces inward.')).toBeTruthy()
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
    expect(screen.getByText('Looks right. The groove faces inward.')).toBeTruthy()
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
    await press('Take photo')
    expect(view.getPathname()).toBe('/camera')
    await act(async () => router.back())
    await waitFor(() => expect(view.getPathname()).toBe('/add'))
    expect(controller.getSnapshot().cameraIntent).toBeNull()
    expect(controller.current?.session.manualId).toBe('manual-navigation-1')
    expect(controller.current?.session.pages).toEqual(pages)
    await press('Add a page')
    await press('Take photo')
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
    await press('Next step')
    expect(controller.current?.stepIndex).toBe(1)
    expect(controller.current?.completedStepIds).toEqual(['step-1'])
    await press('Take photo')
    await act(async () => controller.shutter(async () => source))
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

it('retries a manual in its submitted English language after another manual’s picker was set to French', async () => {
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
    await press('Close sheet')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Read my manual' })).toBeTruthy())
    await press('Read my manual')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy())
    expect(view.getPathname()).toBe('/reading/english-manual')
    expect(capturedLanguages).toEqual(['en'])
    expect(calls).toHaveLength(1)

    await press('Try again')
    await waitFor(() => expect(view.getPathname()).toBe('/check/english-manual'))
    expect(capturedLanguages).toEqual(['en', 'en'])
    expect(calls).toEqual([
        'https://navigation.invalid/api/manuals/parse',
        'https://navigation.invalid/api/manuals/parse',
    ])
})
