/// <reference types="node" />
import type * as ReactModule from 'react'
import type * as ReactNative from 'react-native'
import { resolve } from 'node:path'
import { router } from 'expo-router'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { createController, createDocuments, createScreens } from './controller-factory'
import { flush, loadPhoto, mount, press, type Mounted } from '../screens/test-support/flow'
import { deferred, entry, runtime, source } from '../screens/test-support/route-harness'
import { parseNativeMeterMarkers } from '../../ui/native-meter-markers'
import { fixtureDocuments } from '../screens/test-support/fixture-server'
import { renderedDocuments } from '../screens/test-support/rendered-documents'
import { judgeStorage } from '../screens/judge-storage'
import { JUDGE_STORAGE_KEY } from '../screens/judge-store'
import { DOCUMENT_COLLECTION_DEADLINE_MS, DocumentStore } from '../document-runtime/store'
import { documentInputs } from './document-inputs'
const mockGetCameraPermissions = jest.fn(async () => ({ granted: true, canAskAgain: true }))
const mockRequestCameraPermission = jest.fn()

jest.mock('expo-router/build/testing-library/mocks', () => ({}))
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
    createScreens: jest.fn(),
    createDocuments: jest.fn(),
}))
// Device key-value IO only: the real JudgeProvider/store still restores, gates and persists the preference.
jest.mock('../screens/judge-storage', () => {
    const values = new Map<string, string>()
    return {
        judgeStorage: {
            getItem: async (key: string): Promise<string | null> => values.get(key) ?? null,
            setItem: async (key: string, value: string): Promise<void> => {
                values.set(key, value)
            },
        },
    }
})
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('expo-camera', () => ({
    Camera: { getCameraPermissionsAsync: (): unknown => mockGetCameraPermissions() },
    useCameraPermissions: (options?: { get?: boolean }): unknown[] => {
        const React = jest.requireActual<typeof ReactModule>('react')
        const [permission, setPermission] = React.useState<{ granted: boolean; canAskAgain: boolean } | null>(null)
        React.useEffect(() => {
            let active = true
            if (options?.get !== false)
                void mockGetCameraPermissions().then((next) => {
                    if (active) setPermission(next)
                })
            return (): void => {
                active = false
            }
        }, [options?.get])
        return [permission, mockRequestCameraPermission]
    },
    CameraView: (props: Record<string, unknown>): ReactModule.ReactElement => {
        const React = jest.requireActual<typeof ReactModule>('react')
        const { View } = jest.requireActual<typeof ReactNative>('react-native')
        return React.createElement(View, { ...props, testID: 'hardware-preview' })
    },
}))
const { testRouter } = jest.requireActual<{
    testRouter: { push: (path: string) => Promise<void>; back: (path?: string) => Promise<void> }
}>('expo-router/testing-library')
const { renderRouter } = jest.requireActual<{ renderRouter: (directory: string) => Promise<Mounted['view']> }>(
    'expo-router/testing-library',
)
let mounted: Mounted | null = null
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
beforeAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
})
afterAll(() => {
    if (originalLocation === undefined) Reflect.deleteProperty(window, 'location')
    else Object.defineProperty(window, 'location', originalLocation)
})
afterEach(async () => {
    await cleanup()
    mounted?.store.dispose()
    mounted?.controller.dispose()
    mounted = null
    jest.mocked(createController).mockReset()
    jest.mocked(createDocuments).mockReset()
    jest.mocked(createScreens).mockReset()
    mockGetCameraPermissions.mockReset().mockResolvedValue({ granted: true, canAskAgain: true })
    mockRequestCameraPermission.mockReset()
    jest.restoreAllMocks()
})
const root = (id: string): ReturnType<typeof parseNativeMeterMarkers> =>
    parseNativeMeterMarkers(screen.getByTestId(id).props.nativeID)
const primary = (id: string): ReturnType<typeof screen.getByRole> =>
    within(within(screen.getByTestId(id)).getByTestId('bottom-bar')).getAllByRole('button')[0]!

it('retains the actual generated Home while a cold Guide prepares, then navigates once without another tap', async () => {
    const gate = deferred<void>()
    mounted = await mount([entry()], { screens: { generated: ['guide'], gate: gate.promise } })
    const previous = root('library-screen')
    expect(previous?.origin).toBe('generated')
    await press('Continue building')
    await flush()
    expect(mounted.view.getPathname()).toBe('/')
    expect(root('library-screen')?.documentRoot).toBe(previous?.documentRoot)
    expect(root('library-screen')?.origin).toBe('generated')
    expect(primary('library-screen')).toBeDisabled()
    expect(screen.queryByTestId('guide-screen')).toBeNull()
    await act(async () => gate.resolve())
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/flow-manual'))
    expect(root('guide-screen')?.origin).toBe('generated')
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeEnabled()
    const idle = mounted.server.requests.filter(
        (request) =>
            request.op === 'generate' &&
            request.kind === 'guide' &&
            request.stepId === 'step-1' &&
            request.uiState?.busy == null,
    )
    expect(idle).toHaveLength(1)
})

