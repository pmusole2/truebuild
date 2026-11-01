/// <reference types="node" />

import type * as ReactModule from 'react'
import type * as ReactNative from 'react-native'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { createController, createDocuments, createScreens } from '../capture/controller-factory'
import {
    documentMaterialV2,
    STATE_COPY_V2,
    screenStageV2,
    variantsOfV2,
    type ScreenContextInputsV2,
    type ScreenProposalV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import type { CaptureController } from '../capture/controller'
import { flush, loadPhoto, mount, press, type Mounted } from './test-support/flow'
import { deferred, entry, source, type Replies } from './test-support/route-harness'
import type {
    DocumentFixtureServer as FixtureServer,
    DocumentFixtureServerOptions as FixtureServerOptions,
} from './test-support/fixture-server'
import { documentPrecomputeInputs, inputsFromDocumentMetadata } from '../../api/document-client'
import { MODEL_SCREEN_TIMEOUT_MS, MODEL_STEP_PAGE_TIMEOUT_MS } from '../../api/model-client'
import { measureRenderOriginTree } from '../../ui/test-support/render-origin-coverage'
import { judgeStorage } from './judge-storage'
import { JUDGE_STORAGE_KEY } from './judge-store'
import type { LibraryEntry } from '../capture/library'
import type { JsonElement, TestInstance } from 'test-renderer'
import { DOCUMENT_FOCUS_GRACE_MS } from '../document-runtime/use-document'
import { stepPiecesForStep } from '../pieces/piece-registry'

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
jest.mock('../capture/controller-factory', () => ({
    createController: jest.fn(),
    createScreens: jest.fn(),
    createDocuments: jest.fn(),
}))
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
    jest.mocked(createDocuments).mockReset()
    jest.useRealTimers()
    await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: false }))
})

const hostCounts = (
    view: Mounted['view'],
    documentTestId?: string,
): { generated: number; fallback: number; shell: number; total: number } => {
    const findDocument = (node: JsonElement): JsonElement | null => {
        if (node.props.testID === documentTestId) return node
        for (const child of node.children) {
            if (typeof child === 'string') continue
            const match = findDocument(child)
            if (match !== null) return match
        }
        return null
    }
    const allMounted = view.toJSON()
    const tree = documentTestId === undefined || allMounted === null ? allMounted : findDocument(allMounted)
    if (documentTestId !== undefined && tree === null) throw new Error('missing_document_host_tree')
    const sample = measureRenderOriginTree(tree, {
        sessionId: 'ui-grace',
        screen: 'home',
        checkpointId: 'current',
        platform: 'ios',
        evidence: 'synthetic-fixture',
    })
    if (sample.status !== 'measured') throw new Error('unavailable_host_tree')
    return sample.counts
}

const generateCalls = (server: FixtureServer): string[] =>
    server.requests.flatMap((request) => (request.op === 'generate' && request.kind !== null ? [request.kind] : []))

describe('generated screens off keeps the original app', () => {
    it('makes no screens request and shows the native Home and Guide copy exactly', async () => {
        const { server, view, controller } = await mount([entry()], { screens: 'off' })
        expect(screen.getByRole('button', { name: 'Continue building' })).toBeTruthy()
        expect(screen.queryByText(STATE_COPY_V2.pending.heading)).toBeNull()
        expect(screen.queryByTestId('generated-body')).toBeNull()
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        await waitFor(() => expect(controller.current?.session.manualId).toBe('flow-manual'))
        expect(screen.getByTestId('guide-primary')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Take photo' })).toBeTruthy()
        expect(server.requests).toEqual([])
        expect(hostCounts(view).generated).toBe(0)
        expect(hostCounts(view).fallback).toBeGreaterThan(0)
    })
})

describe('Home composed by the document', () => {
    it('shows the calm skeleton while composing, then the document, keeping the stable test identity of the action', async () => {
        const gate = deferred<void>()
        const { server } = await mount([], { screens: { gate: gate.promise }, recordings: 'off' })
        expect(await screen.findByText(STATE_COPY_V2.pending.heading)).toBeTruthy()
        expect(screen.getByText(STATE_COPY_V2.pending.detail)).toBeTruthy()
        expect(STATE_COPY_V2.pending.heading).toBe('Working on it')
        await act(async () => gate.resolve())
        expect(await screen.findByText('Add a manual to start building.')).toBeTruthy()
        expect(screen.queryByText(STATE_COPY_V2.pending.heading)).toBeNull()
        const add = screen.getByTestId('home-add')
        expect(add).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Add a manual' })).toBeTruthy()
        expect(screen.getAllByRole('button', { name: 'Add a manual' })).toHaveLength(1)
        expect(generateCalls(server)).toContain('home')
    })

    it('runs the document action only through the controller and lands on the real Add route', async () => {
        const { view, controller } = await mount([])
        await press('Add a manual')
        await waitFor(() => expect(view.getPathname()).toBe('/add'))
        expect(controller.current?.session.pages).toHaveLength(0)
        expect(await screen.findByText('Photograph each page of your manual, one at a time.')).toBeTruthy()
        expect(screen.getByTestId('take-page-photo')).toBeTruthy()
    })

    it('keeps the native Home when the document cannot be composed', async () => {
        const { server } = await mount([], { screens: { failing: ['home'] }, recordings: 'off' })
        expect(await screen.findByRole('button', { name: 'Add a manual' })).toBeTruthy()
        expect(screen.getByText('Add a manual to start building.')).toBeTruthy()
        expect(screen.queryByTestId('generated-body')).toBeNull()
        expect(generateCalls(server)).toContain('home')
    })

    it('shows honest shell progress within fifteen seconds and swaps in the original generated page while focused', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        const gate = deferred<void>()
        const { store, view, server } = await mount([], {
            screens: { generated: ['home'], gate: gate.promise },
            recordings: 'off',
        })
        expect(screen.getByText(STATE_COPY_V2.pending.heading)).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(15_001))
        expect(screen.getByText(STATE_COPY_V2.busy.heading)).toBeTruthy()
        expect(screen.queryByText('That took too long')).toBeNull()
        const request = server.requests.find((item) => item.op === 'generate' && item.kind === 'home')!
        expect(store.peek(inputsFromDocumentMetadata(request))?.status).toBe('pending')
        expect(hostCounts(view).generated).toBe(0)
        await act(async () => gate.resolve())
        await screen.findByRole('button', { name: 'Add a manual' })
        const generated = store.peek(inputsFromDocumentMetadata(request))!.document
        expect(generated.metadata.source).toBe('generated')
        expect(screen.getByTestId('library-screen').props.nativeID).toContain(
            `truebuild-document-root:${generated.screenId}`,
        )
        expect(hostCounts(view).generated).toBeGreaterThan(0)
        expect(server.requests.filter((item) => item.op === 'generate' && item.kind === 'home')).toHaveLength(1)
        expect(DOCUMENT_FOCUS_GRACE_MS).toBeLessThanOrEqual(15_000)
    })
})

