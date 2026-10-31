/// <reference types="node" />

import type * as ReactModule from 'react'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { createController, createDocuments, createScreens } from '../capture/controller-factory'
import { flush, loadPhoto, mount, press, type Mounted } from './test-support/flow'
import { deferred, entry, source } from './test-support/route-harness'
import { judgeStorage } from './judge-storage'
import { JUDGE_STORAGE_KEY } from './judge-store'
import type { JsonElement } from 'test-renderer'
import { parseNativeMeterMarkers } from '../../ui/native-meter-markers'

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
jest.mock('../capture/controller-factory', () => ({
    createController: jest.fn(),
    createScreens: jest.fn(),
    createDocuments: jest.fn(),
}))
jest.mock('./judge-storage', () => {
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
jest.unmock('react-native/Libraries/AppState/AppState')
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

let mockObserveCommit = (): void => {}
// Instrument the real root without changing its provider order, document props, Modal, photo or gates. Profiler adds
// no host elements; the callback reads only the committed host tree after each real update in its subtree.
jest.mock('../../../app/_layout', () => {
    const react = jest.requireActual<typeof ReactModule>('react')
    const actual = jest.requireActual<{ default: () => ReactModule.ReactElement }>('../../../app/_layout')
    return {
        ...actual,
        default: function ObservedRoot(): ReactModule.ReactElement {
            return react.createElement(
                react.Profiler,
                { id: 'fresh-question-root', onRender: (): void => mockObserveCommit() },
                react.createElement(actual.default),
            )
        },
    }
})

const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
beforeAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
})
afterAll(() => {
    if (originalLocation === undefined) Reflect.deleteProperty(window, 'location')
    else Object.defineProperty(window, 'location', originalLocation)
})
afterEach(async () => {
    mockObserveCommit = (): void => {}
    await cleanup()
    jest.restoreAllMocks()
    jest.mocked(createController).mockReset()
    jest.mocked(createScreens).mockReset()
    jest.mocked(createDocuments).mockReset()
    jest.useRealTimers()
    await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: false }))
})

interface Commit {
    pending: string | null
    answer: boolean
    sheet: boolean
    visibleModal: boolean
    sheetPhoto: number | null
    outerPhoto: number | null
    outerTitle: string
    outerOrigin: string | null
    answerText: boolean
}
function all(root: JsonElement | null, predicate: (node: JsonElement) => boolean): JsonElement[] {
    if (root === null) return []
    return [
        ...(predicate(root) ? [root] : []),
        ...root.children.flatMap((child) => (typeof child === 'string' ? [] : all(child, predicate))),
    ]
}
function photoWidth(root: JsonElement | null): number | null {
    const photo = all(root, (node) => node.props.testID === 'frozen-photo-image')[0]
    return photo === undefined ? null : (StyleSheet.flatten(photo.props.style).width as number)
}
function strings(root: JsonElement | null): string[] {
    return root === null ? [] : root.children.flatMap((child) => (typeof child === 'string' ? [child] : strings(child)))
}
function commit(mounted: Mounted): Commit {
    const state = mounted.controller.getSnapshot()
    const tree = mounted.view.toJSON()
    const sheet = all(tree, (node) => node.props.testID === 'more-sheet')[0] ?? null
    const outer = all(tree, (node) => node.props.testID === 'guide-screen')[0] ?? null
    return {
        pending: state.pending,
        answer: state.answer !== null,
        sheet: sheet !== null,
        visibleModal: all(tree, (node) => node.type === 'Modal' && node.props.visible === true).length > 0,
        sheetPhoto: photoWidth(sheet),
        outerPhoto: photoWidth(outer),
        outerTitle: strings(all(outer, (node) => node.props.testID === 'document-header-copy')[0] ?? null).join(' '),
        outerOrigin: parseNativeMeterMarkers(outer?.props.nativeID).origin,
        answerText: strings(outer).includes('The groove faces inward.'),
    }
}