it('keeps a witnessed Home ready composition while saving leaves its displayed facts unchanged', async () => {
    mounted = await mount([])
    const gate = deferred<void>()
    const storage = mounted.storage
    const save = storage.save
    jest.spyOn(storage, 'save').mockImplementation(
        async (...args: Parameters<typeof save>): ReturnType<typeof save> => {
            await gate.promise
            return save.apply(storage, args)
        },
    )
    const previous = root('library-screen')
    await press('Add a manual')
    await waitFor(() => expect(mounted!.controller.getSnapshot().pending).toBe('Saving on this device…'))
    expect(root('library-screen')?.documentRoot).toBe(previous.documentRoot)
    expect(screen.getByRole('button', { name: 'Add a manual' })).toBeDisabled()
    expect(primary('library-screen').props.accessibilityState.busy).toBe(true)
    await act(async () => {
        gate.resolve()
    })
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/add'))
    expect(root('pages-screen')?.origin).toBe('generated')
})

it.each(['unparsed', 'unreviewed'] as const)(
    'keeps the %s manual read running after Keep, then enters the exact generated Quick check',
    async (stage) => {
        const gate = deferred<void>()
        const parse = deferred<void>()
        mounted = await mount([entry('readiness', stage)], {
            screens: { generated: ['quick-check'], gate: gate.promise },
            replies: { parse: parse.promise },
        })
        await act(async () => mounted!.controller.open('readiness', 'pages'))
        await fireEvent.press(await screen.findByTestId('read-manual'))
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/reading/readiness'))
        const previous = root('reading-screen')
        expect(previous?.origin).toBe('generated')
        await press('Back')
        await press('Keep reading')
        expect(mounted.controller.getSnapshot().pending).toMatch(/^Reading/u)
        expect(mounted.calls.filter((call) => call.endsWith('/parse'))).toHaveLength(1)
        await act(async () => parse.resolve())
        await flush()
        expect(mounted.controller.getSnapshot().route).toBe('overview')
        expect(mounted.view.getPathname()).toBe('/reading/readiness')
        expect(root('reading-screen')?.documentRoot).toBe(previous?.documentRoot)
        expect(primary('reading-screen')).toBeDisabled()
        await act(async () => gate.resolve())
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/check/readiness'))
        expect(root('overview-screen')?.origin).toBe('generated')
        const request = mounted.server.requests.find(
            (request) => request.op === 'generate' && request.kind === 'quick-check',
        )
        expect(request?.uiState?.busy).toBeNull()
        expect(request?.uiState?.review?.currentQuestion).toBeNull()
        expect(screen.getByTestId('quick-check-start')).toBeEnabled()
    },
)

it('stops a re-read at the actual Pages destination and keeps its cancel notice and previous extraction', async () => {
    const parse = deferred<void>()
    mounted = await mount([entry('reread-stop', 'unreviewed')], { replies: { parse: parse.promise } })
    await act(async () => mounted!.controller.open('reread-stop', 'overview'))
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/check/reread-stop'))
    const before = structuredClone(mounted.controller.current!.session)
    await press('Read again')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/reading/reread-stop'))
    await waitFor(() => expect(mounted!.calls.filter((call) => call.endsWith('/parse'))).toHaveLength(1))
    await press('Back')
    await press('Stop reading')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/add'))
    expect(screen.getAllByText('Stopped, so nothing more will be shown.')).toHaveLength(1)
    expect(mounted.controller.current!.session).toEqual(before)
    expect(mounted.controller.getSnapshot().route).toBe('pages')
    await act(async () => parse.resolve())
    await flush()
    expect(mounted.view.getPathname()).toBe('/add')
    expect(mounted.controller.current!.session).toEqual(before)
    expect((await mounted.storage.restore()).entries[0]!.session).toEqual(before)
    expect(mounted.calls.filter((call) => call.endsWith('/parse'))).toHaveLength(1)
})

