/// <reference types="node" />

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type * as ReactModule from 'react'
import type * as RouterTestingModule from 'expo-router/testing-library'
import type * as CoachRootModule from '../onboarding/coach-root'
import type * as CoachProviderModule from '../onboarding/coach-provider'
import type * as CoachOverlayModule from '../onboarding/coach-overlay'
import type * as OnboardingStoreModule from '../onboarding/onboarding-store'
import type { ActiveStep } from '../onboarding/coach-types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { createController, createDocuments, createScreens } from '../capture/controller-factory'
import {
    measureRenderOriginTree,
    summarizeRenderOriginSession,
    type RenderOriginMeasurement,
    type RenderOriginCheckpoint,
} from '../../ui/test-support/render-origin-coverage'
import {
    SCREEN_KINDS_V2,
    NODE_TYPES_V2,
    variantsOfV2,
    visitVariantNodesV2,
    screenProposalV2Schema,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenNodeTypeV2,
    type ScreenKindV2 as ScreenKind,
} from '@truebuild/contracts'
import { flush, loadPhoto, mount, press, type Mounted } from './test-support/flow'
import { deferred, entry, runtime, source, type Replies } from './test-support/route-harness'
import {
    fixtureDocuments,
    type DocumentFixtureServerOptions as FixtureServerOptions,
} from './test-support/fixture-server'
import { judgeStorage } from './judge-storage'
import { JUDGE_STORAGE_KEY } from './judge-store'
import { renderedDocuments } from './test-support/rendered-documents'
import { auditDocumentHosts, type StrictHostAudit } from './test-support/strict-origin-audit'
import { catalogOriginFixture } from './test-support/catalog-origin-fixtures'
import { matrixSourceBinding } from './test-support/matrix-source-binding'
import { DocumentRenderer } from '../documents/document-renderer'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { DocumentStore } from '../document-runtime/store'
import recordedHomeProposal from '../documents/recorded/recorded-home.proposal.json'
import recordedHomeRuntime from '../documents/recorded/recorded-home.runtime.json'

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
const mockCameraAccess = { granted: false, canAskAgain: false }
const mockCoachGeometry: { enabled: boolean; active: ActiveStep | null } = { enabled: false, active: null }
jest.mock('expo-camera', () => ({
    useCameraPermissions: (): unknown[] => [mockCameraAccess, jest.fn()],
    CameraView: 'CameraView',
}))

const { testRouter, renderRouter } = jest.requireActual<{
    testRouter: { push: (path: string) => Promise<void> }
    renderRouter: typeof RouterTestingModule.renderRouter
}>('expo-router/testing-library')

jest.mock('../onboarding/coach-root', () => {
    const original = jest.requireActual<typeof CoachRootModule>('../onboarding/coach-root')
    const react = jest.requireActual<typeof ReactModule>('react')
    const { CoachProvider } = jest.requireActual<typeof CoachProviderModule>('../onboarding/coach-provider')
    const { CoachRootOverlay } = jest.requireActual<typeof CoachOverlayModule>('../onboarding/coach-overlay')
    const { createOnboardingStore } = jest.requireActual<typeof OnboardingStoreModule>('../onboarding/onboarding-store')
    function MeasuredProvider({ children }: { children: ReactModule.ReactNode }): ReactModule.ReactElement {
        const [store] = react.useState(() =>
            createOnboardingStore({
                getItem: async (): Promise<string | null> => null,
                setItem: async (): Promise<void> => undefined,
            }),
        )
        react.useEffect(() => {
            void store.restore()
        }, [store])
        return react.createElement(CoachProvider, {
            store,
            children,
            settleMs: 0,
            measure: async (): Promise<{ x: number; y: number; width: number; height: number }> => ({
                x: 24,
                y: 240,
                width: 300,
                height: 56,
            }),
            renderOverlay: (active, controls) => {
                mockCoachGeometry.active = active
                return react.createElement(CoachRootOverlay, { active, controls })
            },
        })
    }
    return {
        ...original,
        AppCoachProvider: ({ children }: { children: ReactModule.ReactNode }): ReactModule.ReactElement =>
            mockCoachGeometry.enabled
                ? react.createElement(MeasuredProvider, { children })
                : react.createElement(original.AppCoachProvider, { children }),
    }
})

beforeAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
})
beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation((): void => undefined)
})
afterEach(async () => {
    await cleanup()
    mockCameraAccess.granted = false
    mockCameraAccess.canAskAgain = false
    mockCoachGeometry.enabled = false
    mockCoachGeometry.active = null
    jest.restoreAllMocks()
    jest.mocked(createController).mockReset()
    jest.mocked(createScreens).mockReset()
    jest.mocked(createDocuments).mockReset()
    await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: false }))
})

const ALL_KINDS: readonly ScreenKind[] = SCREEN_KINDS_V2

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

const options = (mode: Mode, extra: FixtureServerOptions = {}): NonNullable<Parameters<typeof mount>[1]> => ({
    screens: mode === 'off' ? 'off' : { ...(mode === 'generated' ? { generated: ALL_KINDS } : {}), ...extra },
    // This mode is an intentional all-fallback control; generated mode retains the real launch recordings.
    ...(mode === 'fallback' ? { recordings: 'off' } : {}),
})
const settle = async (): Promise<void> => {
    await flush()
}
const startBuilding = async (_mode: Mode): Promise<void> => {
    await press('Continue building')
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
    await screen.findByText(/^Step 1 of \d+$/u)
    await settle()
    return mounted
}
const check = async (mounted: Mounted): Promise<void> => {
    await press('Take photo')
    await act(async () => mounted.controller.shutter(async () => source))
    if (mounted.controller.getSnapshot().check !== null) await loadPhoto()
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
            await press('Add a manual')
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
            await press('Add a manual')
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
            await press('Add a manual')
            await waitFor(() => expect(mounted.view.getPathname()).toBe('/add'))
            await act(async () => mounted.controller.importPages(async () => [source]))
            await press('Read manual')
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
            await press('Add a manual')
            await waitFor(() => expect(mounted.view.getPathname()).toBe('/add'))
            await act(async () => mounted.controller.importPages(async () => [source]))
            await press('Read manual')
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
        screen: 'recovery',
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
            await press('Continue building')
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
    {
        screen: 'guide',
        id: 'rejected-schema-document',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await atGuide(mode, [entry()], {
                // Deliberate untrusted wire corruption: the actual client gate must select a complete fallback.
                transform: (document) => ({ ...document, version: 999 }) as unknown as typeof document,
            })
            if (mode !== 'off')
                await waitFor(() =>
                    expect(
                        renderedDocuments(screen.container).some(
                            (document) =>
                                document.kind === 'guide' && document.metadata.fallbackReason === 'invalid_output',
                        ),
                    ).toBe(true),
                )
            return mounted
        },
    },
    {
        screen: 'questions',
        id: 'held-photo-composer',
        run: async ({ mode }): Promise<Mounted> => {
            const mounted = await atGuide(mode)
            await check(mounted)
            await press('Ask about this step')
            await waitFor(() =>
                expect(renderedDocuments(screen.container).some((document) => document.kind === 'questions')).toBe(
                    true,
                ),
            )
            await loadPhoto()
            await settle()
            return mounted
        },
    },
    {
        screen: 'camera',
        id: 'ready-native-preview',
        run: async ({ mode }): Promise<Mounted> => {
            mockCameraAccess.granted = true
            mockCameraAccess.canAskAgain = true
            const mounted = await atGuide(mode)
            await press('Take photo')
            await waitFor(() => expect(screen.container.queryAll((node) => node.type === 'CameraView').length).toBe(1))
            await fireEvent(screen.container.queryAll((node) => node.type === 'CameraView')[0]!, 'cameraReady')
            await settle()
            return mounted
        },
    },
    {
        screen: 'judge',
        id: 'inspect-real-document',
        run: async ({ mode }): Promise<Mounted> => {
            await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: true }))
            const mounted = await atGuide(mode)
            await press('More')
            await press('About this check')
            await waitFor(() =>
                expect(renderedDocuments(screen.container).some((document) => document.kind === 'judge')).toBe(true),
            )
            await settle()
            return mounted
        },
    },
    {
        screen: 'error',
        id: 'startup-boundary',
        run: async ({ mode }): Promise<Mounted> => {
            const ports = await runtime([])
            const server = fixtureDocuments(mode === 'off' ? {} : (options(mode).screens as FixtureServerOptions))
            const store = new DocumentStore({
                client: server,
                mode: mode === 'off' ? 'off' : 'full',
                id: (): string => 'startup',
                ...(mode === 'fallback' ? { recordings: (): null => null } : {}),
            })
            jest.mocked(createController).mockImplementation(() => {
                throw new Error('synthetic startup failure')
            })
            jest.mocked(createScreens).mockReturnValue(null)
            jest.mocked(createDocuments).mockReturnValue(store)
            const view = await renderRouter(resolve(__dirname, '../../../app'))
            await screen.findByTestId('app-unavailable-screen')
            ports.controller.dispose()
            store.dispose()
            return { ...ports, server, store, view }
        },
    },
    {
        screen: 'home',
        id: 'active-coach-overlay',
        run: async ({ mode }): Promise<Mounted> => {
            mockCoachGeometry.enabled = true
            const mounted = await mount([], options(mode))
            const home = renderedDocuments(screen.container).find((document) => document.kind === 'home')!
            expect(home).toBeDefined()
            const authored = mode === 'generated' ? screenProposalV2Schema.parse(recordedHomeProposal) : home
            if (mode === 'generated') {
                expect(home.metadata).toMatchObject({
                    source: 'generated',
                    evidence: 'synthetic-fixture',
                    model: null,
                    effort: null,
                    authoring: recordedHomeRuntime.authoring,
                })
                expect({ header: home.header, body: home.body, bar: home.bar, overlays: home.overlays }).toEqual({
                    header: authored.header,
                    body: authored.body,
                    bar: authored.bar,
                    overlays: authored.overlays,
                })
            }
            const candidates: { node: Extract<ScreenNodeV2, { type: 'CoachMark' }>; path: string }[] = []
            visitVariantNodesV2(authored, '', ({ node, path }) => {
                if (node.type === 'CoachMark') candidates.push({ node, path })
            })
            // First-open tips are a product requirement. A recording that drops them must fail this positive witness.
            expect(candidates.length).toBeGreaterThan(0)
            for (const [index, { node, path }] of candidates.entries()) {
                const overlay = await screen.findByTestId('coach-overlay')
                await waitFor(() =>
                    expect(mockCoachGeometry.active).toMatchObject({
                        candidate: {
                            id: node.targetId,
                            heading: node.heading,
                            sentence: node.body,
                            textOrigin: home.metadata.origins[path],
                            documentId: home.screenId,
                        },
                        position: index + 1,
                        total: candidates.length,
                    }),
                )
                await fireEvent(screen.getByTestId('coach-bubble'), 'layout', {
                    nativeEvent: { layout: { width: 300, height: 180, x: 0, y: 0 } },
                })
                // Large-text presentation uses the sentence as its visible heading; the active candidate above keeps
                // the exact authored heading, and the real overlay must still show the exact authored sentence.
                expect(within(overlay).getAllByText(node.body).length).toBeGreaterThan(0)
                if (index + 1 < candidates.length) await fireEvent.press(screen.getByTestId('coach-next'))
            }
            await settle()
            return mounted
        },
    },
]

