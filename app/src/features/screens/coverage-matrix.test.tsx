/// <reference types="node" />

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type * as ReactModule from 'react'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { createController, createScreens } from '../capture/controller-factory'
import {
    measureRenderOriginTree,
    summarizeRenderOriginSession,
    type RenderOriginMeasurement,
    type RenderOriginCheckpoint,
} from '../../ui/test-support/render-origin-coverage'
import type { ScreenKind } from '@truebuild/contracts'
import { flush, mount, press, type Mounted } from './test-support/flow'
import { deferred, entry, source, type Replies } from './test-support/route-harness'
import type { FixtureServerOptions } from './test-support/fixture-server'
import { judgeStorage } from './judge-storage'
import { JUDGE_STORAGE_KEY } from './judge-store'

// A fixed matrix of checkpoints through the production routes, controller and screen store, with synthetic documents.
// It counts the host elements of the react-test-renderer tree at each checkpoint, per origin. It is not a measurement
// of any model, of a device, of the native header or of OS chrome, and it claims no percentage.
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
jest.mock('../capture/controller-factory', () => ({ createController: jest.fn(), createScreens: jest.fn() }))
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

const { testRouter } = jest.requireActual<{ testRouter: { push: (path: string) => Promise<void> } }>(
    'expo-router/testing-library',
)

beforeAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
})
afterEach(async () => {
    await cleanup()
    jest.restoreAllMocks()
    jest.mocked(createController).mockReset()
    jest.mocked(createScreens).mockReset()
    await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: false }))
})

const ALL_KINDS: readonly ScreenKind[] = [
    'home',
    'add',
    'pages',
    'reading',
    'quick-check',
    'guide',
    'result',
    'questions',
    'answer',
    'more',
    'completion',
    'error',
    'recovery',
]

type Mode = 'generated' | 'fallback' | 'off'
const MODES: readonly { readonly mode: Mode; readonly sessionId: string }[] = [
    { mode: 'generated', sessionId: 'synthetic-session-generated' },
    { mode: 'fallback', sessionId: 'synthetic-session-fallback' },
    { mode: 'off', sessionId: 'synthetic-session-off' },
]

type Context = { mode: Mode; mounted: Mounted | null }
type Checkpoint = {
    readonly screen: string
    readonly id: string
    /** Brings the real app to the state, then returns once the screen is settled. */
    readonly run: (context: Context) => Promise<Mounted>
}

const options = (mode: Mode, extra: FixtureServerOptions = {}): { screens: FixtureServerOptions | 'off' } => ({
    screens: mode === 'off' ? 'off' : { ...(mode === 'generated' ? { generated: ALL_KINDS } : {}), ...extra },
})
const settle = async (): Promise<void> => {
    await flush()
}
const startBuilding = async (mode: Mode): Promise<void> => {
    await press(mode === 'off' ? 'Keep building' : 'Continue building')
}
const atGuide = async (
    mode: Mode,
    entries = [entry()],
    extra: FixtureServerOptions = {},
    replies?: Replies,
): Promise<Mounted> => {
    const mounted = await mount(entries, { ...options(mode, extra), ...(replies === undefined ? {} : { replies }) })
    await startBuilding(mode)
    await waitFor(() => expect(mounted.view.getPathname()).toBe('/guide/flow-manual'))
    await screen.findByText(/Step 1: /u)
    await settle()
    return mounted
}
const check = async (mounted: Mounted): Promise<void> => {
    await press('Take photo')
    await act(async () => mounted.controller.shutter(async () => source))
    await settle()
}
const measureLayout = async (): Promise<void> => {
    const frames = screen.queryAllByTestId('frozen-photo-frame', { hidden: true })
    for (const frame of frames) {
        await fireEvent(frame, 'layout', { nativeEvent: { layout: { width: 390, height: 460, x: 0, y: 0 } } })
    }
}

const done = entry('flow-manual', 'reviewed', 2)
done.completedStepIds = ['step-1', 'step-2']
done.stepIndex = 1