it('preserves the actual generated last result while saved completion prepares, then shows generated Done', async () => {
    const gate = deferred<void>()
    let hold = false
    mounted = await mount([entry('last-step', 'reviewed', 1)], {
        screens: {
            generated: ['guide', 'result', 'completion'],
            get gate() {
                return hold ? gate.promise : undefined
            },
        },
    })
    await press('Continue building')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/last-step'))
    await press('Take photo')
    await act(async () => mounted!.controller.shutter(async () => source))
    await waitFor(() => expect(root('guide-screen')?.origin).toBe('generated'))
    await loadPhoto()
    expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
    const previous = root('guide-screen')
    const heldPhoto = screen.getByTestId('frozen-photo-image').props.source
    hold = true
    await fireEvent.press(screen.getByTestId('guide-primary'))
    await waitFor(() => expect(mounted!.controller.current?.completedStepIds).toEqual(['step-1']))
    expect(mounted.view.getPathname()).toBe('/guide/last-step')
    expect(root('guide-screen')?.documentRoot).toBe(previous?.documentRoot)
    expect(primary('guide-screen')).toBeDisabled()
    expect(screen.getByTestId('frozen-photo-image').props.source).toEqual(heldPhoto)
    expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
    expect(heldPhoto.uri).toMatch(/^data:image\/jpeg;base64,/u)
    await act(async () => gate.resolve())
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/done/last-step'))
    expect(root('done-screen')?.origin).toBe('generated')
    expect(screen.getByText('1 of 1 steps marked done')).toBeTruthy()
})

it('reserves non-final completion before save invalidates its witnessed ready Result and photo', async () => {
    const gate = deferred<void>()
    let holdSave = false
    mounted = await mount([entry('next-step', 'reviewed', 2)], { screens: { generated: ['guide', 'result'] } })
    await press('Continue building')
    await press('Take photo')
    await act(async () => mounted!.controller.shutter(async () => source))
    await loadPhoto()
    expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
    const previous = root('guide-screen')
    const photo = screen.getByTestId('frozen-photo-image').props.source
    const storage = mounted.storage
    const save = storage.save
    jest.spyOn(storage, 'save').mockImplementation(
        async (...args: Parameters<typeof save>): ReturnType<typeof save> => {
            if (holdSave) await gate.promise
            return save.apply(storage, args)
        },
    )
    holdSave = true
    await fireEvent.press(screen.getByTestId('guide-primary'))
    await waitFor(() => expect(mounted!.controller.getSnapshot().pending).toBe('Saving on this device…'))
    expect(mounted.controller.getSnapshot().capture).toBeNull()
    expect(root('guide-screen')?.documentRoot).toBe(previous.documentRoot)
    expect(screen.getByTestId('frozen-photo-image').props.source).toEqual(photo)
    expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
    expect(primary('guide-screen')).toBeDisabled()
    expect(screen.queryByText(/^Step 2 of/u)).toBeNull()
    await act(async () => {
        gate.resolve()
    })
    await waitFor(() => expect(mounted!.controller.current?.stepIndex).toBe(1))
    expect(await screen.findByText(/^Step 2 of/u)).toBeTruthy()
    expect(root('guide-screen')?.origin).toBe('generated')
    expect(root('guide-screen')?.documentRoot).not.toBe(previous.documentRoot)
    expect(screen.queryByTestId('frozen-photo-image')).toBeNull()
})

it('shows the actual held photo while Spark is pending, then reveals its result without an extra image load or local document request', async () => {
    const check = deferred<void>()
    let shutter!: Promise<void>
    mounted = await mount([entry()], {
        screens: { generated: ['guide', 'camera', 'result'] },
        replies: { check_gate: check.promise },
    })
    await press('Continue building')
    await press('Take photo')
    await act(async () => {
        shutter = mounted!.controller.shutter(async () => source)
    })
    try {
        await waitFor(() => expect(mounted!.controller.pendingCheckCapture).not.toBeNull())
        const state = mounted.controller.getSnapshot()
        const inputs = documentInputs('result', { state, entry: mounted.controller.current })
        expect(state.check).toBeNull()
        expect(inputs.result).toBeNull()
        expect(state.capture?.reusable).toBe(true)
        expect(mounted.store.peek(inputs)).toBeUndefined()
        const preview = mounted.store.preview(inputs)
        expect(preview.document.metadata.source).toBe('generated')
        expect(preview.exactGeneration).toBeUndefined()
        expect(preview.document.bound.captureId).toBe(state.capture?.binding.captureId)
        expect(mounted.store.readyAt(inputs)).toBeNull()
        expect(mounted.server.requests.filter((request) => request.kind === 'result')).toHaveLength(0)
        const photo = await screen.findByTestId('frozen-photo-image')
        expect(root('guide-screen')?.documentRoot).toBe(preview.document.screenId)
        const uri = photo.props.source.uri as string
        expect(uri).toMatch(/^data:image\/jpeg;base64,/u)
        await loadPhoto()
        expect(screen.queryByText('Looks right')).toBeNull()
        expect(primary('guide-screen')).toBeDisabled()
        await act(async () => {
            check.resolve()
            await shutter
        })
        expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
        expect(screen.getByTestId('frozen-photo-image')).toBe(photo)
        expect(screen.getByTestId('frozen-photo-image').props.source.uri).toBe(uri)
        expect(mounted.controller.pendingCheckCapture).toBeNull()
        expect(screen.getByRole('button', { name: 'Next step' })).toBeEnabled()
    } finally {
        check.resolve()
        await shutter
    }
})