const attemptedRouteKeys: string[] = []
const results = new Map<Mode, RenderOriginMeasurement[]>()
const audits: {
    mode: Mode
    screen: string
    checkpointId: string
    audit: StrictHostAudit
    documents: readonly ({ kind: string } & Pick<
        ScreenDocumentV2['metadata'],
        'source' | 'evidence' | 'model' | 'effort' | 'authoring' | 'fallbackReason'
    >)[]
}[] = []
const catalog: { kind: string; state: string; nodeTypes: readonly string[]; audit: StrictHostAudit }[] = []
const catalogTypes = new Set<ScreenNodeTypeV2>()
const sourceBefore = matrixSourceBinding()
describe('render-origin diagnostic matrix (synthetic documents, remounted route checkpoints)', () => {
    it.each(MODES.flatMap(({ mode, sessionId }) => checkpoints.map((point) => ({ mode, sessionId, point }))))(
        '$sessionId · $point.screen/$point.id',
        async ({ mode, sessionId, point }) => {
            attemptedRouteKeys.push(`${mode}:${point.screen}/${point.id}`)
            const context: Context = { mode, mounted: null }
            const mounted = await point.run(context)
            const identity: RenderOriginCheckpoint = {
                sessionId,
                screen: point.screen,
                checkpointId: point.id,
                platform: 'ios',
                evidence: 'synthetic-fixture',
            }
            const documents = renderedDocuments(screen.container)
            expect(documents.length).toBeGreaterThan(0)
            if (point.id === 'rejected-schema-document') {
                expect(documents.some((document) => document.kind === 'guide')).toBe(true)
                expect(
                    documents
                        .filter((document) => document.kind === 'guide')
                        .every((document) => document.metadata.source === 'fallback'),
                ).toBe(true)
            }
            const audit = auditDocumentHosts(mounted.view.toJSON(), documents)
            audits.push({
                mode,
                screen: point.screen,
                checkpointId: point.id,
                audit,
                documents: documents.map((document) => ({
                    kind: document.kind,
                    source: document.metadata.source,
                    evidence: document.metadata.evidence,
                    model: document.metadata.model,
                    effort: document.metadata.effort,
                    authoring: document.metadata.authoring,
                    fallbackReason: document.metadata.fallbackReason,
                })),
            })
            expect(audit.failures).toEqual([])
            const measured = measureRenderOriginTree(mounted.view.toJSON(), identity)
            expect(measured.status).toBe('measured')
            expect(measured.counts.total).toBeGreaterThan(0)
            results.set(mode, [...(results.get(mode) ?? []), measured])
            if (mode === 'off') {
                // Off is the original app: not one host element is claimed as composed.
                expect(measured.counts.generated).toBe(0)
                expect(measured.counts.fallback).toBeGreaterThan(0)
                expect(mounted.server.requests).toEqual([])
            }
            if (mode === 'fallback')
                expect(documents.filter((document) => document.metadata.source !== 'fallback')).toEqual([])
        },
    )
})