const checkpoints: readonly Checkpoint[] = [
    {
        screen: 'home',
        id: 'empty',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await mount([], options(mode))
            await settle()
            return mounted
        },
    },
    {
        screen: 'home',
        id: 'resume',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await mount([entry()], options(mode))
            await settle()
            return mounted
        },
    },
    {
        screen: 'add',
        id: 'empty',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await mount([], options(mode))
            await press(mode === 'off' ? 'Add manual' : 'Add a manual')
            await waitFor(() => expect(mounted.view.getPathname()).toBe('/add'))
            await settle()
            return mounted
        },
    },
    {
        screen: 'pages',
        id: 'one-page',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await mount([], options(mode))
            await press(mode === 'off' ? 'Add manual' : 'Add a manual')
            await waitFor(() => expect(mounted.view.getPathname()).toBe('/add'))
            await act(async () => mounted.controller.importPages(async () => [source]))
            await settle()
            return mounted
        },
    },
    {
        screen: 'reading',
        id: 'in-progress',
        run: async ({ mode }): Promise<Mounted> => {
            const gate = deferred<void>()
            const mounted = await mount([], { ...options(mode), replies: { parse: gate.promise } })
            await press(mode === 'off' ? 'Add manual' : 'Add a manual')
            await waitFor(() => expect(mounted.view.getPathname()).toBe('/add'))
            await act(async () => mounted.controller.importPages(async () => [source]))
            await press('Read my manual')
            await waitFor(() => expect(mounted.view.getPathname()).toMatch(/^\/reading\//u))
            await settle()
            return mounted
        },
    },
    {
        screen: 'quick-check',
        id: 'after-reading',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await mount([], options(mode))
            await press(mode === 'off' ? 'Add manual' : 'Add a manual')
            await waitFor(() => expect(mounted.view.getPathname()).toBe('/add'))
            await act(async () => mounted.controller.importPages(async () => [source]))
            await press('Read my manual')
            await waitFor(() => expect(mounted.view.getPathname()).toMatch(/^\/check\//u))
            await settle()
            return mounted
        },
    },
    { screen: 'guide', id: 'step', run: async ({ mode }) => atGuide(mode) },
    {
        screen: 'guide',
        id: 'native-when-not-composed',
        run: async ({ mode }) => atGuide(mode, [entry()], mode === 'off' ? {} : { failing: ['guide'] }),
    },
    {
        screen: 'result',
        id: 'pass',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await atGuide(mode)
            await check(mounted)
            return mounted
        },
    },
    {
        screen: 'result',
        id: 'refuse-with-mask',
        run: async ({ mode }): Promise<Mounted> => {
            const offers = {
                overlay: { status: 'available' as const, model: 'muse-wonder-1.0' as const, token: 'one-use' },
                segments: { status: 'available' as const, model: 'sam-3.1' as const, prompts: ['side panel'] },
            }
            const mounted = await atGuide(
                mode,
                [entry()],
                {},
                {
                    check: { decision: 'refuse', reason: 'Panel faces outward.' },
                    ...(mode === 'off' ? {} : { followUps: offers }),
                    locate: async function* (request) {
                        const binding = request.binding
                        yield {
                            status: 'ok',
                            requestId: request.requestId,
                            mode: 'model',
                            binding,
                            value: {
                                type: 'snapshot',
                                snapshot: {
                                    binding,
                                    streamId: 'stream-1',
                                    frameIndex: 0,
                                    capturedAt: '2026-01-01T00:00:00.000Z',
                                    complete: true,
                                    records: [
                                        {
                                            objectId: 'o1',
                                            label: 'side panel',
                                            box: { x: 0.1, y: 0.1, width: 0.4, height: 0.5 },
                                            mask: { width: 4, height: 4, path: 'M0 0H4V4H0Z' },
                                        },
                                    ],
                                },
                            },
                        }
                        yield {
                            status: 'ok',
                            requestId: request.requestId,
                            mode: 'model',
                            binding,
                            value: { type: 'completed' },
                        }
                    },
                },
            )
            await check(mounted)
            await measureLayout()
            await settle()
            return mounted
        },
    },
    {
        screen: 'result',
        id: 'cannot-verify',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await atGuide(
                mode,
                [entry()],
                {},
                {
                    check: { decision: 'cannot_verify', reason: 'The groove is hidden.', missingEvidence: ['Groove'] },
                },
            )
            await check(mounted)
            return mounted
        },
    },
    {
        screen: 'answer',
        id: 'question',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await atGuide(mode)
            await check(mounted)
            await act(async () => {
                mounted.controller.targetChanged({ kind: 'part', partId: 'side-panel' })
                mounted.controller.questionChanged('Which way?')
            })
            await act(async () => mounted.controller.ask())
            await settle()
            return mounted
        },
    },
    {
        screen: 'more',
        id: 'sheet-open',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await atGuide(mode)
            await press('More')
            await settle()
            return mounted
        },
    },
    {
        screen: 'error',
        id: 'check-unreachable',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await atGuide(mode, [entry()], {}, { failCheck: true })
            await check(mounted)
            return mounted
        },
    },
    {
        screen: 'completion',
        id: 'all-steps-done',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await mount([done], options(mode))
            await press(mode === 'off' ? 'See finished build' : 'Continue building')
            await waitFor(() => expect(mounted.view.getPathname()).toBe('/done/flow-manual'))
            await settle()
            return mounted
        },
    },
    {
        screen: 'compare',
        id: 'two-manuals',
        run: async ({ mode }): Promise<Mounted> => {
            await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: true }))
            const mounted = await mount(
                [entry('manual-a', 'reviewed', 2, 'Alpha'), entry('manual-b', 'reviewed', 3, 'Beta')],
                options(mode),
            )
            await testRouter.push('/compare')
            await waitFor(() => expect(mounted.view.getPathname()).toBe('/compare'))
            await fireEvent.press(screen.getByTestId('compare-choose-manual-a'))
            await fireEvent.press(screen.getByTestId('compare-choose-manual-b'))
            await settle()
            return mounted
        },
    },
]

