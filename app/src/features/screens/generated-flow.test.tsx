/// <reference types="node" />

import type * as ReactModule from 'react'
import type * as ReactNative from 'react-native'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { createController, createScreens } from '../capture/controller-factory'
import type { ScreenDocument } from '@truebuild/contracts'
import type { CaptureController } from '../capture/controller'
import { flush, mount, press, type Mounted } from './test-support/flow'
import { deferred, entry, source, type Replies } from './test-support/route-harness'
import type { FixtureServer, FixtureServerOptions } from './test-support/fixture-server'
import { PENDING_COPY } from './host'
import { judgeStorage } from './judge-storage'
import { JUDGE_STORAGE_KEY } from './judge-store'
import type { LibraryEntry } from '../capture/library'

// The production root layout, routes, screens, controller and screen store run unchanged. Only the device/transport
// boundary is injected: the model transport, storage and image normalization, and the /api/screens server.
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
// Device key-value IO only: the real JudgeProvider/store still restores, gates and persists the preference.
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

const { testRouter } = jest.requireActual<{
    testRouter: { push: (path: string) => Promise<void>; back: (path?: string) => Promise<void> }
}>('expo-router/testing-library')

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
    jest.restoreAllMocks()
    jest.mocked(createController).mockReset()
    jest.mocked(createScreens).mockReset()
    jest.useRealTimers()
    await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: false }))
})

const generateCalls = (server: FixtureServer): string[] =>
    server.requests.flatMap((request) => (request.op === 'generate' ? [request.kind] : []))

describe('generated screens off keeps the original app', () => {
    it('makes no screens request and shows the native Home and Guide copy exactly', async () => {
        const { server, view, controller } = await mount([entry()], { screens: 'off' })
        expect(screen.getByRole('button', { name: 'Keep building' })).toBeTruthy()
        expect(screen.queryByTestId('screen-pending')).toBeNull()
        expect(screen.queryByTestId('generated-body')).toBeNull()
        await press('Keep building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        await waitFor(() => expect(controller.current?.session.manualId).toBe('flow-manual'))
        expect(screen.getByTestId('guide-primary')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Take photo' })).toBeTruthy()
        expect(server.requests).toEqual([])
    })
})

describe('Home composed by the document', () => {
    it('shows the calm skeleton while composing, then the document, keeping the stable test identity of the action', async () => {
        const gate = deferred<void>()
        const { server } = await mount([], { screens: { gate: gate.promise } })
        expect(await screen.findByTestId('screen-pending')).toBeTruthy()
        expect(screen.getByText(PENDING_COPY)).toBeTruthy()
        expect(PENDING_COPY).toBe('Getting the next steps ready…')
        await act(async () => gate.resolve())
        expect(await screen.findByText('Turn your paper manual into steps.')).toBeTruthy()
        expect(screen.queryByTestId('screen-pending')).toBeNull()
        const add = screen.getByTestId('home-add')
        expect(add).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Add a manual' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Add manual' })).toBeNull()
        expect(generateCalls(server)).toContain('home')
    })

    it('runs the document action only through the controller and lands on the real Add route', async () => {
        const { view, controller } = await mount([])
        await press('Add a manual')
        await waitFor(() => expect(view.getPathname()).toBe('/add'))
        expect(controller.current?.session.pages).toHaveLength(0)
        expect(await screen.findByText('Take a photo of each manual page.')).toBeTruthy()
        expect(screen.getByTestId('take-page-photo')).toBeTruthy()
    })

    it('keeps the native Home when the document cannot be composed', async () => {
        await mount([], { screens: { failing: ['home'] } })
        expect(await screen.findByRole('button', { name: 'Add manual' })).toBeTruthy()
        expect(screen.getByText('Build furniture with step-by-step help.')).toBeTruthy()
        expect(screen.queryByTestId('generated-body')).toBeNull()
    })

    it('keeps the native Home usable after the grace period and does not swap a late document under the person', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        const gate = deferred<void>()
        const { store } = await mount([], { screens: { gate: gate.promise } })
        expect(screen.getByTestId('screen-pending')).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(8_001))
        expect(screen.queryByTestId('screen-pending')).toBeNull()
        expect(screen.getByRole('button', { name: 'Add manual' })).toBeTruthy()
        await act(async () => gate.resolve())
        expect(screen.queryByText('Turn your paper manual into steps.')).toBeNull()
        expect(screen.getByRole('button', { name: 'Add manual' })).toBeTruthy()
        expect(store?.shownCounts()).toEqual({ generated: 0, fallback: 0, shell: 0 })
    })
})