describe('Guide composed by the document', () => {
    it('precomputes every step once after the manual is confirmed, then opens each step without a new request', async () => {
        const { server, view, controller, store } = await mount([entry('flow-manual', 'reviewed', 3)])
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        expect(await screen.findByText(/^Step 1 of \d+$/u)).toBeTruthy()
        const guides = documentPrecomputeInputs({
            session: controller.current!.session,
        })
            .filter((item) => item.inputs.kind === 'guide')
            .map((item) => ({
                ...item,
                inputs: {
                    ...item.inputs,
                    stepPieces: stepPiecesForStep(controller.current!.session, item.inputs.stepId),
                },
            }))
        await waitFor(() => expect(guides.every((item) => store.peek(item.inputs)?.status === 'ready')).toBe(true))
        const guideRequests = (): typeof server.requests =>
            server.requests.filter((request) => request.op === 'generate' && request.kind === 'guide')
        const preparedRequests = guideRequests()
        expect(preparedRequests.map((request) => request.stepId).sort()).toEqual(['step-1', 'step-2', 'step-3'])
        expect(preparedRequests.every((request) => request.uiState?.busy == null)).toBe(true)
        expect(new Set(preparedRequests.map((request) => request.contextKey)).size).toBe(3)
        expect(server.requests.filter((request) => request.op === 'precompute' || request.op === 'progress')).toEqual(
            [],
        )
        await act(async () => controller.step(1))
        expect(await screen.findByText(/^Step 2 of \d+$/u)).toBeTruthy()
        await act(async () => controller.step(2))
        expect(await screen.findByText(/^Step 3 of \d+$/u)).toBeTruthy()
        // Every prepared step keeps its exact cached identity when it becomes visible.
        expect(guideRequests()).toEqual(preparedRequests)
    })

    it('uses the document bar for the action and keeps the guide-primary identity', async () => {
        const { view, controller } = await mount([entry()])
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        await screen.findByText(/^Step 1 of \d+$/u)
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
        await screen.findByText(/^Step 1 of \d+$/u)
        return mounted
    }
    const photo = async (controller: CaptureController, loaded = true): Promise<void> => {
        await press('Take photo')
        await act(async () => controller.shutter(async () => source))
        if (loaded) await loadPhoto()
    }

    it('shows the verdict at once, then the composed result screen; the held verdict is never changed', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        const gate = deferred<void>()
        let hold = false
        const { controller, server, view, store } = await atGuide({
            screens: {
                generated: ['result'],
                get gate() {
                    return hold ? gate.promise : undefined
                },
            },
            replies: { check: { reason: 'The groove faces inward.' } },
        })
        hold = true
        await photo(controller, false)
        expect(controller.getSnapshot().check?.decision).toBe('pass')
        expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
        expect(screen.queryByText('The groove faces inward.')).toBeNull()
        await loadPhoto()
        expect(await screen.findByText('The groove faces inward.')).toBeTruthy()
        const heldCapture = controller.getSnapshot().capture?.binding.captureId
        const resultRequest = server.requests.find((request) => request.op === 'generate' && request.kind === 'result')!
        const resultInputs = inputsFromDocumentMetadata(resultRequest)
        const authored = store.peek(resultInputs)!
        expect(authored.document.kind).toBe('result')
        expect(authored.document.metadata.authoring?.fixtureId).toBe('recorded-result-layout-sol-v1')
        expect(authored.document.metadata.carried ?? {}).toEqual({})
        expect(authored.exactGeneration).toBe('pending')
        expect(store.readyAt(resultInputs)).toBeNull()
        await act(async () => jest.advanceTimersByTime(9_001))
        // guide-screen is the route's stable testID; its actual document is the current authored Result.
        expect(screen.getByTestId('guide-screen').props.nativeID).toContain(
            `truebuild-document-root:${authored.document.screenId}`,
        )
        expect(hostCounts(view, 'guide-screen').generated).toBeGreaterThan(0)
        expect(screen.getByText('The groove faces inward.')).toBeTruthy()
        await act(async () => gate.resolve())
        await waitFor(() => expect(store.peek(resultInputs)?.exactGeneration).toBeUndefined())
        expect(store.peek(resultInputs)?.document.screenId).not.toBe(authored.document.screenId)
        expect(store.readyAt(resultInputs)).not.toBeNull()
        expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
        expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
        expect(controller.getSnapshot().capture?.binding.captureId).toBe(heldCapture)
        expect(controller.getSnapshot().check?.decision).toBe('pass')
        expect(generateCalls(server)).toContain('result')
        expect(
            server.requests.filter(
                (request) => request.op === 'generate' && request.contextKey === resultRequest.contextKey,
            ),
        ).toHaveLength(1)
        const resultRequests = (): typeof server.requests =>
            server.requests.filter((request) => request.op === 'generate' && request.kind === 'result')
        await waitFor(() => expect(resultRequests()).toHaveLength(1))
        for (const request of resultRequests())
            await waitFor(() =>
                expect(store.peek(inputsFromDocumentMetadata(request))?.exactGeneration).toBeUndefined(),
            )
        await act(async () => jest.runOnlyPendingTimersAsync())
        await flush()
        expect(resultRequests()).toHaveLength(1)
        expect(new Set(resultRequests().map((request) => request.contextKey)).size).toBe(1)
        expect(
            resultRequests()
                .map((request) => request.uiState?.busy?.activity ?? 'ready')
                .sort(),
        ).toEqual(['ready'])
        for (const request of resultRequests()) {
            expect(request.captureId).toBe(heldCapture)
            expect(request.result).toEqual(resultRequest.result)
            expect(resultRequests().filter((item) => item.contextKey === request.contextKey)).toHaveLength(1)
        }
        expect(JSON.stringify(resultRequest)).not.toContain('secondOpinionToken')
    })

    it('marks a passed step done only through the document button and only for a held pass', async () => {
        const { controller } = await atGuide()
        await photo(controller)
        await press('Next step')
        await waitFor(() => expect(controller.current?.completedStepIds).toEqual(['step-1']))
    })

    it.each(['none', 'more'] as const)(
        'keeps the loaded photo through app busy states and late READY composition with %s covering the result',
        async (sheet) => {
            await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: true }))
            const primary = deferred<void>()
            const closer = deferred<void>()
            const finalComposition = deferred<void>()
            const compositionGate: { current?: Promise<void> } = {}
            let checks = 0
            const { controller, server, store } = await atGuide({
                screens: {
                    generated: ['result'],
                    recordedMetadata: true,
                    // Hold only the Result under test; unrelated warmups must release their shared generation slots.
                    onRequest: (request) => {
                        compositionGate.current = request.kind === 'result' ? finalComposition.promise : undefined
                    },
                    get gate() {
                        return compositionGate.current
                    },
                    arrange: (proposal, inputs) => {
                        if (inputs.kind !== 'result') return proposal
                        for (const { variant } of variantsOfV2(proposal)) {
                            if (variant.body.type !== 'Scroll' || variant.body.children[0]?.type !== 'Stack')
                                throw new Error('expected_result_fixture_spine')
                            variant.body.children[0].children = [
                                {
                                    type: 'Card',
                                    surface: 'raised',
                                    padding: 'md',
                                    tone: 'neutral',
                                    children: variant.body.children[0].children,
                                },
                            ]
                        }
                        return proposal
                    },
                },
                replies: {
                    check_gate: primary.promise,
                    check: async () => {
                        if (++checks === 1)
                            return {
                                decision: 'cannot_verify',
                                reason: 'The near joint is hidden.',
                                missingEvidence: ['Show the near joint.'],
                                model: 'muse-spark-1.3',
                                secondOpinion: { status: 'available', model: 'muse-wonder-1.0', token: 'one-use' },
                            }
                        await closer.promise
                        return {
                            decision: 'refuse',
                            reason: 'The near joint is reversed.',
                            missingEvidence: [],
                            model: 'muse-wonder-1.0',
                            secondOpinion: { status: 'completed', model: 'muse-wonder-1.0' },
                        }
                    },
                },
            })
            compositionGate.current = finalComposition.promise
            await press('Take photo')
            let checking!: Promise<void>
            await act(async () => {
                checking = controller.shutter(async () => source)
            })
            await screen.findByTestId('frozen-photo-image')
            await loadPhoto()
            const heldImage = screen.getByTestId('frozen-photo-image')
            const heldCapture = controller.getSnapshot().capture!
            const heldUri = heldImage.props.source.uri as string
            await act(async () => primary.resolve())
            await waitFor(() => expect(controller.getSnapshot().check?.decision).toBe('cannot_verify'))
            expect(screen.getByText('The near joint is hidden.')).toBeTruthy()
            expect(controller.getSnapshot().pending).toBeNull()
            expect(screen.getByTestId('frozen-photo-image')).toBe(heldImage)
            const busyRequests = server.requests.filter(
                (request) =>
                    request.op === 'generate' &&
                    request.kind === 'result' &&
                    request.result?.kind === 'check' &&
                    request.uiState?.busy?.activity === 'second-opinion',
            )
            // The app owns this state; only the final READY result asks for a layout.
            expect(busyRequests).toHaveLength(0)
            expect(screen.getByTestId('frozen-photo-image').props.style.width).toBeGreaterThan(0)
            expect(screen.getByTestId('frozen-photo-image')).toBe(heldImage)
            expect(screen.getByText('The near joint is hidden.')).toBeTruthy()
            expect(controller.getSnapshot().pending).toBeNull()

            await act(async () => {
                closer.resolve()
                await checking
            })
            await waitFor(() => expect(controller.getSnapshot().pending).toBeNull())
            expect(controller.getSnapshot().check?.decision).toBe('refuse')
            expect(screen.getByText('The near joint is reversed.')).toBeTruthy()
            expect(screen.queryByText('The near joint is hidden.')).toBeNull()
            expect(screen.getByTestId('frozen-photo-image')).toBe(heldImage)
            expect(screen.getByTestId('frozen-photo-image').props.source.uri).toBe(heldUri)
            expect(controller.getSnapshot().capture).toBe(heldCapture)
            const readyRequest = (): (typeof server.requests)[number] | undefined =>
                server.requests.find(
                    (request) =>
                        request.op === 'generate' &&
                        request.kind === 'result' &&
                        request.result?.kind === 'check' &&
                        request.result.value.decision === 'refuse' &&
                        request.uiState?.busy == null,
                )
            await waitFor(() => expect(readyRequest()).toBeDefined())
            const finalRequest = readyRequest()!
            const finalInputs = inputsFromDocumentMetadata(finalRequest)
            const finalDocument = store.peek(finalInputs)!.document
            if (sheet !== 'none') {
                await press('More')
                await screen.findByTestId('more-sheet')
            }
            await act(async () => finalComposition.resolve())
            await waitFor(() => expect(store.peek(finalInputs)?.exactGeneration).toBeUndefined())
            expect(store.peek(finalInputs)?.issue).toBeNull()
            expect(store.peek(finalInputs)?.document.screenId).not.toBe(finalDocument.screenId)
            if (sheet !== 'none') {
                await fireEvent.press(screen.getByTestId('close-sheet'))
                await waitFor(() => expect(screen.queryByTestId('more-sheet')).toBeNull())
            }
            expect(screen.getByTestId('guide-screen').props.nativeID).toContain(finalDocument.screenId)
            expect(screen.getByTestId('frozen-photo-image')).toBe(heldImage)
            expect(screen.getByText('The near joint is reversed.')).toBeTruthy()
            expect(screen.getByRole('button', { name: 'Retake photo' })).toBeEnabled()
            for (const request of [finalRequest])
                expect(
                    server.requests.filter(
                        (candidate) => candidate.op === 'generate' && candidate.contextKey === request.contextKey,
                    ),
                ).toHaveLength(1)
            // The cached exact response has an arrival time, but its metadata and receipt do not describe this display.
            expect(store.readyAt(finalInputs)).not.toBeNull()
            expect(store.peek(finalInputs)?.document.metadata.timing.totalMs).toBe(3_420)
            await fireEvent.press(screen.getByTestId('judge-summary-details'))
            const details = within(await screen.findByTestId('judge-details'))
            expect(
                details.getByText(
                    /^2\. Result screen: Test fixture, model Not recorded, effort Not recorded, provider Not recorded$/u,
                ),
            ).toBeTruthy()
            expect(details.queryByText(/Result screen:.*provider 3420 ms/u)).toBeNull()
        },
    )

    it('refuses a result document whose banner names another verdict and keeps the authored current result', async () => {
        const { controller, store, server, view } = await atGuide({
            screens: {
                generated: ['result'],
                transform: (document) =>
                    document.kind === 'result'
                        ? {
                              ...document,
                              facts: document.facts.map((fact) =>
                                  fact.kind === 'verdict' ? { ...fact, text: 'Not quite right' } : fact,
                              ),
                          }
                        : document,
            },
        })
        await photo(controller)
        const heldCapture = controller.getSnapshot().capture
        const request = server.requests.find((item) => item.op === 'generate' && item.kind === 'result')!
        await waitFor(() => expect(store.peek(inputsFromDocumentMetadata(request))?.issue).toBe('invalid_output'))
        const retained = store.peek(inputsFromDocumentMetadata(request))!
        expect(retained.document.metadata.source).toBe('generated')
        expect(retained.document.metadata.authoring?.fixtureId).toBe('recorded-result-layout-sol-v1')
        expect(retained.exactGeneration).toBe('unavailable')
        expect(store.readyAt(inputsFromDocumentMetadata(request))).toBeNull()
        // Rejection keeps the authored current result and its actual held frame.
        await loadPhoto()
        expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
        expect(screen.queryByText('Not quite right')).toBeNull()
        expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
        // These counts belong to the active Result inside its guide route.
        expect(hostCounts(view, 'guide-screen').generated).toBeGreaterThan(0)
        expect(hostCounts(view, 'guide-screen').fallback).toBe(0)
        expect(controller.getSnapshot().capture).toBe(heldCapture)
        expect(controller.getSnapshot().check?.decision).toBe('pass')
    })

    it('keeps the authored current result when exact composition cannot be made', async () => {
        const { controller, store, server } = await atGuide({ screens: { failing: ['result'] } })
        await photo(controller)
        const request = server.requests.find((item) => item.op === 'generate' && item.kind === 'result')!
        await waitFor(() => expect(store.peek(inputsFromDocumentMetadata(request))?.issue).toBe('provider_error'))
        expect(store.peek(inputsFromDocumentMetadata(request))?.exactGeneration).toBe('unavailable')
        expect(store.peek(inputsFromDocumentMetadata(request))?.document.metadata.authoring?.fixtureId).toBe(
            'recorded-result-layout-sol-v1',
        )
        expect(store.readyAt(inputsFromDocumentMetadata(request))).toBeNull()
        expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
        expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
    })
})