it('keeps a fresh point-only Question through a real 202 and does not conceal its delivered Answer after Modal handoff', async () => {
    const answer = deferred<void>()
    const manual = entry('fresh-question-manual', 'reviewed', 2)
    manual.session.reviewedSteps = manual.session.reviewedSteps.map((step) => ({ ...step, safetyNotes: [] }))
    const mounted = await mount([manual], {
        screens: { generated: ['guide', 'questions', 'answer'] },
        replies: { question_gate: answer.promise, question_ticket: true },
    })
    try {
        await press('Continue building')
        await screen.findByText(/^Step 1 of \d+$/u)
        await press('Ask about this step')
        expect(mounted.controller.getSnapshot().cameraIntent?.kind).toBe('question')
        await act(async () => mounted.controller.shutter(async () => source))
        await screen.findByTestId('more-sheet')
        await loadPhoto()
        const sheet = (): ReturnType<typeof within> => within(screen.getByTestId('more-sheet'))
        const image = sheet().getByTestId('frozen-photo-image')
        const captureId = mounted.controller.getSnapshot().capture!.binding.captureId
        expect(mounted.controller.getSnapshot().check).toBeNull()
        await fireEvent(sheet().getByTestId('frozen-photo-frame'), 'accessibilityTap')
        await fireEvent.changeText(sheet().getByLabelText('Your question'), 'Does this stay upright at this point?')
        expect(mounted.controller.getSnapshot().target).toEqual({ kind: 'point', x: 0.5, y: 0.5 })
        expect(sheet().getByRole('button', { name: 'Ask' })).toBeEnabled()

        const commits: Commit[] = []
        const publications: { pending: string | null; answer: boolean }[] = []
        const stop = mounted.controller.subscribe((): void => {
            const state = mounted.controller.getSnapshot()
            publications.push({ pending: state.pending, answer: state.answer !== null })
        })
        mockObserveCommit = (): void => {
            commits.push(commit(mounted))
        }
        try {
            await fireEvent.press(sheet().getByRole('button', { name: 'Ask' }))
            await waitFor(() => expect(mounted.controller.getSnapshot().pending).toMatch(/^Still thinking/u))
            await flush()
            expect(sheet().getByTestId('frozen-photo-image') === image).toBe(true)
            expect(StyleSheet.flatten(image.props.style).width).toBeGreaterThan(0)
            // Resolve real HTTP without a wrapping act that deliberately batches the controller's two publications.
            // waitFor/Profiler still observes real commits; no workflow snapshots or controller methods are replaced.
            answer.resolve()
            await waitFor(() =>
                expect(mounted.controller.getSnapshot().answer?.answer).toBe('The groove faces inward.'),
            )
            await flush()
            expect(mounted.controller.getSnapshot().pending).toBeNull()
            expect(sheet().getByTestId('frozen-photo-image') === image).toBe(true)
            expect(StyleSheet.flatten(image.props.style).width).toBeGreaterThan(0)
            expect(screen.queryByRole('button', { name: 'Ask', includeHiddenElements: true })).toBeNull()
            const beforeLoad = commits.slice()
            expect(beforeLoad.length).toBeGreaterThan(0)
            expect(beforeLoad.filter((row) => !row.sheet || !row.visibleModal || (row.sheetPhoto ?? 0) <= 0)).toEqual(
                [],
            )
            expect(beforeLoad.some((row) => row.answer && row.outerPhoto === 0)).toBe(true)
            // The focused Guide still belongs to the visible-screen union beneath its sheet. Its known question
            // activities need generated documents too; the Question's generated origin cannot credit that Guide.
            expect(beforeLoad.filter((row) => row.outerOrigin !== 'generated')).toEqual([])
            expect(beforeLoad.filter((row) => row.answerText)).toEqual([])

            const page = within(screen.getByTestId('guide-screen', { includeHiddenElements: true }))
            await fireEvent(page.getByTestId('frozen-photo-frame', { includeHiddenElements: true }), 'layout', {
                nativeEvent: { layout: { width: 390, height: 460, x: 0, y: 0 } },
            })
            expect(screen.getByTestId('more-sheet')).toBeTruthy()
            await fireEvent(page.getByTestId('frozen-photo-image', { includeHiddenElements: true }), 'load')
            await waitFor(() => expect(screen.queryByTestId('more-sheet')).toBeNull())
            expect(screen.getByText('The groove faces inward.')).toBeTruthy()
            expect(mounted.calls.filter((path) => path === '/api/questions')).toHaveLength(1)
            expect(mounted.calls.filter((path) => path === '/api/questions/result')).toHaveLength(1)
            expect(mounted.calls.filter((path) => path === '/api/checks')).toHaveLength(0)
            expect(mounted.controller.getSnapshot().capture!.binding.captureId).toBe(captureId)
            expect(mounted.controller.getSnapshot().question).toBe('Does this stay upright at this point?')
            const handedOff = commits.findIndex((row) => !row.sheet)
            expect(handedOff).toBeGreaterThanOrEqual(0)
            // An optional exact composition of the same capture cannot hide an answer which has already become the
            // visible page. This observes complete real committed trees, not calls to the photo-ready callback.
            const concealed = commits.slice(handedOff).filter((row) => !row.answerText || (row.outerPhoto ?? 0) <= 0)
            if (concealed.length > 0)
                console.info('fresh-question-commit-probe', JSON.stringify({ publications, commits }))
            expect(concealed).toEqual([])
        } finally {
            stop()
            mockObserveCommit = (): void => {}
        }
    } finally {
        answer.resolve()
        await mounted.view.unmount()
        mounted.controller.dispose()
        mounted.store.dispose()
    }
})