describe('render-origin diagnostic matrix (synthetic documents, remounted route checkpoints)', () => {
    const results = new Map<Mode, RenderOriginMeasurement[]>()
    const failures: string[] = []

    it.each(MODES.flatMap(({ mode, sessionId }) => checkpoints.map((point) => ({ mode, sessionId, point }))))(
        '$sessionId · $point.screen/$point.id',
        async ({ mode, sessionId, point }) => {
            const context: Context = { mode, mounted: null }
            const mounted = await point.run(context)
            const identity: RenderOriginCheckpoint = {
                sessionId,
                screen: point.screen,
                checkpointId: point.id,
                platform: 'ios',
                evidence: 'synthetic-fixture',
            }
            const measured = measureRenderOriginTree(mounted.view.toJSON(), identity)
            expect(measured.status).toBe('measured')
            expect(measured.counts.total).toBeGreaterThan(0)
            results.set(mode, [...(results.get(mode) ?? []), measured])
            if (mode === 'off') {
                // Off is the original app: not one host element is claimed as composed.
                expect(measured.counts.generated + measured.counts.fallback).toBe(0)
            }
            if (mode === 'fallback') expect(measured.counts.generated).toBe(0)
            failures.length = 0
        },
    )

    afterAll(() => {
        const sessions = MODES.map(({ mode, sessionId }) => {
            const samples = results.get(mode) ?? []
            const summary = summarizeRenderOriginSession(samples)
            return {
                sessionId,
                mode,
                note:
                    mode === 'generated'
                        ? 'Documents carry test-input metadata that claims a model; nothing here is output of any model.'
                        : mode === 'fallback'
                          ? 'Documents are deterministic fallbacks marked fixture, as the fixture runtime composes them.'
                          : 'GENERATIVE_UI off: the original screens, no screens request.',
                summary: {
                    status: summary.status,
                    counts: summary.counts,
                    generatedShare: summary.generatedShare,
                    rawTextCounts: summary.rawTextCounts,
                    byHostType: summary.byHostType,
                    minimumScreenGeneratedShare: summary.minimumScreenGeneratedShare,
                    screens: summary.screens,
                },
                checkpoints: samples.map((sample) => ({
                    screen: sample.checkpoint.screen,
                    checkpointId: sample.checkpoint.checkpointId,
                    counts: sample.counts,
                    generatedShare: sample.generatedShare,
                })),
            }
        })
        const directory = resolve(__dirname, '../../../../.local/ai-effort')
        mkdirSync(directory, { recursive: true })
        writeFileSync(
            resolve(directory, 'coverage.json'),
            `${JSON.stringify(
                {
                    generatedAt: new Date().toISOString(),
                    evidence: 'synthetic-fixture',
                    measured:
                        'react-test-renderer (RNTL 14) host elements of the production route tree, per origin marker',
                    notMeasured: [
                        'any model output or live provider',
                        'physical Fabric/UIKit/Android views',
                        'the native Stack header and OS chrome (outside the JS host tree)',
                        'a percentage target: none is claimed here',
                    ],
                    screenKinds: ALL_KINDS,
                    fixedMatrix: checkpoints.map((point) => `${point.screen}/${point.id}`),
                    sessions,
                },
                null,
                2,
            )}\n`,
        )
    })
})