describe('J1: show how Meta AI built this', () => {
    async function atGuideWithJudge(options: Parameters<typeof mount>[1] = {}): Promise<Mounted> {
        const mounted = await mount([entry()], { screens: { generated: ['guide'] }, ...options })
        await press('Continue building')
        await waitFor(() => expect(mounted.view.getPathname()).toBe('/guide/flow-manual'))
        await screen.findByText(/^Step 1 of \d+$/u)
        return mounted
    }
    const openJudge = async (): Promise<void> => {
        await press('More')
        await fireEvent.press(await screen.findByTestId('judge-entry'))
        await screen.findByRole('switch', { name: 'Show how Meta AI built this' })
    }
    const closeSheets = async (): Promise<void> => {
        await fireEvent.press(screen.getByTestId('close-sheet'))
        await waitFor(() => expect(screen.queryByRole('switch', { name: 'Show how Meta AI built this' })).toBeNull())
        const moreClose = screen.queryByTestId('close-sheet')
        if (moreClose !== null) await fireEvent.press(moreClose)
        await waitFor(() => expect(screen.queryByTestId('close-sheet')).toBeNull())
    }
    const guide = (): ReturnType<typeof within> => within(screen.getByTestId('guide-screen', { hidden: true }))
    const toggle = (): ReturnType<typeof screen.getByRole> =>
        screen.getByRole('switch', { name: 'Show how Meta AI built this' })
    const showDetails = async (): Promise<void> => {
        await openJudge()
        await fireEvent.press(toggle())
        await closeSheets()
        await fireEvent.press(await guide().findByTestId('judge-summary-details'))
        await guide().findByTestId('judge-details')
    }

    it('is off by default: no judge words and no attribution on a normal screen, only a toggle behind About this check', async () => {
        await atGuideWithJudge()
        expect(screen.queryByTestId('judge-summary')).toBeNull()
        expect(screen.queryByTestId('judge-compare')).toBeNull()
        expect(screen.queryByText('Same photo, in the order it arrived')).toBeNull()
        expect(screen.queryByText(/muse|wonder|spark|meta ai|effort|tokens/iu)).toBeNull()
        await openJudge()
        expect(toggle().props.accessibilityState).toMatchObject({ checked: false })
        expect(screen.queryByTestId('judge-summary')).toBeNull()
    })

    it('turns the current screen attribution on and off, showing only what the document recorded and Not recorded for the rest', async () => {
        // Explicit upstream-observation TEST INPUT. This is never synthetic-model or native/provider proof.
        await atGuideWithJudge({ screens: { generated: ['guide'], recordedMetadata: true } })
        await showDetails()
        expect(guide().getByText('Source: generated')).toBeTruthy()
        expect(guide().getByText('Evidence: live')).toBeTruthy()
        expect(guide().getByText('Model: muse-wonder-1.0')).toBeTruthy()
        expect(guide().getByText('Effort: max')).toBeTruthy()
        expect(guide().getByText('Composed by muse-wonder-1.0, max effort')).toBeTruthy()
        for (const text of [
            'Before provider: 15 ms',
            'Provider time: 3400 ms',
            'Validation: 5 ms',
            'Server total: 3420 ms',
            'Input tokens: 1200',
            'Cached input tokens: 0',
            'Output tokens: 900',
            'Reasoning tokens: 700',
        ])
            expect(guide().getByText(text)).toBeTruthy()
        expect(guide().getByText('Visible screen and open sheets: Not recorded')).toBeTruthy()
        expect(guide().getByText('Visible-screen session: Not recorded')).toBeTruthy()
        expect(guide().getByText('Mean across visible routes: Not recorded')).toBeTruthy()
        expect(
            guide().getByText('Visible session, excluding camera and manual-image internals: Not recorded'),
        ).toBeTruthy()
        expect(
            guide().getByText('All mounted screens (previous method): Not recorded; session Not recorded'),
        ).toBeTruthy()
        expect(guide().getByText(/Count unavailable: disconnected|Not counted on this device/u)).toBeTruthy()
        expect(guide().queryByText(/\d+ elements/u)).toBeNull()
        await openJudge()
        await fireEvent.press(toggle())
        await closeSheets()
        await waitFor(() => expect(guide().queryByTestId('judge-summary')).toBeNull())
    })

    it.each([false, true])('says Not recorded for a synthetic document (generated source: %s)', async (generated) => {
        await atGuideWithJudge({ screens: generated ? { generated: ['guide'] } : {} })
        await showDetails()
        expect(guide().getByText(`Source: ${generated ? 'generated' : 'fallback'}`)).toBeTruthy()
        expect(guide().getByText('Test fixture')).toBeTruthy()
        expect(guide().getByText('Evidence: Test fixture')).toBeTruthy()
        expect(guide().queryByText(/Offline composition|Simulated fixture|not a Meta inference/iu)).toBeNull()
        expect(guide().getByText('Model, effort, provider timings and tokens: Not recorded.')).toBeTruthy()
        expect(guide().queryByText('Model: Not recorded')).toBeNull()
        expect(guide().queryByText('Provider time: Not recorded')).toBeNull()
    })

    it('names a block and where it came from when it is tapped, while the layer is on', async () => {
        await atGuideWithJudge()
        await showDetails()
        const fact = guide().getByText('Groove faces inward toward the divider.')
        await fireEvent(fact, 'touchEnd', { stopPropagation: jest.fn() })
        expect(await guide().findByText('Text · generated')).toBeTruthy()
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
    const entries = (): LibraryEntry[] => {
        const second = entry('manual-b', 'reviewed', 3, 'Beta')
        second.session.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'lift',
                note: {
                    state: 'known',
                    value: 'Two people should lift this.',
                    sourceRefs: [{ pageId: second.session.pages[0]!.pageId, region: null }],
                },
            },
        ]
        return [entry('manual-a', 'reviewed', 2, 'Alpha'), second, entry('manual-c', 'unreviewed', 2, 'Gamma')]
    }
    const different: FixtureServerOptions = {
        generated: ['guide'],
        arrange: (proposal, inputs) =>
            inputs.session?.manualId === 'manual-b'
                ? {
                      ...proposal,
                      body: {
                          type: 'Card',
                          surface: 'raised',
                          tone: 'neutral',
                          padding: 'md',
                          children: [proposal.body],
                      },
                      bar: { ...proposal.bar, primary: { ...proposal.bar.primary, label: 'Take a photo' } },
                  }
                : proposal,
    }

    it('keeps a direct link closed while the device judge toggle is off', async () => {
        await judgeStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: false }))
        await mount(entries(), { screens: different })
        await testRouter.push('/compare')
        expect(await screen.findByText('Your manuals')).toBeTruthy()
        expect(screen.queryByTestId('compare-choose-manual-a')).toBeNull()
        expect(screen.queryByTestId('compare-panes')).toBeNull()
    })

    it('is reachable from About this check and lists real library manuals, finished ones only', async () => {
        const { view } = await mount(entries(), { screens: different })
        await testRouter.push('/compare')
        await waitFor(() => expect(view.getPathname()).toBe('/compare'))
        expect(screen.getByTestId('compare-choose-manual-a')).toBeTruthy()
        expect(screen.getByTestId('compare-choose-manual-b')).toBeTruthy()
        const draft = screen.getByTestId('compare-choose-manual-c')
        expect(draft.props.accessibilityState).toMatchObject({ disabled: true })
        expect(await screen.findByTestId('compare-pane-manual-a')).toBeTruthy()
        expect(await screen.findByTestId('compare-pane-manual-b')).toBeTruthy()
        expect(screen.queryByTestId('compare-pane-manual-c')).toBeNull()
    })

    it('draws any two manuals with the same renderer and different compositions, without changing either', async () => {
        const { view, controller, server } = await mount(entries(), { screens: different })
        await testRouter.push('/compare')
        await waitFor(() => expect(view.getPathname()).toBe('/compare'))
        const a = await screen.findByTestId('compare-pane-manual-a')
        const b = await screen.findByTestId('compare-pane-manual-b')
        expect(a).toBeTruthy()
        expect(b).toBeTruthy()
        expect((await within(a).findAllByText('Alpha 1: Stand the side panel upright')).length).toBeGreaterThan(0)
        expect((await within(b).findAllByText('Beta 1: Stand the side panel upright')).length).toBeGreaterThan(0)
        expect(screen.getAllByText('Two people should lift this.')).toHaveLength(1)
        expect(within(a).getByRole('button', { name: 'Take photo' }).props.accessibilityState).toMatchObject({
            disabled: true,
        })
        expect(within(b).getByRole('button', { name: 'Take a photo' }).props.accessibilityState).toMatchObject({
            disabled: true,
        })
        expect(within(a).getByText('Test fixture')).toBeTruthy()
        expect(within(b).getByText('Test fixture')).toBeTruthy()
        const composed = server.requests.flatMap((request) =>
            request.op === 'generate' ? [request.session?.manualId] : [],
        )
        expect(composed).toEqual(expect.arrayContaining(['manual-a', 'manual-b']))
        expect(controller.getSnapshot().entries.map((item) => item.session.revision)).toEqual([1, 1, 1])
        await fireEvent.press(screen.getByTestId('compare-choose-manual-a'))
        expect(screen.queryByTestId('compare-pane-manual-a')).toBeNull()
        expect(screen.getByTestId('compare-pane-manual-b')).toBeTruthy()
        await fireEvent.press(screen.getByTestId('compare-choose-manual-a'))
        expect(await screen.findByTestId('compare-pane-manual-a')).toBeTruthy()
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
        await screen.findByTestId('compare-pane-manual-b')
        expect(screen.getByTestId('compare-panes').props.style).toEqual(
            expect.arrayContaining([expect.objectContaining({ flexDirection: direction })]),
        )
        expect(screen.getByTestId('compare-panes')).toBeTruthy()
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
        await screen.findByText(/^Step 1 of \d+$/u)
        await press('Take photo')
        await act(async () => mounted.controller.shutter(async () => source))
        await loadPhoto()
        return mounted
    }
    const openJudge = async (): Promise<void> => {
        await press('More')
        await loadPhoto() // The newly mounted contextual More must load its own exact held-photo node.
        await fireEvent.press(await screen.findByTestId('judge-entry'))
        await fireEvent.press((await screen.findAllByTestId('judge-summary-details')).at(-1)!)
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
            { generated: ['result'], recordedMetadata: true },
        )
        await waitFor(() => expect(controller.getSnapshot().stages?.segments.status).toBe('landed'))
        await measurePhoto()
        expect(await screen.findByTestId('segment-mask', { hidden: true })).toBeTruthy()
        await openJudge()
        const details = within(screen.getByTestId('judge-details', { hidden: true }))
        expect(details.getByText(/1\. Verdict: muse-spark-1\.3, \d+ ms \(measured on this device\)/u)).toBeTruthy()
        // The three later stages are numbered by when they really arrived, so each is found by its own words.
        expect(
            details.getByText(
                /^\d\. Result screen: Model-composed, model muse-wonder-1\.0, effort max, provider 3420 ms$/u,
            ),
        ).toBeTruthy()
        expect(
            details.getByText(
                /^\d\. Precise mask: Landed after \d+ ms \(measured on this device\), server 412 ms, 1 outlined, model sam-3\.1$/u,
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
        const { controller, store, server } = await atResult({}, { failing: ['result'] })
        const request = server.requests.find((item) => item.op === 'generate' && item.kind === 'result')!
        await waitFor(() => expect(store.peek(inputsFromDocumentMetadata(request))?.issue).toBe('provider_error'))
        expect(store.peek(inputsFromDocumentMetadata(request))?.exactGeneration).toBe('unavailable')
        expect(store.readyAt(inputsFromDocumentMetadata(request))).toBeNull()
        await flush()
        expect(controller.getSnapshot().stages).toBeUndefined()
        await openJudge()
        const details = within(screen.getByTestId('judge-details', { hidden: true }))
        expect(
            details.getByText(
                /^2\. Result screen: Test fixture, model Not recorded, effort Not recorded, provider Not recorded$/u,
            ),
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
        await press('Retake photo')
        await waitFor(() => expect(screen.queryByTestId('segment-mask', { hidden: true })).toBeNull())
    })
})