it.each(['document', 'native'] as const)(
    'cancels a preparing Guide on %s Back and refuses its late completion',
    async (back) => {
        const gate = deferred<void>()
        let holdRequest = false
        mounted = await mount([entry('cancel', 'unreviewed')], {
            screens: {
                generated: ['quick-check', 'guide'],
                onRequest: (request): void => {
                    holdRequest = request.op === 'precompute' || (request.op === 'generate' && request.kind === 'guide')
                },
                get gate() {
                    return holdRequest ? gate.promise : undefined
                },
            },
        })
        await act(async () => mounted!.controller.open('cancel', 'overview'))
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/check/cancel'))
        await waitFor(() => expect(root('overview-screen')?.origin).toBe('generated'))
        await fireEvent.press(screen.getByTestId('quick-check-start'))
        await flush()
        expect(mounted.view.getPathname()).toBe('/check/cancel')
        if (back === 'document') await press('Back')
        else await testRouter.back('/')
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/'))
        await act(async () => gate.resolve())
        await flush()
        expect(mounted.view.getPathname()).toBe('/')
        expect(screen.queryByTestId('guide-screen')).toBeNull()
    },
)

it('keeps intentional off mode immediate and makes no generation request', async () => {
    mounted = await mount([entry()], { screens: 'off' })
    const wait = jest.spyOn(mounted.store, 'waitForGenerated')
    await press('Continue building')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/flow-manual'))
    expect(root('guide-screen')?.origin).toBe('fallback')
    expect(mounted.server.requests).toEqual([])
    expect(wait).not.toHaveBeenCalled()
    await testRouter.back('/')
})

it('keeps a disabled Quick check immediate in steps mode without awaiting or dispatching its document', async () => {
    const { controller, calls, storage } = await runtime([entry('steps', 'unreviewed')])
    const server = fixtureDocuments({ generated: ['guide'] })
    const store = new DocumentStore({ client: server, mode: 'steps', id: (): string => 'steps', pollMs: 1 })
    jest.mocked(createController).mockReturnValue(controller)
    jest.mocked(createDocuments).mockReturnValue(store)
    jest.mocked(createScreens).mockReturnValue(null)
    const view = await renderRouter(resolve(__dirname, '../../../app'))
    mounted = { view, controller, calls, store, server, storage }
    await waitFor(() => expect(controller.getSnapshot().loading).toBe(false))
    const wait = jest.spyOn(store, 'waitForGenerated')
    await act(async () => controller.open('steps', 'overview'))
    await waitFor(() => expect(view.getPathname()).toBe('/check/steps'))
    expect(root('overview-screen')?.origin).toBe('fallback')
    expect(wait).not.toHaveBeenCalled()
    expect(server.requests.some((request) => request.kind === 'quick-check')).toBe(false)
})

it('opens a completed manual directly in steps mode without preparing an unseen Guide', async () => {
    const manual = entry('finished', 'reviewed', 1)
    manual.completedStepIds = ['step-1']
    const { controller, calls, storage } = await runtime([manual])
    const server = fixtureDocuments({ generated: ['guide'] })
    const store = new DocumentStore({ client: server, mode: 'steps', id: (): string => 'finished', pollMs: 1 })
    jest.mocked(createController).mockReturnValue(controller)
    jest.mocked(createDocuments).mockReturnValue(store)
    jest.mocked(createScreens).mockReturnValue(null)
    const view = await renderRouter(resolve(__dirname, '../../../app'))
    mounted = { view, controller, calls, store, server, storage }
    await waitFor(() => expect(controller.getSnapshot().loading).toBe(false))
    const wait = jest.spyOn(store, 'waitForGenerated')
    await press('Continue building')
    await waitFor(() => expect(view.getPathname()).toBe('/done/finished'))
    expect(wait).not.toHaveBeenCalled()
    expect(root('done-screen')?.origin).toBe('fallback')
})