describe('Guide composed by the document', () => {
    it('precomputes every step once after the manual is confirmed, then opens each step without a new request', async () => {
        const { server, view, controller } = await mount([entry('flow-manual', 'reviewed', 3)])
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        expect(await screen.findByText(/Step 1: /u)).toBeTruthy()
        await waitFor(() => expect(server.requests.some((request) => request.op === 'progress')).toBe(true))
        const precomputes = server.requests.filter((request) => request.op === 'precompute')
        expect(precomputes).toHaveLength(1)
        await act(async () => controller.step(1))
        expect(await screen.findByText(/Step 2: /u)).toBeTruthy()
        await act(async () => controller.step(2))
        expect(await screen.findByText(/Step 3: /u)).toBeTruthy()
        // Steps 2 and 3 came from the background job, not from one request per step.
        expect(generateCalls(server).filter((kind) => kind === 'guide').length).toBeLessThanOrEqual(1)
    })

    it('uses the document bar for the action and keeps the guide-primary identity', async () => {
        const { view, controller } = await mount([entry()])
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        await screen.findByText(/Step 1: /u)
        expect(screen.getByTestId('guide-primary')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Ask about this step' })).toBeTruthy()
        await press('Take photo')
        await waitFor(() => expect(controller.getSnapshot().route).toBe('camera'))
    })
})

describe('Result composed after an immediate verdict', () => {
    async function atGuide(options: Parameters<typeof mount>[1] = {}): Promise<Mounted> {
        const mounted = await mount([entry()], options)
        await press('Continue building')
        await waitFor(() => expect(mounted.view.getPathname()).toBe('/guide/flow-manual'))
        await screen.findByText(/Step 1: /u)
        return mounted
    }
    const photo = async (controller: CaptureController): Promise<void> => {
        await press('Take photo')
        await act(async () => controller.shutter(async () => source))
    }

    it('shows the verdict at once, then the composed result screen; the held verdict is never changed', async () => {
        const gate = deferred<void>()
        let hold = false
        const { controller, server } = await atGuide({
            screens: {
                get gate() {
                    return hold ? gate.promise : undefined
                },
            },
            replies: { check: { reason: 'The groove faces inward.' } },
        })
        hold = true
        await photo(controller)
        expect(controller.getSnapshot().check?.decision).toBe('pass')
        expect(await screen.findByText('Looks right. The groove faces inward.')).toBeTruthy()
        expect(screen.getByTestId('result-icon', { hidden: true })).toBeTruthy()
        await act(async () => gate.resolve())
        expect(await screen.findByText('Looks right')).toBeTruthy()
        expect(screen.queryByTestId('result-icon', { hidden: true })).toBeNull()
        expect(controller.getSnapshot().check?.decision).toBe('pass')
        expect(generateCalls(server)).toContain('result')
        const resultRequest = server.requests.find((request) => request.op === 'generate' && request.kind === 'result')
        expect(JSON.stringify(resultRequest)).not.toContain('secondOpinionToken')
    })

    it('marks a passed step done only through the document button and only for a held pass', async () => {
        const { controller } = await atGuide()
        await photo(controller)
        await press('Next step')
        await waitFor(() => expect(controller.current?.completedStepIds).toEqual(['step-1']))
    })

    it('refuses a result document whose banner names another verdict and keeps the native result', async () => {
        const { controller } = await atGuide({
            screens: {
                transform: (document) =>
                    document.kind === 'result'
                        ? {
                              ...document,
                              body: document.body.map((node) =>
                                  node.type === 'ResultBanner' ? { ...node, verdict: 'refuse' as const } : node,
                              ),
                          }
                        : document,
            },
        })
        await photo(controller)
        await waitFor(() => expect(screen.getByTestId('result-icon', { hidden: true })).toBeTruthy())
        await flush()
        expect(screen.queryByText('Not yet')).toBeNull()
        expect(screen.getByTestId('result-icon', { hidden: true })).toBeTruthy()
        expect(controller.getSnapshot().check?.decision).toBe('pass')
    })

    it('keeps the native result when the composed one cannot be made', async () => {
        const { controller } = await atGuide({ screens: { failing: ['result'] } })
        await photo(controller)
        await waitFor(() => expect(screen.getByTestId('result-icon', { hidden: true })).toBeTruthy())
        await flush()
        expect(screen.getByTestId('result-icon', { hidden: true })).toBeTruthy()
        expect(screen.queryByText('Looks right')).toBeNull()
    })
})

describe('J1: show how Meta AI built this', () => {
    async function atGuideWithJudge(options: Parameters<typeof mount>[1] = {}): Promise<Mounted> {
        const mounted = await mount([entry()], { screens: { generated: ['guide'] }, ...options })
        await press('Continue building')
        await waitFor(() => expect(mounted.view.getPathname()).toBe('/guide/flow-manual'))
        await screen.findByText(/Step 1: /u)
        return mounted
    }
    const openJudge = async (): Promise<void> => {
        await press('More')
        await fireEvent.press(await screen.findByTestId('judge-entry'))
        await screen.findByTestId('judge-details')
    }

    it('is off by default: no judge words and no attribution on a normal screen, only a toggle behind About this check', async () => {
        await atGuideWithJudge()
        expect(screen.queryByTestId('attribution-card')).toBeNull()
        expect(screen.queryByTestId('judge-compare')).toBeNull()
        expect(screen.queryByText('Same photo, in the order it arrived')).toBeNull()
        expect(screen.queryByText(/muse|wonder|spark|meta ai|effort|tokens/iu)).toBeNull()
        await openJudge()
        const toggle = screen.getByRole('switch', { name: 'Show how Meta AI built this' })
        expect(toggle.props.accessibilityState).toMatchObject({ checked: false })
        expect(screen.queryByTestId('attribution-card')).toBeNull()
    })

    // Home stays mounted under the Guide and the More sheet has its own intro, so the layer is read in the Guide's own panel.
    const guide = (): ReturnType<typeof within> => within(screen.getByTestId('guide-panel', { hidden: true }))
    const toggle = (): ReturnType<typeof screen.getByRole> =>
        screen.getByRole('switch', { name: 'Show how Meta AI built this' })

    it('turns the current screen attribution on and off, showing only what the document recorded and Not recorded for the rest', async () => {
        await atGuideWithJudge()
        await openJudge()
        await fireEvent.press(toggle())
        expect(await guide().findByTestId('attribution-card', { hidden: true })).toBeTruthy()
        expect(guide().getByText('Source: Composed by the model', { hidden: true })).toBeTruthy()
        expect(guide().getByText('Evidence: Live model run', { hidden: true })).toBeTruthy()
        expect(guide().getByText('Model: muse-wonder-1.0', { hidden: true })).toBeTruthy()
        expect(guide().getByText('Effort: max', { hidden: true })).toBeTruthy()
        expect(guide().getByText('Time: total 3420 ms, model 3400 ms, checking 5 ms', { hidden: true })).toBeTruthy()
        expect(guide().getByText('Tokens: in 1200, cached 0, out 900, reasoning 700', { hidden: true })).toBeTruthy()
        // The test renderer has no public native view tree, so the honest count is "Not recorded" with its reason, never a number.
        expect(
            guide().getByText(/^On-screen elements, all open screens: Not recorded \(.+\)$/u, { hidden: true }),
        ).toBeTruthy()
        expect(guide().getByText(/^Whole session: Not recorded \(.+\)$/u, { hidden: true })).toBeTruthy()
        expect(guide().queryByText(/\d+ elements/u, { hidden: true })).toBeNull()
        expect(
            guide().getByText(/Screens this session: \d+ generated, \d+ app-built, \d+ native/u, { hidden: true }),
        ).toBeTruthy()
        await fireEvent.press(toggle())
        await waitFor(() => expect(guide().queryByTestId('attribution-card', { hidden: true })).toBeNull())
    })

    it.each([false, true])('says Not recorded for a synthetic document (generated source: %s)', async (generated) => {
        await atGuideWithJudge({
            screens: generated
                ? {
                      generated: ['guide'],
                      transform: (document): ScreenDocument => ({
                          ...document,
                          metadata: {
                              ...document.metadata,
                              evidence: 'synthetic-fixture',
                              model: null,
                              effort: null,
                              timing: {
                                  timeToProviderMs: null,
                                  providerMs: null,
                                  parseValidateMs: null,
                                  totalMs: null,
                              },
                              usage: {
                                  inputTokens: null,
                                  cachedTokens: null,
                                  outputTokens: null,
                                  reasoningTokens: null,
                              },
                          },
                      }),
                  }
                : {},
        })
        await openJudge()
        await fireEvent.press(toggle())
        await guide().findByTestId('attribution-card', { hidden: true })
        expect(
            guide().getByText(
                generated
                    ? 'Source: Simulated composition (generated source)'
                    : 'Source: Built by the app from the manual (fixture)',
                { hidden: true },
            ),
        ).toBeTruthy()
        expect(guide().getByText('Evidence: Simulated (fixture, no model call)', { hidden: true })).toBeTruthy()
        expect(guide().getByText('Model: Not recorded', { hidden: true })).toBeTruthy()
        expect(guide().getByText('Effort: Not recorded', { hidden: true })).toBeTruthy()
        expect(
            guide().getByText('Time: total Not recorded, model Not recorded, checking Not recorded', { hidden: true }),
        ).toBeTruthy()
        expect(
            guide().getByText(
                'Tokens: in Not recorded, cached Not recorded, out Not recorded, reasoning Not recorded',
                {
                    hidden: true,
                },
            ),
        ).toBeTruthy()
    })

    it('names a block and where it came from when it is tapped, while the layer is on', async () => {
        await atGuideWithJudge()
        await openJudge()
        await fireEvent.press(toggle())
        await guide().findByTestId('attribution-card', { hidden: true })
        await fireEvent.press(
            guide().getAllByLabelText(/Instruction\. Show how this part was built/u, { hidden: true })[0]!,
        )
        expect(await guide().findByText('Instruction · generated by the model', { hidden: true })).toBeTruthy()
    })
})

describe('J2: compare two manuals', () => {
    beforeEach(async () => {
        await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: true }))
    })
    it('closes the source sheet before opening the comparison from the original judge entry', async () => {
        const { view } = await mount([entry('manual-a'), entry('manual-b')])
        await testRouter.push('/guide/manual-a')
        await press('More')
        await fireEvent.press(await screen.findByTestId('judge-entry'))
        await fireEvent.press(await screen.findByTestId('judge-compare'))
        await waitFor(() => expect(view.getPathname()).toBe('/compare'))
        await waitFor(() => expect(screen.queryByTestId('more-sheet')).toBeNull())
    })
    const entries = (): LibraryEntry[] => [
        entry('manual-a', 'reviewed', 2, 'Alpha'),
        entry('manual-b', 'reviewed', 3, 'Beta'),
        entry('manual-c', 'unreviewed', 2, 'Gamma'),
    ]
    const different = {
        generated: ['guide'] as const,
        // The second manual gets a different composition from the same renderer: another block and another button.
        transform: (document: ScreenDocument): ScreenDocument =>
            document.bound.manualId === 'manual-b'
                ? {
                      ...document,
                      body: [
                          ...document.body,
                          {
                              type: 'Warning' as const,
                              text: 'Two people should lift this.',
                              tone: 'critical' as const,
                              citations: [],
                          },
                      ],
                      bar: { ...document.bar, primary: { ...document.bar.primary, label: 'Snap a photo' } },
                  }
                : document,
    }

    it('keeps a direct link closed while the device judge toggle is off', async () => {
        await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: false }))
        await mount(entries(), { screens: different })
        await testRouter.push('/compare')
        expect(await screen.findByText('Turn on the judge view in More to compare manuals.')).toBeTruthy()
        expect(screen.queryByTestId('compare-screen')).toBeNull()
    })

    it('is reachable from About this check and lists real library manuals, finished ones only', async () => {
        const { view } = await mount(entries(), { screens: different })
        await testRouter.push('/compare')
        await waitFor(() => expect(view.getPathname()).toBe('/compare'))
        expect(screen.getByTestId('compare-choose-manual-a')).toBeTruthy()
        expect(screen.getByTestId('compare-choose-manual-b')).toBeTruthy()
        const draft = screen.getByTestId('compare-choose-manual-c')
        expect(draft.props.accessibilityState).toMatchObject({ disabled: true })
        expect(screen.queryByTestId('compare-pane-manual-a')).toBeNull()
    })

    it('draws any two manuals with the same renderer and different compositions, without changing either', async () => {
        const { view, controller, server } = await mount(entries(), { screens: different })
        await testRouter.push('/compare')
        await waitFor(() => expect(view.getPathname()).toBe('/compare'))
        await fireEvent.press(screen.getByTestId('compare-choose-manual-a'))
        await fireEvent.press(screen.getByTestId('compare-choose-manual-b'))
        const a = await screen.findByTestId('compare-pane-manual-a')
        const b = await screen.findByTestId('compare-pane-manual-b')
        expect(a).toBeTruthy()
        expect(b).toBeTruthy()
        expect(await screen.findByText('Alpha 1: Stand the side panel upright')).toBeTruthy()
        expect(await screen.findByText('Beta 1: Stand the side panel upright')).toBeTruthy()
        expect(screen.getAllByText('Two people should lift this.')).toHaveLength(1)
        expect(screen.getByText(/Main button: Take photo/u)).toBeTruthy()
        expect(screen.getByText(/Main button: Snap a photo/u)).toBeTruthy()
        expect(screen.getAllByText(/Composed by muse-wonder-1.0 at max effort/u)).toHaveLength(2)
        const composed = server.requests.flatMap((request) =>
            request.op === 'generate' ? [request.session?.manualId] : [],
        )
        expect(composed).toEqual(expect.arrayContaining(['manual-a', 'manual-b']))
        expect(controller.getSnapshot().entries.map((item) => item.session.revision)).toEqual([1, 1, 1])
    })

    it.each([
        ['a narrow phone stacks the panes', 320, 'column'],
        ['a wide screen puts them side by side', 900, 'row'],
    ] as const)('%s', async (_name, width, direction) => {
        const dimensions = jest.requireActual<typeof ReactNative>('react-native')
        jest.spyOn(dimensions, 'useWindowDimensions').mockReturnValue({ width, height: 700, scale: 2, fontScale: 1 })
        const { view } = await mount(entries(), { screens: different })
        await testRouter.push('/compare')
        await waitFor(() => expect(view.getPathname()).toBe('/compare'))
        await fireEvent.press(screen.getByTestId('compare-choose-manual-a'))
        await fireEvent.press(screen.getByTestId('compare-choose-manual-b'))
        await screen.findByTestId('compare-pane-manual-b')
        expect(screen.getByTestId('compare-panes').props.style).toEqual(
            expect.arrayContaining([expect.objectContaining({ flexDirection: direction })]),
        )
        expect(screen.getByTestId('compare-screen')).toBeTruthy()
    })
})