describe('complete v2 catalog through the actual renderer and real controller fixture bindings', () => {
    it.each(ALL_KINDS)('%s: every applicable authored state keeps host ownership and attribution', async (kind) => {
        const fixture = await catalogOriginFixture(kind)
        try {
            for (const selected of variantsOfV2(fixture.document)) {
                const types = new Set<ScreenNodeTypeV2>()
                visitVariantNodesV2(selected.variant, selected.prefix, ({ node }) => {
                    types.add(node.type)
                    catalogTypes.add(node.type)
                })
                const view = await render(
                    <ThemeProvider>
                        <FeedbackProvider reduceMotion>
                            <DocumentRenderer
                                document={fixture.document}
                                bindings={fixture.bindings}
                                variant={selected.name}
                                testID="catalog-root"
                            />
                        </FeedbackProvider>
                    </ThemeProvider>,
                )
                if (selected.name === 'ready' && fixture.document.requirements.capture) {
                    for (const frame of screen.queryAllByTestId('frozen-photo-frame'))
                        await fireEvent(frame, 'layout', {
                            nativeEvent: { layout: { width: 390, height: 460, x: 0, y: 0 } },
                        })
                    for (const image of screen.queryAllByTestId('frozen-photo-image')) await fireEvent(image, 'load')
                }
                if (selected.name === 'ready') {
                    for (let depth = 0; depth < 4; depth++) {
                        const closed = screen
                            .queryAllByRole('button')
                            .filter(
                                (button) =>
                                    button.props.accessibilityState?.expanded === false &&
                                    button.props.accessibilityState?.disabled !== true,
                            )
                        if (closed.length === 0) break
                        for (const button of closed) await fireEvent.press(button)
                    }
                }
                if (selected.variant.header.title.kind === 'literal')
                    expect(screen.getAllByText(selected.variant.header.title.text).length).toBeGreaterThan(0)
                const primary = within(screen.getAllByTestId('bottom-bar').at(-1)!).getByRole('button', {
                    name: selected.variant.bar.primary.label,
                })
                // Camera composition may be pending while its real preview is ready; existing native contract keeps the shutter usable.
                if (selected.name === 'pending' || selected.name === 'busy')
                    expect(primary.props.accessibilityState.disabled).toBe(
                        kind === 'camera' && selected.name === 'pending' ? false : true,
                    )
                if (selected.name === 'ready' && (kind === 'result' || kind === 'answer')) {
                    const held =
                        kind === 'result' ? fixture.bindings.live?.state.check : fixture.bindings.live?.state.answer
                    expect(held).not.toBeNull()
                    if (held != null)
                        expect(
                            screen.getAllByText('reason' in held ? held.reason : held.answer).length,
                        ).toBeGreaterThan(0)
                }
                const audit = auditDocumentHosts(view.toJSON(), fixture.documents)
                catalog.push({ kind, state: selected.name, nodeTypes: [...types], audit })
                expect(audit.failures).toEqual([])
                expect(audit.counts.total).toBeGreaterThan(0)
                await view.unmount()
            }
        } finally {
            fixture.dispose()
        }
    })
    it('covers the entire closed catalog without counting unconfigured or schema-invalid nodes', () => {
        expect([...catalogTypes].sort()).toEqual([...NODE_TYPES_V2].sort())
    })
})
afterAll(() => {
    const sourceAfter = matrixSourceBinding()
    const changedSourceFiles = [
        ...new Set([...Object.keys(sourceBefore.files), ...Object.keys(sourceAfter.files)]),
    ].filter((path) => sourceBefore.files[path] !== sourceAfter.files[path])
    const sessions = MODES.map(({ mode, sessionId }) => {
        const samples = results.get(mode) ?? []
        const summary = summarizeRenderOriginSession(samples)
        const modeAudits = audits.filter((entry) => entry.mode === mode)
        const complete =
            samples.length === checkpoints.length &&
            modeAudits.length === checkpoints.length &&
            modeAudits.every((entry) => entry.audit.status === 'measured')
        return {
            sessionId,
            mode,
            note:
                mode === 'generated'
                    ? 'Synthetic generated transport examples plus validated recorded documents selected by the runtime; no model call during this RNTL run.'
                    : mode === 'fallback'
                      ? 'Intentional all-fallback control: recordings are disabled through the runtime injection seam and transport returns deterministic fixture fallbacks.'
                      : 'GENERATIVE_UI off: complete local fallback documents, no screens request.',
            summary: {
                status: complete ? summary.status : 'unavailable',
                expectedCheckpoints: checkpoints.length,
                completedCheckpoints: samples.length,
                counts: complete ? summary.counts : null,
                generatedShare: complete ? summary.generatedShare : null,
                rawTextCounts: complete ? summary.rawTextCounts : null,
                byHostType: complete ? summary.byHostType : null,
                minimumScreenGeneratedShare: complete ? summary.minimumScreenGeneratedShare : null,
                screens: summary.screens,
                failedStrictCheckpoints: modeAudits
                    .filter((entry) => entry.audit.status !== 'measured')
                    .map((entry) => `${entry.screen}/${entry.checkpointId}`),
            },
            checkpoints: samples.map((sample) => ({
                screen: sample.checkpoint.screen,
                checkpointId: sample.checkpoint.checkpointId,
                counts: sample.counts,
                generatedShare: sample.generatedShare,
            })),
        }
    })
    const directory = resolve(__dirname, '../../../../test-results')
    mkdirSync(directory, { recursive: true })
    writeFileSync(
        resolve(
            directory,
            attemptedRouteKeys.length === checkpoints.length * MODES.length
                ? 'coverage-v2-route-matrix.json'
                : 'coverage-v2-route-matrix.partial.json',
        ),
        `${JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                evidence: 'synthetic-fixture',
                completeDeclaredRouteRun: attemptedRouteKeys.length === checkpoints.length * MODES.length,
                attemptedRouteKeys,
                measured: 'react-test-renderer (RNTL 14) host elements of the production route tree, per origin marker',
                notMeasured: [
                    'any model output or live provider',
                    'physical Fabric/UIKit/Android views',
                    'the native Stack header and OS chrome (outside the JS host tree)',
                    'a percentage target: none is claimed here',
                ],
                declaredRouteKinds: [...new Set(checkpoints.map((point) => point.screen))],
                screenKinds: [...new Set(audits.flatMap((entry) => entry.documents.map((document) => document.kind)))],
                catalogKinds: ALL_KINDS,
                unmeasuredKinds: ALL_KINDS.filter(
                    (kind) => !audits.some((entry) => entry.screen === kind && entry.audit.status === 'measured'),
                ),
                fixedMatrix: checkpoints.map((point) => `${point.screen}/${point.id}`),
                sourceBinding: {
                    before: sourceBefore,
                    after: sourceAfter,
                    changedSourceFiles,
                    frozenIntegration: false,
                },
                strictHostAudits: audits,
                catalogMatrix: {
                    configuredNodeTypes: [...catalogTypes],
                    missingNodeTypes: NODE_TYPES_V2.filter((type) => !catalogTypes.has(type)),
                    delegatedNodeTypes: ['CoachMark'],
                    scope: 'Real NativeDocumentRenderer with explicit authored variants and real controller fixture bindings; route state transitions are listed separately.',
                    delegationNote:
                        'CoachMark config feeds the actual coach engine; its renderer node returns null. Active overlay witness is recorded separately.',
                    checkpoints: catalog,
                },
                sessions,
            },
            null,
            2,
        )}\n`,
    )
})