it('prepares the same first real missing-fact question that the entered Quick check renders', async () => {
    const manual = entry('question', 'unreviewed')
    manual.session.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Direction unclear.' }
    const gate = deferred<void>()
    mounted = await mount([manual], { screens: { generated: ['quick-check'], gate: gate.promise } })
    await press('Continue building')
    await flush()
    expect(mounted.view.getPathname()).toBe('/')
    const request = mounted.server.requests.find(
        (request) => request.op === 'generate' && request.kind === 'quick-check',
    )
    expect(request?.uiState?.review?.currentQuestion).toMatchObject({
        questionId: 'step-1:orientation',
        stepId: 'step-1',
        kind: 'orientation',
        reason: 'Direction unclear.',
    })
    await act(async () => gate.resolve())
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/check/question'))
    expect(root('overview-screen')?.origin).toBe('generated')
    expect(screen.getByText('Which way should the part face in step 1?')).toBeTruthy()
    expect(screen.getByLabelText('Orientation')).toBeTruthy()
})

it('invalidates a waiting Guide when the selected manual changes and never jumps back to its late response', async () => {
    const gate = deferred<void>()
    mounted = await mount([entry('first'), entry('other')], { screens: { generated: ['guide'], gate: gate.promise } })
    await act(async () => mounted!.controller.open('first', 'guide'))
    await flush()
    expect(mounted.view.getPathname()).toBe('/')
    await act(async () => mounted!.controller.open('other', 'pages'))
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/add'))
    await act(async () => gate.resolve())
    await flush()
    expect(mounted.view.getPathname()).toBe('/add')
    expect(mounted.controller.getSnapshot().selectedId).toBe('other')
})

it('invalidates readiness on application unmount and makes no late navigation', async () => {
    const gate = deferred<void>()
    mounted = await mount([entry()], { screens: { generated: ['guide'], gate: gate.promise } })
    await press('Continue building')
    await flush()
    const push = jest.spyOn(router, 'push')
    await mounted.view.unmount()
    await act(async () => gate.resolve())
    await flush()
    expect(push).not.toHaveBeenCalled()
})

it('enters a truthful complete fallback after a genuine target failure without retrying the user action', async () => {
    mounted = await mount([entry()], { screens: { failing: ['guide'] } })
    await press('Continue building')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/flow-manual'))
    expect(root('guide-screen')?.origin).toBe('fallback')
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeTruthy()
    expect(
        mounted.server.requests.filter(
            (request) =>
                request.op === 'generate' &&
                request.kind === 'guide' &&
                request.stepId === 'step-1' &&
                request.uiState?.busy == null,
        ),
    ).toHaveLength(1)
})

it('keeps the existing sheet-close identity when the authored Close action is in its primary bar', async () => {
    mounted = await mount([])
    await press('More')
    await fireEvent.press(await screen.findByTestId('close-sheet'))
    await waitFor(() => expect(screen.queryByTestId('more-sheet')).toBeNull())
    await press('More')
    await fireEvent.press(await screen.findByTestId('judge-entry'))
    await fireEvent.press(await screen.findByTestId('close-sheet'))
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'Show how Meta AI built this' })).toBeNull())
})

it.each(['ready', 'back'] as const)(
    'queries actual camera access only on intent and retains the generated Guide during camera preparation (%s)',
    async (outcome) => {
        const gate = deferred<void>()
        let holdCamera = false
        mounted = await mount([entry()], {
            screens: {
                generated: ['guide', 'camera'],
                onRequest: (request): void => {
                    holdCamera = request.op === 'generate' && request.kind === 'camera'
                },
                get gate() {
                    return holdCamera ? gate.promise : undefined
                },
            },
        })
        await press('Continue building')
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/flow-manual'))
        expect(mockGetCameraPermissions).not.toHaveBeenCalled()
        const previous = root('guide-screen')
        await press('Take photo')
        await flush()
        expect(mockGetCameraPermissions).toHaveBeenCalledTimes(1)
        expect(mockRequestCameraPermission).not.toHaveBeenCalled()
        expect(mounted.view.getPathname()).toBe('/guide/flow-manual')
        expect(root('guide-screen')?.documentRoot).toBe(previous?.documentRoot)
        expect(primary('guide-screen')).toBeDisabled()
        const camera = mounted.server.requests.find((request) => request.op === 'generate' && request.kind === 'camera')
        expect(camera).toMatchObject({
            captureId: null,
            uiState: { camera: { mode: 'build-photo', permission: 'granted', failed: false, canAskAgain: true } },
        })
        if (outcome === 'back') {
            await press('Back')
            await waitFor(() => expect(mounted!.view.getPathname()).toBe('/'))
            await act(async () => gate.resolve())
            await flush()
            expect(mounted.view.getPathname()).toBe('/')
            expect(mounted.controller.getSnapshot().route).toBe('guide')
            expect(screen.queryByTestId('camera-screen')).toBeNull()
            return
        }
        await act(async () => gate.resolve())
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/camera'))
        expect(root('camera-screen')?.origin).toBe('generated')
        expect(screen.getByTestId('hardware-preview')).toBeTruthy()
        expect(mockGetCameraPermissions).toHaveBeenCalledTimes(1)
    },
)