describe('J3: the same photo, in the order each part arrived', () => {
    beforeEach(async () => {
        await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: true }))
    })
    const offers = {
        overlay: { status: 'available' as const, model: 'muse-wonder-1.0' as const, token: 'one-use' },
        segments: { status: 'available' as const, model: 'sam-3.1' as const, prompts: ['side panel'] },
    }
    const locate: Replies['locate'] = async function* (request) {
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
                    stage: { model: 'sam-3.1', elapsedMs: 412 },
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
        yield { status: 'ok', requestId: request.requestId, mode: 'model', binding, value: { type: 'completed' } }
    }

    async function atResult(replies: Replies, screens: FixtureServerOptions): Promise<Mounted> {
        const mounted = await mount([entry()], { screens, replies })
        await press('Continue building')
        await waitFor(() => expect(mounted.view.getPathname()).toBe('/guide/flow-manual'))
        await screen.findByText(/Step 1: /u)
        await press('Take photo')
        await act(async () => mounted.controller.shutter(async () => source))
        return mounted
    }
    const openJudge = async (): Promise<void> => {
        await press('More')
        await fireEvent.press(await screen.findByTestId('judge-entry'))
        await screen.findByTestId('judge-details')
    }
    // The frozen photo draws its overlays once it has a measured width, as on a device.
    const measurePhoto = async (): Promise<void> => {
        await fireEvent(screen.getByTestId('frozen-photo-frame', { hidden: true }), 'layout', {
            nativeEvent: { layout: { width: 390, height: 460, x: 0, y: 0 } },
        })
    }

    it('shows verdict, composed result screen and precise mask, each with what actually happened', async () => {
        const { controller } = await atResult(
            { check: { model: 'muse-spark-1.3' }, followUps: offers, locate },
            { generated: ['result'] },
        )
        await waitFor(() => expect(controller.getSnapshot().stages?.segments.status).toBe('landed'))
        await measurePhoto()
        expect(await screen.findByTestId('segment-mask', { hidden: true })).toBeTruthy()
        await openJudge()
        const details = within(screen.getByTestId('judge-details', { hidden: true }))
        expect(details.getByText(/1\. Verdict: muse-spark-1\.3, \d+ ms \(measured on this phone\)/u)).toBeTruthy()
        // The three later stages are numbered by when they really arrived, so each is found by its own words.
        expect(
            details.getByText(
                /^\d\. Result screen: Landed \(model-composed\), server total 3420 ms, model muse-wonder-1\.0, effort max$/u,
            ),
        ).toBeTruthy()
        expect(
            details.getByText(
                /^\d\. Precise mask: Landed after \d+ ms \(measured on this phone\), server 412 ms, 1 outlined, model sam-3\.1$/u,
            ),
        ).toBeTruthy()
        // The same held photo, with the mask drawn from that photo's own stage.
        expect(details.getByTestId('stages-photo', { hidden: true })).toBeTruthy()
        const ranks = [/Verdict:/u, /Result screen:/u, /Precise mask:/u, /Extra regions:/u].map((label) =>
            Number(/^(\d)\./u.exec(details.getByText(label).props.children as string)![1]),
        )
        expect([...ranks].sort()).toEqual([1, 2, 3, 4])
        expect(ranks[0]).toBe(1)
        expect(details.getByText(/Extra regions: Landed after \d+ ms/u)).toBeTruthy()
        expect(controller.getSnapshot().check?.decision).toBe('pass')
    })

    it('stays usable with no slow stage: the verdict and the next action are there while overlay and mask still work', async () => {
        // A mask stage that never answers: it yields nothing and never ends.
        const never: Replies['locate'] = async function* () {
            await new Promise<void>(() => undefined)
            yield* []
        }
        const { controller } = await atResult({ followUps: offers, locate: never }, {})
        expect(controller.getSnapshot().stages?.segments.status).toBe('pending')
        expect(controller.getSnapshot().pending).toBeNull()
        expect(screen.queryByTestId('segment-mask', { hidden: true })).toBeNull()
        expect(await screen.findByRole('button', { name: 'Next step' })).toBeTruthy()
        await openJudge()
        const details = within(screen.getByTestId('judge-details', { hidden: true }))
        // Numbered by arrival: the extra regions landed while the mask is still working, so they come first.
        const rank = (label: RegExp): number =>
            Number(/^(\d)\./u.exec(details.getByText(label).props.children as string)![1])
        expect(details.getByText(/^\d\. Precise mask: Working$/u)).toBeTruthy()
        expect(rank(/Extra regions: Landed after \d+ ms/u)).toBeLessThan(rank(/Precise mask: Working/u))
    })

    it('says a stage was skipped or never offered instead of implying it succeeded', async () => {
        const { controller } = await atResult({}, { failing: ['result'] })
        expect(controller.getSnapshot().stages).toBeUndefined()
        await openJudge()
        const details = within(screen.getByTestId('judge-details', { hidden: true }))
        expect(
            details.getByText(/^2\. Result screen: Skipped, the native result is shown \(failed, provider_error\)/u),
        ).toBeTruthy()
        expect(details.getByText('3. Precise mask: Not offered')).toBeTruthy()
    })

    it('never draws a mask from another photo', async () => {
        const { controller } = await atResult(
            { check: { decision: 'refuse', reason: 'Panel faces outward.' }, followUps: offers, locate },
            {},
        )
        await waitFor(() => expect(controller.getSnapshot().stages?.segments.status).toBe('landed'))
        await measurePhoto()
        expect(await screen.findByTestId('segment-mask', { hidden: true })).toBeTruthy()
        await press('Take another photo')
        await waitFor(() => expect(screen.queryByTestId('segment-mask', { hidden: true })).toBeNull())
    })
})