describe('every other screen is composed from its own document', () => {
    it('walks Add, Pages, Reading and Quick check, each in the document’s words, and keeps the stable action identities', async () => {
        const gate = deferred<void>()
        const { view, controller } = await mount([], { replies: { parse: gate.promise } })
        await press('Add a manual')
        await waitFor(() => expect(view.getPathname()).toBe('/add'))
        expect(await screen.findByText('Photograph each page of your manual, one at a time.')).toBeTruthy()
        expect(screen.getByTestId('take-page-photo')).toBeTruthy()
        expect(screen.getByTestId('choose-pages')).toBeTruthy()
        await act(async () => controller.importPages(async () => [source]))
        expect(await screen.findByText('1 manual page')).toBeTruthy()
        expect(screen.getByTestId('read-manual')).toBeTruthy()
        expect(screen.getByTestId('add-page')).toBeTruthy()
        await press('Read manual')
        await waitFor(() => expect(view.getPathname()).toMatch(/^\/reading\//u))
        expect(within(screen.getByTestId('document-header-copy')).getByText('Reading your manual')).toBeTruthy()
        expect(screen.getByText('This can take a minute.')).toBeTruthy()
        // While it reads, the only honest controls are the native ones: stop is never replaced.
        expect(screen.getByRole('button', { name: 'Back' }).props.accessibilityState).toMatchObject({ disabled: false })
        await press('Back')
        expect(await screen.findByRole('button', { name: 'Stop reading' })).toBeTruthy()
        await press('Keep reading')
        expect(view.getPathname()).toMatch(/^\/reading\//u)
        await act(async () => gate.resolve())
        await waitFor(() => expect(view.getPathname()).toMatch(/^\/check\//u))
        expect(await screen.findByText('Check what we read before you start building.')).toBeTruthy()
        expect(screen.getByTestId('quick-check-start').props.accessibilityLabel).toBe('Looks right')
        await press('Looks right')
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
        expect(await screen.findByText('2 of 2 steps marked done')).toBeTruthy()
        await press('Home')
        await waitFor(() => expect(view.getPathname()).toBe('/'))
    })

    it('composes the error screen for a failed check without hiding the cause or the way back', async () => {
        const { controller } = await mount([entry()], { replies: { failCheck: true } })
        await press('Continue building')
        await screen.findByText(/^Step 1 of \d+$/u)
        await press('Take photo')
        await act(async () => controller.shutter(async () => source))
        expect(await screen.findByText('We could not reach the checker. Try again.')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
        expect(controller.getSnapshot().check).toBeNull()
    })

    it('composes the answer and keeps the question, photo and held verdict', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        const gate = deferred<void>()
        let hold = false
        const { controller, view, store, server } = await mount([entry()], {
            screens: {
                generated: ['answer'],
                get gate() {
                    return hold ? gate.promise : undefined
                },
            },
        })
        await press('Continue building')
        await screen.findByText(/^Step 1 of \d+$/u)
        await press('Take photo')
        await act(async () => controller.shutter(async () => source))
        await loadPhoto()
        const resultImage = screen.getByTestId('frozen-photo-image')
        await act(async () => {
            controller.targetChanged({ kind: 'part', partId: 'side-panel' })
            controller.questionChanged('Which way?')
        })
        hold = true
        await act(async () => controller.ask())
        // Answer is a new workflow page on the Result's own, already loaded native photo: it has nothing to wait for.
        expect(await screen.findByRole('button', { name: 'Back to the guide' })).toBeTruthy()
        expect(screen.getByText('The groove faces inward.')).toBeTruthy()
        expect(screen.getByTestId('frozen-photo-image')).toBe(resultImage)
        expect(StyleSheet.flatten(resultImage.props.style).width).toBeGreaterThan(0)
        const heldPhoto = controller.getSnapshot().capture?.binding.captureId
        const answerRequest = server.requests.find((request) => request.op === 'generate' && request.kind === 'answer')!
        const answerInputs = inputsFromDocumentMetadata(answerRequest)
        const authored = store.peek(answerInputs)!
        expect(authored.document.metadata.authoring?.fixtureId).toBe('recorded-answer-layout-sol-v1')
        expect(authored.exactGeneration).toBe('pending')
        expect(store.readyAt(answerInputs)).toBeNull()
        await act(async () => jest.advanceTimersByTime(9_001))
        expect(hostCounts(view, 'guide-screen').generated).toBeGreaterThan(0)
        expect(screen.getByText('The groove faces inward.')).toBeTruthy()
        await act(async () => gate.resolve())
        await waitFor(() => expect(store.peek(answerInputs)?.exactGeneration).toBeUndefined())
        expect(store.peek(answerInputs)?.document.screenId).not.toBe(authored.document.screenId)
        expect(store.readyAt(answerInputs)).not.toBeNull()
        expect(
            server.requests.filter(
                (request) => request.op === 'generate' && request.contextKey === answerRequest.contextKey,
            ),
        ).toHaveLength(1)
        expect(controller.getSnapshot().capture?.binding.captureId).toBe(heldPhoto)
        await press('Back to the guide')
        await loadPhoto()
        expect((await screen.findAllByText('Looks right')).length).toBeGreaterThan(0)
        expect(controller.getSnapshot().answer?.answer).toBe('The groove faces inward.')
        expect(controller.getSnapshot().capture?.binding.captureId).toBe(heldPhoto)
        expect(controller.getSnapshot().check?.decision).toBe('pass')
        expect(controller.getSnapshot().question).toBe('Which way?')
    })

    // The Ask sheet over a checked, held photo, with the part and question chosen as the person leaves them before Ask.
    async function atAskSheet(replies: Replies): Promise<Mounted & { resultImage: TestInstance }> {
        const mounted = await mount([entry()], { screens: { generated: ['questions', 'answer'] }, replies })
        await press('Continue building')
        await screen.findByText(/^Step 1 of \d+$/u)
        await press('Take photo')
        await act(async () => mounted.controller.shutter(async () => source))
        await loadPhoto()
        const resultImage = screen.getByTestId('frozen-photo-image')
        await press('Ask about this step')
        await loadPhoto()
        await act(async () => {
            mounted.controller.targetChanged({ kind: 'part', partId: 'side-panel' })
            mounted.controller.questionChanged('Which way?')
        })
        return { ...mounted, resultImage }
    }
    const askSheet = (): ReturnType<typeof within> => within(screen.getByTestId('more-sheet'))

    it.each([
        ['Asking', false],
        ['Still thinking', true],
    ])(
        'closes the Ask sheet as its answer arrives after %s, never showing the composer or Ask again',
        async (pending, ticket) => {
            jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
            const gate = deferred<void>()
            const { controller, calls, resultImage } = await atAskSheet({
                question_gate: gate.promise,
                question_ticket: ticket,
            })
            const heldPhoto = controller.getSnapshot().capture?.binding.captureId
            await fireEvent.press(askSheet().getByRole('button', { name: 'Ask' }))
            await flush()
            // A ticketed question is collected after the server's own wait; either way its answer is held until released.
            if (ticket) await act(async () => jest.advanceTimersByTimeAsync(500))
            await flush()
            expect(controller.getSnapshot().pending).toMatch(new RegExp(`^${pending}`, 'u'))
            expect(askSheet().queryByRole('button', { name: 'Ask' })).toBeNull()

            await act(async () => gate.resolve())
            await flush()
            // Timers are held at the sheet's own closing boundary. The answer is complete and the composer is gone.
            expect(controller.getSnapshot().answer?.answer).toBe('The groove faces inward.')
            expect(controller.getSnapshot().pending).toBeNull()
            expect(screen.queryByRole('button', { name: 'Ask', includeHiddenElements: true })).toBeNull()
            expect(screen.queryByTestId('more-sheet')).toBeNull()
            await act(async () => jest.advanceTimersByTime(400))
            expect(screen.queryByTestId('more-sheet')).toBeNull()

            // The Answer is its own page, shown on the Result's loaded native photo from under the sheet, and nothing was
            // asked twice.
            expect(await screen.findByRole('button', { name: 'Back to the guide' })).toBeTruthy()
            expect(screen.getByText('The groove faces inward.')).toBeTruthy()
            expect(screen.getByTestId('frozen-photo-image')).toBe(resultImage)
            expect(StyleSheet.flatten(resultImage.props.style).width).toBeGreaterThan(0)
            expect(calls.filter((path) => path === '/api/questions')).toHaveLength(1)
            expect(calls.filter((path) => path === '/api/questions/result')).toHaveLength(ticket ? 1 : 0)
            expect(controller.getSnapshot().capture?.binding.captureId).toBe(heldPhoto)
            expect(controller.getSnapshot().question).toBe('Which way?')
        },
    )

    it('keeps the sheet’s own closing motion for the person’s Close while the question waits', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        const gate = deferred<void>()
        const { controller } = await atAskSheet({ question_gate: gate.promise })
        await fireEvent.press(askSheet().getByRole('button', { name: 'Ask' }))
        await flush()
        await fireEvent.press(askSheet().getByTestId('close-sheet'))
        expect(screen.getByTestId('more-sheet')).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(150))
        expect(screen.queryByTestId('more-sheet')).toBeNull()
        // The answer still lands on its own page afterwards; the closed sheet does not come back for it.
        await act(async () => gate.resolve())
        await flush()
        expect(controller.getSnapshot().answer?.answer).toBe('The groove faces inward.')
        expect(screen.queryByTestId('more-sheet')).toBeNull()
        await loadPhoto()
        expect(await screen.findByText('The groove faces inward.')).toBeTruthy()
    })

    it.each(['ready', 'close'] as const)(
        'keeps the first Answer handoff photo until %s owns the transition',
        async (transition) => {
            if (transition === 'close') jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
            const gate = deferred<void>()
            const { controller, calls } = await mount([entry()], {
                screens: { generated: ['questions', 'answer'] },
                replies: { question_gate: gate.promise },
            })
            await press('Continue building')
            await screen.findByText(/^Step 1 of \d+$/u)
            // Ask directly from the Guide: there is no checked Result image for the new Answer page to inherit.
            await press('Ask about this step')
            await act(async () => controller.shutter(async () => source))
            await screen.findByTestId('more-sheet')
            await loadPhoto()
            const questionImage = askSheet().getByTestId('frozen-photo-image')
            const captureId = controller.getSnapshot().capture!.binding.captureId
            expect(controller.getSnapshot().check).toBeNull()
            await act(async () => {
                controller.targetChanged({ kind: 'part', partId: 'side-panel' })
                controller.questionChanged('Which way?')
            })
            await fireEvent.press(askSheet().getByRole('button', { name: 'Ask' }))
            await act(async () => gate.resolve())
            await waitFor(() => expect(controller.getSnapshot().answer?.answer).toBe('The groove faces inward.'))
            expect(controller.getSnapshot().pending).toBeNull()
            expect(screen.queryByRole('button', { name: 'Ask', includeHiddenElements: true })).toBeNull()
            expect(screen.getByTestId('more-sheet')).toBeTruthy()
            expect(askSheet().getByTestId('frozen-photo-image')).toBe(questionImage)
            expect(StyleSheet.flatten(questionImage.props.style).width).toBeGreaterThan(0)

            // The native Modal hides the page from accessibility queries, but its real image layout/load events still
            // arrive underneath it. Include that hidden subtree only to deliver those native image events.
            const answerPage = within(screen.getByTestId('guide-screen', { includeHiddenElements: true }))
            expect(answerPage.queryByText('The groove faces inward.', { includeHiddenElements: true })).toBeNull()
            if (transition === 'close') await fireEvent.press(askSheet().getByTestId('close-sheet'))
            await fireEvent(answerPage.getByTestId('frozen-photo-frame', { includeHiddenElements: true }), 'layout', {
                nativeEvent: { layout: { width: 390, height: 460, x: 0, y: 0 } },
            })
            await fireEvent(answerPage.getByTestId('frozen-photo-image', { includeHiddenElements: true }), 'load')
            if (transition === 'close') {
                expect(screen.getByTestId('more-sheet')).toBeTruthy()
                expect(screen.queryByRole('button', { name: 'Ask', includeHiddenElements: true })).toBeNull()
                await act(async () => jest.advanceTimersByTime(150))
            }
            await waitFor(() => expect(screen.queryByTestId('more-sheet')).toBeNull())
            expect(screen.getByText('The groove faces inward.')).toBeTruthy()
            expect(screen.getByRole('button', { name: 'Back to the guide' })).toBeEnabled()
            expect(calls.filter((path) => path === '/api/questions')).toHaveLength(1)
            expect(calls.filter((path) => path === '/api/checks')).toHaveLength(0)
            expect(controller.getSnapshot().capture?.binding.captureId).toBe(captureId)
            expect(controller.getSnapshot().question).toBe('Which way?')
        },
    )

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
                arrange: (proposal: ScreenProposalV2, inputs: ScreenContextInputsV2): ScreenProposalV2 => {
                    const required = new Set(documentMaterialV2(inputs).requirements.facts)
                    const omit = (node: ScreenNodeV2): ScreenNodeV2 =>
                        'children' in node
                            ? {
                                  ...node,
                                  children: node.children
                                      .filter(
                                          (child) =>
                                              child.type !== 'Text' ||
                                              child.content.kind !== 'fact' ||
                                              !required.has(child.content.factId),
                                      )
                                      .map(omit),
                              }
                            : node
                    return { ...proposal, body: omit(proposal.body) }
                },
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

    it('keeps safety visible once in the complete local document when generation is off', async () => {
        const { view } = await mount([classified()], { screens: 'off' })
        await press('Continue building')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        expect(screen.queryByTestId('mandatory-fact')).toBeNull()
        expect(screen.getAllByText(WARNING)).toHaveLength(1)
    })
})

describe('an expired composition stays unavailable until explicitly retried', () => {
    it('keeps the HTTP deadline through blur and refocus, rejects the late response, and recovers after Try again', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        const gate = deferred<void>()
        const { view, server, store } = await mount([entry()], {
            screens: { generated: ['home', 'guide'], gate: gate.promise },
            recordings: 'off',
        })
        await act(async () => jest.advanceTimersByTime(4_000))
        await testRouter.push('/guide/flow-manual')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        await act(async () => jest.advanceTimersByTime(20_000))
        expect(
            within(screen.getByTestId('library-screen', { hidden: true })).getByText(STATE_COPY_V2.pending.heading, {
                hidden: true,
            }),
        ).toBeTruthy()
        await testRouter.back('/')
        await waitFor(() => expect(view.getPathname()).toBe('/'))
        const timeoutMs = screenStageV2('home') === 'step-page' ? MODEL_STEP_PAGE_TIMEOUT_MS : MODEL_SCREEN_TIMEOUT_MS
        const expired = server.requests
            .filter((request) => request.op === 'generate' && request.kind === 'home')
            .at(-1)!
        const attempts = (): typeof server.requests =>
            server.requests.filter((request) => request.op === 'generate' && request.contextKey === expired.contextKey)
        await act(async () => jest.advanceTimersByTime(timeoutMs - 24_001))
        expect(screen.getByText(STATE_COPY_V2.pending.heading)).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(2))
        await flush()
        expect(screen.getByText('That took too long')).toBeTruthy()
        await act(async () => gate.resolve())
        await flush()
        expect(hostCounts(view, 'library-screen').generated).toBe(0)
        expect(store.peek(inputsFromDocumentMetadata(expired))?.document.metadata.fallbackReason).toBe('timeout')
        await testRouter.push('/guide/flow-manual')
        await waitFor(() => expect(view.getPathname()).toBe('/guide/flow-manual'))
        await testRouter.back('/')
        await waitFor(() => expect(view.getPathname()).toBe('/'))
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
        expect(attempts()).toHaveLength(1)
        await press('Try again')
        expect(await screen.findByRole('button', { name: 'Continue building' })).toBeTruthy()
        expect(attempts()).toHaveLength(2)
        expect(attempts()[1]!.requestId).not.toBe(expired.requestId)
        await waitFor(() => expect(hostCounts(view, 'library-screen').generated).toBeGreaterThan(0))
    })
})