it.each(['denied', 'query-failed'] as const)(
    'uses conservative measured camera access after %s and never requests consent automatically',
    async (outcome) => {
        if (outcome === 'denied') mockGetCameraPermissions.mockResolvedValue({ granted: false, canAskAgain: false })
        else mockGetCameraPermissions.mockRejectedValue(new Error('Synthetic permission query failure'))
        mounted = await mount([entry()], { screens: { generated: ['guide', 'camera'] } })
        await press('Continue building')
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/flow-manual'))
        await press('Take photo')
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/camera'))
        expect(root('camera-screen')?.origin).toBe('generated')
        expect(mockGetCameraPermissions).toHaveBeenCalledTimes(1)
        expect(mockRequestCameraPermission).not.toHaveBeenCalled()
        expect(screen.queryByTestId('hardware-preview')).toBeNull()
        // Earlier model-only preparation cannot determine permission. The actual route uses the measured access.
        expect(
            mounted.server.requests.filter((request) => request.kind === 'camera').at(-1)?.uiState?.camera,
        ).toMatchObject({
            permission: outcome === 'denied' ? 'denied' : 'undetermined',
            canAskAgain: outcome === 'denied' ? false : null,
            failed: false,
        })
    },
)

it('cancels camera preparation on Back before a permission query completes and refuses the late camera jump', async () => {
    const permission = deferred<{ granted: boolean; canAskAgain: boolean }>()
    mockGetCameraPermissions.mockReturnValue(permission.promise)
    mounted = await mount([entry()], { screens: { generated: ['guide', 'camera'] } })
    await press('Continue building')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/flow-manual'))
    const preparedCameras = mounted.server.requests.filter((request) => request.kind === 'camera')
    await press('Take photo')
    await flush()
    expect(mockGetCameraPermissions).toHaveBeenCalledTimes(1)
    expect(mounted.view.getPathname()).toBe('/guide/flow-manual')
    await press('Back')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/'))
    await act(async () => permission.resolve({ granted: true, canAskAgain: true }))
    await flush()
    expect(mounted.view.getPathname()).toBe('/')
    expect(mounted.server.requests.filter((request) => request.kind === 'camera')).toEqual(preparedCameras)
    expect(mockRequestCameraPermission).not.toHaveBeenCalled()
})

it.each([-3_600_000, 3_600_000])(
    'keeps the real camera generation wait bounded after a %sms wall-clock jump',
    async (jump) => {
        const permission = deferred<{ granted: boolean; canAskAgain: boolean }>()
        const gate = deferred<void>()
        let holdCamera = false
        mockGetCameraPermissions.mockReturnValue(permission.promise)
        mounted = await mount([entry()], {
            screens: {
                generated: ['guide', 'camera'],
                onRequest: (request): void => {
                    holdCamera = request.op === 'generate' && request.kind === 'camera'
                },
                get gate() {
                    return holdCamera ? gate.promise : undefined
                },
            },
        })
        await press('Continue building')
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/flow-manual'))
        let wallTime = Date.now()
        jest.spyOn(Date, 'now').mockImplementation((): number => wallTime)
        const wait = jest.spyOn(mounted.store, 'waitForGenerated')
        await press('Take photo')
        await flush()
        wallTime += jump
        await act(async () => permission.resolve({ granted: true, canAskAgain: true }))
        await flush()
        const cameraWait = wait.mock.calls.find(([inputs]) => inputs.kind === 'camera')
        expect(cameraWait).toBeDefined()
        const timeout = cameraWait![1]?.timeoutMs
        expect(Number.isSafeInteger(timeout)).toBe(true)
        expect(timeout).toBeGreaterThan(0)
        expect(timeout).toBeLessThanOrEqual(DOCUMENT_COLLECTION_DEADLINE_MS)
        expect(mounted.view.getPathname()).toBe('/guide/flow-manual')
        expect(primary('guide-screen')).toBeDisabled()
        await act(async () => gate.resolve())
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/camera'))
        expect(root('camera-screen')?.origin).toBe('generated')
    },
)