describe('every other screen is composed from its own document', () => {
    it('walks Add, Pages, Reading and Quick check, each in the document’s words, and keeps the stable action identities', async () => {
        const gate = deferred<void>()
        const { view, controller } = await mount([], { replies: { parse: gate.promise } })
        await press('Add a manual')
        await waitFor(() => expect(view.getPathname()).toBe('/add'))
        expect(await screen.findByText('Take a photo of each manual page.')).toBeTruthy()
        expect(screen.getByTestId('take-page-photo')).toBeTruthy()
        expect(screen.getByTestId('choose-pages')).toBeTruthy()
        await act(async () => controller.importPages(async () => [source]))
        expect(await screen.findByText('Add every page, even the parts list.')).toBeTruthy()
        expect(screen.getByTestId('read-manual')).toBeTruthy()
        expect(screen.getByTestId('add-page')).toBeTruthy()
        await press('Read my manual')
        await waitFor(() => expect(view.getPathname()).toMatch(/^\/reading\//u))
        expect(await screen.findByText('Reading each page. This can take a minute.')).toBeTruthy()
        // While it reads, the only honest controls are the native ones: stop is never replaced.
        expect(screen.getByTestId('cancel-reading')).toBeTruthy()
        await act(async () => gate.resolve())
        await waitFor(() => expect(view.getPathname()).toMatch(/^\/check\//u))
        expect(await screen.findByText('Check what we read before you start building.')).toBeTruthy()
        expect(screen.getByTestId('quick-check-start').props.accessibilityLabel).toBe('Start building')
        await press('Start building')
        await waitFor(() => expect(view.getPathname()).toMatch(/^\/guide\//u))
        expect(controller.current?.session.reviewStatus).toBe('reviewed')
    })

    it('shows Done in the document’s words and returns Home through its action', async () => {
        const finished = entry('flow-manual', 'reviewed', 2)
        finished.completedStepIds = ['step-1', 'step-2']
        finished.stepIndex = 1
        const { view } = await mount([finished])
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/done/flow-manual'))
        expect(await screen.findByText('You finished all 2 steps.')).toBeTruthy()
        await press('Back to Home')
        await waitFor(() => expect(view.getPathname()).toBe('/'))
    })

    it('composes the error screen for a failed check without hiding the cause or the way back', async () => {
        const { controller } = await mount([entry()], { replies: { failCheck: true } })
        await press('Continue building')
        await screen.findByText(/Step 1: /u)
        await press('Take photo')
        await act(async () => controller.shutter(async () => source))
        expect(await screen.findByText('Smart help is unavailable right now. Try again in a moment.')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
        expect(controller.getSnapshot().check).toBeNull()
    })

    it('composes the answer and keeps the question, photo and held verdict', async () => {
        const { controller } = await mount([entry()])
        await press('Continue building')
        await screen.findByText(/Step 1: /u)
        await press('Take photo')
        await act(async () => controller.shutter(async () => source))
        await act(async () => {
            controller.targetChanged({ kind: 'part', partId: 'side-panel' })
            controller.questionChanged('Which way?')
        })
        await act(async () => controller.ask())
        expect(await screen.findByText('The groove faces inward.')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Back to the step' })).toBeTruthy()
        expect(controller.getSnapshot().check?.decision).toBe('pass')
        expect(controller.getSnapshot().question).toBe('Which way?')
    })

    it('composes the More sheet’s intro on Home', async () => {
        await mount([])
        await press('More')
        expect(await screen.findByText('Settings and help.')).toBeTruthy()
    })
})

describe('mandatory manual facts stay visible whatever happened to the document', () => {
    const WARNING = 'Keep children away until the glue has set, and never leave the clamp loose.'
    // A step the extraction classified: its own safety note is the required fact, complete, with no keyword in it.
    const classified = (): LibraryEntry => {
        const value = entry()
        const step = value.session.reviewedSteps[0]!
        value.session.reviewedSteps[0] = {
            ...step,
            safetyNotes: [
                {
                    noteId: 'glue',
                    note: {
                        state: 'known',
                        value: WARNING,
                        sourceRefs: [{ pageId: value.session.pages[0]!.pageId, region: null }],
                    },
                },
            ],
        }
        return value
    }
    // A step that was never classified: every known direction is required, because nothing proves it has no hazard.
    const unclassified = (): LibraryEntry => {
        const value = entry()
        const step = value.session.reviewedSteps[0]!
        value.session.reviewedSteps[0] = { ...step }
        delete (value.session.reviewedSteps[0] as { safetyNotes?: unknown }).safetyNotes
        return value
    }

    it.each([
        ['the document failed', { failing: ['guide'] as const }],
        [
            'the document says nothing about it',
            {
                transform: (document: ScreenDocument): ScreenDocument => ({
                    ...document,
                    body: document.body.filter((node) => node.type !== 'ManualDirections'),
                    manualFacts: document.manualFacts?.map((fact) => ({ ...fact, placement: 'remainder' as const })),
                }),
            },
        ],
        ['the document is the placed directions block', {}],
    ])('shows the whole, unclipped safety note when %s', async (_name, screens) => {
        const { view } = await mount([classified()], { screens })
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        expect(await screen.findByText(WARNING)).toBeTruthy()
        // One place only: a fact the document placed is not repeated by the mandatory section.
        expect(screen.getAllByText(WARNING)).toHaveLength(1)
    })

    it('shows every known direction of a step that was never classified, even with no document at all', async () => {
        const value = unclassified()
        const { view } = await mount([value], { screens: { failing: ['guide'] } })
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        const orientation = value.session.reviewedSteps[0]!.orientation
        const text = orientation.state === 'known' ? orientation.value.description : null
        expect(text).not.toBeNull()
        expect(await screen.findByText(text!)).toBeTruthy()
    })

    it('is not added to the original screen when generated screens are off', async () => {
        const { view } = await mount([classified()], { screens: 'off' })
        await press('Keep building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        expect(screen.queryByTestId('mandatory-fact')).toBeNull()
        expect(screen.queryByText(WARNING)).toBeNull()
    })
})

describe('a late document is used on the next visit, never swapped in under the person', () => {
    it('keeps the native Home while it is in front, and shows the document when Home is next focused', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        const gate = deferred<void>()
        const { view } = await mount([entry()], { screens: { gate: gate.promise } })
        await act(async () => jest.advanceTimersByTime(8_001))
        await act(async () => gate.resolve())
        await flush()
        expect(screen.queryByText('Turn your paper manual into steps.')).toBeNull()
        await press('Keep building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        jest.useRealTimers()
        await testRouter.back('/')
        expect(await screen.findByRole('button', { name: 'Continue building' })).toBeTruthy()
    })
})