describe('a cold Compare', () => {
    type Hold = ReturnType<typeof deferred<void>>
    const needed = ['compare', 'manual-a', 'manual-b'] as const
    const manuals = (): ReturnType<typeof entry>[] => [
        entry('manual-a', 'reviewed', 2, 'Alpha'),
        entry('manual-b', 'reviewed', 3, 'Beta'),
    ]
    const compareControl = (): ReturnType<typeof screen.getByTestId> => screen.getByTestId('judge-compare')
    // The outer Compare, and the two panes it opens with: the only Guide requests that carry no live state.
    const compareRequests = (): Mounted['server']['requests'] =>
        mounted!.server.requests.filter((request) => request.op === 'generate' && request.kind === 'compare')
    const paneRequests = (): Mounted['server']['requests'] =>
        mounted!.server.requests.filter(
            (request) => request.op === 'generate' && request.kind === 'guide' && request.uiState == null,
        )
    const requested = (): string[] =>
        [...compareRequests(), ...paneRequests()].map((request) =>
            request.kind === 'compare' ? 'compare' : request.session!.manualId,
        )
    const rendered = (kind: string): ReturnType<typeof renderedDocuments> =>
        renderedDocuments(screen.container).filter((document) => document.kind === kind)
    const openJudge = async (): Promise<void> => {
        await press('More')
        await fireEvent.press(await screen.findByTestId('judge-entry'))
        await screen.findByTestId('judge-compare')
    }
    // A restored full-mode app whose Judge preference is already on. Home, More and Judge are composed; the transport
    // answers nothing for the outer Compare or either opening pane until the test releases that exact document.
    async function openColdJudge(
        options: { failing?: readonly 'compare'[]; from?: 'guide' } = {},
    ): Promise<Map<string, Hold>> {
        const holds = new Map<string, Hold>(needed.map((id) => [id, deferred<void>()]))
        let held: Promise<void> | undefined
        mounted = await mount(manuals(), {
            screens: {
                generated: ['home', 'more', 'judge', 'compare', 'guide'],
                failing: options.failing ?? [],
                onRequest: (request): void => {
                    const document =
                        request.kind === 'compare'
                            ? 'compare'
                            : request.kind === 'guide' && request.uiState == null
                              ? request.session?.manualId
                              : undefined
                    held =
                        request.op === 'generate' && document !== undefined ? holds.get(document)?.promise : undefined
                },
                get gate() {
                    return held
                },
            },
        })
        if (options.from === 'guide') {
            await act(async () => mounted!.controller.open('manual-a', 'guide'))
            await waitFor(() => expect(mounted!.view.getPathname()).toBe('/guide/manual-a'))
        }
        await openJudge()
        return holds
    }
    // Press Compare and wait until exactly the cold documents have been asked for, still on the source screen.
    // A selected manual's Guide is prepared already; Compare and the other manual's pane remain cold.
    const pressCompare = async (cold: readonly string[] = needed): Promise<void> => {
        const origin = mounted!.view.getPathname()
        await fireEvent.press(compareControl())
        await waitFor(() => expect(requested().sort()).toEqual([...cold].sort()))
        expect(mounted!.view.getPathname()).toBe(origin)
        expect(rendered('compare')).toEqual([])
    }
    beforeEach(async () => {
        await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: true }))
    })
    afterEach(async () => {
        await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: false }))
    })

    it.each(needed)(
        'keeps the generated Judge busy until the outer Compare and both opening panes are ready (%s last)',
        async (last) => {
            const holds = await openColdJudge()
            const judge = rendered('judge')
            expect(judge.map((document) => document.metadata.source)).toEqual(['generated'])
            const wait = jest.spyOn(mounted!.store, 'waitForGenerated')
            await pressCompare()
            expect(rendered('judge')).toEqual(judge)
            expect(compareControl().props.accessibilityState).toMatchObject({ busy: true, disabled: true })
            // A repeat press is the same busy control; it neither restarts nor duplicates any request.
            await fireEvent.press(compareControl())
            for (const id of needed.filter((id) => id !== last)) await act(async () => holds.get(id)!.resolve())
            await flush()
            expect(mounted!.view.getPathname()).toBe('/')
            expect(compareControl().props.accessibilityState).toMatchObject({ busy: true })
            expect(rendered('compare')).toEqual([])
            await act(async () => holds.get(last)!.resolve())
            await waitFor(() => expect(mounted!.view.getPathname()).toBe('/compare'))
            expect(rendered('compare').map((document) => document.metadata.source)).toEqual(['generated'])
            expect(
                rendered('guide')
                    .map((document) => [document.bound.manualId, document.metadata.source])
                    .sort(),
            ).toEqual([
                ['manual-a', 'generated'],
                ['manual-b', 'generated'],
            ])
            expect(screen.getByTestId('compare-pane-manual-a')).toBeTruthy()
            expect(screen.getByTestId('compare-pane-manual-b')).toBeTruthy()
            expect(screen.queryByTestId('judge-compare')).toBeNull()
            // The entered route reuses the prepared documents exactly, so it asks for nothing more.
            expect(compareRequests()).toHaveLength(1)
            expect(paneRequests()).toHaveLength(2)
            expect(wait).toHaveBeenCalledTimes(3)
            for (const [, options] of wait.mock.calls) {
                expect(options?.signal).toBeDefined()
                expect(Number.isSafeInteger(options?.timeoutMs)).toBe(true)
                expect(options!.timeoutMs).toBeGreaterThan(0)
                expect(options!.timeoutMs).toBeLessThanOrEqual(DOCUMENT_COLLECTION_DEADLINE_MS)
            }
            expect(mockGetCameraPermissions).not.toHaveBeenCalled()
            expect(mockRequestCameraPermission).not.toHaveBeenCalled()
        },
    )

    it.each([
        ['Close', undefined, '/'],
        ['a route change', 'guide', '/add'],
        ['a library change', 'guide', '/guide/manual-a'],
    ] as const)(
        'never opens a Compare that finishes after %s, and releases its reservation',
        async (stop, from, at) => {
            const holds = await openColdJudge({ from })
            const push = jest.spyOn(router, 'push')
            await pressCompare(from === 'guide' ? ['compare', 'manual-b'] : needed)
            if (stop === 'Close') {
                await fireEvent.press(screen.getByTestId('close-sheet'))
                await waitFor(() => expect(screen.queryByTestId('judge-compare')).toBeNull())
            } else if (stop === 'a route change') {
                await act(async () => mounted!.controller.navigate('pages'))
                await waitFor(() => expect(mounted!.view.getPathname()).toBe('/add'))
            } else {
                await act(async () => mounted!.controller.rename('Renamed while Compare waits'))
                await waitFor(() => expect(mounted!.controller.getSnapshot().pending).toBeNull())
            }
            // Routing only proceeds while no preparation holds the owner, so reaching /add already shows its release.
            if (stop === 'a library change')
                expect(compareControl().props.accessibilityState).toMatchObject({ busy: false })
            for (const hold of holds.values()) await act(async () => hold.resolve())
            await flush()
            expect(push).not.toHaveBeenCalledWith('/compare')
            expect(mounted!.view.getPathname()).toBe(at)
            expect(rendered('compare')).toEqual([])
            if (stop === 'Close') {
                // The reservation is gone and the documents are cached, so the next press opens at once.
                await fireEvent.press(await screen.findByTestId('judge-entry'))
                await fireEvent.press(await screen.findByTestId('judge-compare'))
                await waitFor(() => expect(mounted!.view.getPathname()).toBe('/compare'))
                expect(requested().sort()).toEqual([...needed].sort())
            }
        },
    )

    it('releases its reservation once it has opened, so the next press opens at once from the cached documents', async () => {
        const holds = await openColdJudge()
        await pressCompare()
        for (const hold of holds.values()) await act(async () => hold.resolve())
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/compare'))
        await testRouter.back('/')
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/'))
        await openJudge()
        await fireEvent.press(compareControl())
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/compare'))
        expect(requested().sort()).toEqual([...needed].sort())
    })

    it('opens with its truthful provider failure only once Compare itself has failed, never for ordinary pending', async () => {
        const holds = await openColdJudge({ failing: ['compare'] })
        await pressCompare()
        for (const id of ['manual-a', 'manual-b']) await act(async () => holds.get(id)!.resolve())
        await flush()
        expect(mounted!.view.getPathname()).toBe('/')
        expect(compareControl().props.accessibilityState).toMatchObject({ busy: true })
        await act(async () => holds.get('compare')!.resolve())
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/compare'))
        expect(
            rendered('compare').map((document) => [document.metadata.source, document.metadata.fallbackReason]),
        ).toEqual([['fallback', 'provider_error']])
        expect(rendered('guide').map((document) => document.metadata.source)).toEqual(['generated', 'generated'])
        expect(compareRequests()).toHaveLength(1)
    })

    it.each(['off', 'steps'] as const)('opens at once in %s mode without waiting for any document', async (mode) => {
        if (mode === 'off') mounted = await mount(manuals(), { screens: 'off' })
        else {
            const { controller, calls, storage } = await runtime(manuals())
            const server = fixtureDocuments({ generated: ['compare', 'guide'] })
            const store = new DocumentStore({ client: server, mode: 'steps', id: (): string => 'steps', pollMs: 1 })
            jest.mocked(createController).mockReturnValue(controller)
            jest.mocked(createDocuments).mockReturnValue(store)
            jest.mocked(createScreens).mockReturnValue(null)
            const view = await renderRouter(resolve(__dirname, '../../../app'))
            mounted = { view, controller, calls, store, server, storage }
            await waitFor(() => expect(controller.getSnapshot().loading).toBe(false))
        }
        const wait = jest.spyOn(mounted.store, 'waitForGenerated')
        await openJudge()
        await fireEvent.press(compareControl())
        await waitFor(() => expect(mounted!.view.getPathname()).toBe('/compare'))
        expect(wait).not.toHaveBeenCalled()
        expect(compareRequests()).toHaveLength(0)
    })
})
