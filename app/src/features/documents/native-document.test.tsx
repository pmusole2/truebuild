import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { spies } from '../../ui/test-support/reanimated-mock'
import { StrictMode, useEffect, type ReactElement } from 'react'
import type * as ReactModule from 'react'
import type * as ReactNativeModule from 'react-native'
import {
    AccessibilityInfo,
    Dimensions,
    PanResponder,
    Platform,
    ScrollView,
    StyleSheet,
    View,
    type GestureResponderEvent,
    type PanResponderGestureState,
} from 'react-native'
import type { TestInstance } from 'test-renderer'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    waitCopyV2,
    STATE_COPY_V2,
    SCREEN_KINDS_V2,
    documentMaterialV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    syntheticAuthorV2Schema,
    syntheticDocumentFactsV2,
    manualSessionSchema,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    type ScreenDocumentV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import { pieceIdsByPartId } from '../pieces/piece-registry'
import legacyHome from '../../../../packages/contracts/src/fixtures/prompt39/recorded-home.proposal.json'
import legacyHomeInputs from '../../../../packages/contracts/src/fixtures/prompt39/recorded-home.inputs.json'
import legacyHomeRuntime from '../../../../packages/contracts/src/fixtures/prompt39/recorded-home.runtime.json'
import legacySaving from '../../../../packages/contracts/src/fixtures/prompt39/recorded-home-saving.proposal.json'
import legacySavingInputs from '../../../../packages/contracts/src/fixtures/prompt39/recorded-home-saving.inputs.json'
import legacySavingRuntime from '../../../../packages/contracts/src/fixtures/prompt39/recorded-home-saving.runtime.json'
import { cropFor, placeCrop } from '../capture/step-picture'
import { space } from '../../theme/tokens'
import { partSourceRefs } from '../screens/part-source'
import { captureUiState, homeUiState } from '../screens/ui-state'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider, type HapticPort } from '../../ui/feedback'
import { DocumentRenderer } from './document-renderer'
import { capturePlacement } from './capture-placement'
import { sha256Hex } from './sha256'
import type { FrameBindings } from './types'
import { entry, runtime, source } from '../screens/test-support/route-harness'
import { defaultNav } from '../capture/screen-nav'
import { resolveCameraCapture } from '../capture/essential-controls'
import { parseNativeMeterMarkers } from '../../ui/native-meter-markers'
import { recordedDocumentForTest } from './recorded/test-support'
import { recordedDocument } from '../document-runtime/recorded-runtime'

jest.mock('../pieces/piece-gl', () => ({
    loadPieceGL: async (): Promise<{ default: () => ReactElement }> => ({
        default: function TestGLSurface(): ReactElement {
            const React = jest.requireActual<typeof ReactModule>('react')
            const { View } = jest.requireActual<typeof ReactNativeModule>('react-native')
            return React.createElement(View, { testID: 'guide-piece-gl-surface' })
        },
    }),
}))

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

function wrap(child: ReactElement, haptics?: HapticPort): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion haptics={haptics}>
                {child}
            </FeedbackProvider>
        </ThemeProvider>
    )
}
function compose(
    inputs: ScreenContextInputsV2,
    extras: ScreenNodeV2[] = [],
    source: 'generated' | 'fallback' = 'generated',
): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs, false)
    const proposal = buildFallbackProposalV2(material)
    return screenDocumentV2Schema.parse(
        assembleDocumentV2(
            material,
            {
                ...proposal,
                body:
                    extras.length === 0
                        ? proposal.body
                        : { type: 'Stack', gap: 'md', align: 'stretch', children: [...extras, proposal.body] },
            },
            { source, evidence: 'synthetic-fixture', fallbackReason: source === 'generated' ? null : 'disabled' },
            { sha256Hex, now: () => new Date('2026-10-29T00:00:00Z') },
        ),
    )
}
async function setup(
    capture = false,
    noParts = false,
): Promise<
    Awaited<ReturnType<typeof runtime>> & {
        bindings: FrameBindings
        inputs: ScreenContextInputsV2
        run: ReturnType<typeof jest.fn>
    }
> {
    const seeded = entry()
    if (noParts) {
        seeded.session.parts = []
        seeded.session.rawExtraction = null
        seeded.session.reviewedSteps.forEach((step) => {
            step.parts = []
            step.kind = 'adjust'
            step.requirements = { orientation: false, connection: false, visibleChecks: false }
            step.orientation = { state: 'unknown', reason: 'Not required.' }
            step.connection = { state: 'unknown', reason: 'Not required.' }
            step.visibleChecks = []
            step.correction = null
        })
        manualSessionSchema.parse(seeded.session)
    }
    const ports = await runtime([seeded])
    await ports.controller.restore()
    await ports.controller.open(seeded.session.manualId, 'guide')
    if (capture) {
        ports.controller.camera({ kind: noParts ? 'question' : 'check' })
        await ports.controller.shutter(async () => source)
    }
    const state = ports.controller.getSnapshot()
    const selected = ports.controller.current!
    const more = { open: false, mode: 'details' as const, show: (): void => undefined, hide: (): void => undefined }
    const nav = defaultNav(ports.controller)
    const run = jest.fn()
    const bindings: FrameBindings = {
        resolve: () => ({ enabled: true, reason: null, run }),
        session: selected.session,
        live: { state, entry: selected, controller: ports.controller, nav, more },
        pageUris: state.pageUris,
        capture: state.capture,
        marks: [],
        heroMode: 'inline',
        inspect: false,
    }
    const inputs: ScreenContextInputsV2 = {
        kind: capture ? 'result' : 'guide',
        session: selected.session,
        stepId: selected.session.reviewedSteps[0]!.stepId,
        captureId: state.capture?.binding.captureId ?? null,
        result: state.check === null ? null : { kind: 'check', value: state.check },
        failure: null,
    }
    return { ...ports, bindings, inputs, run }
}

const HELD_ANSWER = 'Seat the divider with its groove side down.'
/** The model-authored Result and Answer pages the app publishes for one held photo, and the bindings that hold each. */
function heldPages(
    inputs: ScreenContextInputsV2,
    bindings: FrameBindings,
): {
    result: ScreenDocumentV2
    answer: ScreenDocumentV2
    answerInputs: ScreenContextInputsV2
    answered: FrameBindings
} {
    const state = bindings.live!.state
    const question = 'Which way does the groove face?'
    const value = { answer: HELD_ANSWER, sourceRefs: state.check!.sourceRefs, missingEvidence: [] }
    const uiState = captureUiState(state)
    const answerInputs: ScreenContextInputsV2 = {
        ...inputs,
        kind: 'answer',
        result: { kind: 'question', question, value },
        uiState,
    }
    return {
        result: recordedDocument({ ...inputs, uiState })!,
        answer: recordedDocument(answerInputs)!,
        answerInputs,
        answered: {
            ...bindings,
            answeredQuestion: question,
            live: { ...bindings.live!, state: { ...state, answer: value, answeredQuestion: question } },
        },
    }
}
/** A valid composition of these inputs with every variant's body edited alike, so the held photo never moves. */
function composeEdited(inputs: ScreenContextInputsV2, edit: (body: ScreenNodeV2) => ScreenNodeV2): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs, false)
    const proposal = buildFallbackProposalV2(material)
    proposal.body = edit(proposal.body)
    for (const { name, variant } of variantsOfV2(proposal)) if (name !== 'ready') variant.body = edit(variant.body)
    return screenDocumentV2Schema.parse(
        assembleDocumentV2(
            material,
            proposal,
            { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
            { sha256Hex, now: () => new Date('2026-10-29T00:00:00Z') },
        ),
    )
}
/** Edits the children of the page's one stack, below its scroller. */
const inStack =
    (edit: (children: ScreenNodeV2[]) => ScreenNodeV2[]) =>
    (body: ScreenNodeV2): ScreenNodeV2 =>
        body.type === 'Scroll' && body.children[0]?.type === 'Stack'
            ? { ...body, children: [{ ...body.children[0], children: edit(body.children[0].children) }] }
            : body
/** The held photo one container deeper. */
const deeper = inStack((children) => [{ type: 'Card', surface: 'raised', padding: 'md', tone: 'neutral', children }])
/** One manual source opener right after the held photo: it lines up in every page and variant. */
const withOpener = inStack((children) => [
    children[0]!,
    { type: 'Citation', sources: [0], label: null, display: 'chip' },
    ...children.slice(1),
])
/** No scroller of its own: the renderer supplies the one its body scrolls in. */
const unscrolled = (body: ScreenNodeV2): ScreenNodeV2 =>
    body.type === 'Scroll' && body.children[0]?.type === 'Stack' ? body.children[0] : body
/** The photo's native frame measures itself and its native image finishes loading, as the device reports them. */
async function loadHeldPhoto(): Promise<void> {
    await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
        nativeEvent: { layout: { width: 300, height: 200 } },
    })
    await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
}
/** How often this document's ready variant was actually committed, as the native renderer reports it. */
const readyShown = (shown: jest.Mock, document: ScreenDocumentV2): number =>
    shown.mock.calls.filter(([candidate, state]) => candidate === document && state === 'ready').length
const bodyScroller = (): TestInstance =>
    screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
/** The ScrollView instance behind a rendered scroller host: the one a `scrollTo` call is made on. */
function scrollViewOf(host: TestInstance): unknown {
    for (let fiber = host.unstable_fiber; fiber !== null; fiber = fiber.return) {
        if (fiber.stateNode instanceof ScrollView) return fiber.stateNode
    }
    return undefined
}

describe('the actual v2 catalog renderer', () => {
    it.each(
        (['result', 'answer', 'questions'] as const).flatMap((kind) =>
            (['hero', 'wide', 'square', 'tall'] as const).map((ratio) => ({ kind, ratio })),
        ),
    )('keeps the whole held photo inside a tablet $kind $ratio frame at largest text', async ({ kind, ratio }) => {
        const previous = { window: Dimensions.get('window'), screen: Dimensions.get('screen') }
        const { inputs, bindings, controller } = await setup(true)
        Dimensions.set({
            window: { ...previous.window, width: 1032, fontScale: 3 },
            screen: { ...previous.screen, width: 1032, fontScale: 3 },
        })
        try {
            const photo = (node: ScreenNodeV2): ScreenNodeV2 =>
                node.type === 'Image' && node.source.kind === 'capture'
                    ? { ...node, fit: 'cover', ratio }
                    : 'children' in node
                      ? { ...node, children: node.children.map(photo) }
                      : node
            const photoInputs =
                kind === 'answer'
                    ? heldPages(inputs, bindings).answerInputs
                    : {
                          ...inputs,
                          kind,
                          ...(kind === 'questions'
                              ? { result: null, uiState: captureUiState(bindings.live!.state) }
                              : {}),
                      }
            const document = composeEdited(photoInputs, photo)
            await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 688, height: 560 } },
            })
            const frame = StyleSheet.flatten(screen.getByTestId('frozen-photo-frame').props.style)
            const image = StyleSheet.flatten(screen.getByTestId('frozen-photo-image').props.style)
            expect(frame.height).toBeCloseTo({ hero: 560, wide: 387, square: 688, tall: 917.3333333333 }[ratio])
            expect(image.left).toBeGreaterThanOrEqual(0)
            expect(image.top).toBeGreaterThanOrEqual(0)
            expect(image.left + image.width).toBeLessThanOrEqual(688)
            expect(image.top + image.height).toBeLessThanOrEqual(frame.height)
            expect(image.width / image.height).toBeCloseTo(
                bindings.capture!.observation.width / bindings.capture!.observation.height,
            )
        } finally {
            await act(async () => {
                Dimensions.set(previous)
                controller.dispose()
            })
        }
    })

    it('a pending check shows its actual bound photo without reuse permission and never exposes an old live verdict', async () => {
        const { inputs, bindings } = await setup(true)
        const pendingInputs: ScreenContextInputsV2 = {
            ...inputs,
            result: null,
            uiState: {
                capture: { captureId: inputs.captureId!, reusable: false, target: null, questionDraftPresent: false },
                busy: { activity: 'checking' },
            },
        }
        const document = recordedDocument(pendingInputs)!
        const shown = jest.fn()
        const capture = { ...bindings.capture!, reusable: false }
        await render(
            wrap(<DocumentRenderer document={document} bindings={{ ...bindings, capture, onVariantShown: shown }} />),
        )
        expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
        expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 400 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByTestId('frozen-photo-image').props.source.uri).toMatch(/^data:image\/jpeg;base64,/u)
        expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
        expect(shown).toHaveBeenLastCalledWith(document, 'pending')
        expect(screen.queryByRole('button', { name: 'Next step' })).toBeNull()
    })
    it('draws the photo-check scene under the one held photo while a Result is checking', async () => {
        const { inputs, bindings } = await setup(true)
        const checking = compose({ ...inputs, uiState: { ...inputs.uiState, busy: { activity: 'checking' } } })
        const live = bindings.live!
        await render(
            wrap(
                <DocumentRenderer
                    document={checking}
                    bindings={{
                        ...bindings,
                        live: { ...live, state: { ...live.state, pending: 'Checking frozen photo…' } },
                    }}
                    variant="busy"
                />,
            ),
        )
        expect(screen.getAllByTestId('frozen-photo-image')).toHaveLength(1)
        expect(await screen.findByTestId('blueprint-loader-check')).toBeTruthy()
        const thumbnail = screen.getByTestId('blueprint-loader-check').queryAll((node) => node.type === 'RNSVGImage')
        expect(thumbnail).toHaveLength(1)
        expect(thumbnail[0]!.props.src.uri).toBe(screen.getByTestId('frozen-photo-image').props.source.uri)
        expect(screen.queryByRole('progressbar')).toBeNull()
    })

    it('uses the screen scene while a Result document is prepared after the photo check has finished', async () => {
        const { inputs, bindings } = await setup(true)
        await render(wrap(<DocumentRenderer document={compose(inputs)} bindings={bindings} variant="pending" />))
        expect(await screen.findByTestId('blueprint-loader-screen')).toBeTruthy()
        expect(screen.queryByTestId('blueprint-loader-check')).toBeNull()
    })

    it.each([
        ['guide', 'working', false],
        ['answer', 'asking', true],
    ] as const)(
        'a waiting %s shows its build scene labelled by the contract wait copy, never a count of finished steps',
        async (kind, activity, held) => {
            const { inputs, bindings } = await setup(held)
            const context = kind === 'answer' ? heldPages(inputs, bindings).answerInputs : inputs
            const waiting = compose({ ...context, kind, uiState: { ...context.uiState, busy: { activity } } })
            const copy = waitCopyV2(kind, activity)
            await render(
                wrap(
                    <DocumentRenderer
                        document={waiting}
                        bindings={{ ...bindings, busyActivity: activity, waitCopy: copy }}
                        variant="busy"
                    />,
                ),
            )
            expect(await screen.findByRole('header', { name: copy.heading })).toBeTruthy()
            expect(screen.queryByRole('progressbar')).toBeNull()
        },
    )

    it.each(SCREEN_KINDS_V2)(
        'a generic %s wait keeps its header and body at once, draws its screen scene only after 300ms, then removes it when ready',
        async (kind) => {
            const held = kind === 'result' || kind === 'answer'
            const { inputs, bindings } = await setup(held)
            const context = kind === 'answer' ? heldPages(inputs, bindings).answerInputs : inputs
            const copy = waitCopyV2(kind)
            const waitingBindings: FrameBindings = { ...bindings, waitCopy: copy }
            const waiting = compose({
                ...context,
                kind,
                uiState: { ...context.uiState, busy: { activity: 'working' } },
            })
            const ready = compose({ ...context, kind })
            jest.useFakeTimers()
            const announce = jest
                .spyOn(AccessibilityInfo, 'announceForAccessibility')
                .mockImplementation(() => undefined)
            announce.mockClear()
            try {
                const view = await render(
                    wrap(<DocumentRenderer document={waiting} bindings={waitingBindings} variant="busy" />),
                )
                if (held) await loadHeldPhoto()
                expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
                expect(screen.getAllByText(copy.heading)).toHaveLength(1)
                expect(announce).not.toHaveBeenCalled()
                await act(() => jest.advanceTimersByTime(299))
                expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
                expect(screen.getAllByText(copy.heading)).toHaveLength(1)
                await act(() => jest.advanceTimersByTime(1))
                expect(screen.getByTestId('blueprint-loader-screen')).toBeTruthy()
                expect(screen.getAllByRole('header', { name: copy.heading }).length).toBeGreaterThan(0)
                expect(
                    within(screen.getByTestId('blueprint-loader-screen')).queryByText(STATE_COPY_V2.pending.heading),
                ).toBeNull()
                expect(announce).toHaveBeenCalledTimes(1)
                expect(announce).toHaveBeenCalledWith(copy.heading)
                expect(spies.withRepeat).not.toHaveBeenCalled()
                await view.rerender(wrap(<DocumentRenderer document={ready} bindings={bindings} />))
                expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
                expect(screen.queryByText(copy.heading)).toBeNull()
            } finally {
                announce.mockRestore()
                jest.useRealTimers()
            }
        },
    )

    it.each([
        ['home', legacyHome, legacyHomeInputs, legacyHomeRuntime],
        ['saving', legacySaving, legacySavingInputs, legacySavingRuntime],
    ] as const)(
        'renders the genuine prompt39 %s fixture with current contract wait copy',
        async (_name, proposal, rawInputs, evidence) => {
            const { bindings } = await setup()
            const inputs = rawInputs as ScreenContextInputsV2
            const document = screenDocumentV2Schema.parse(
                assembleDocumentV2(
                    documentMaterialV2(inputs),
                    screenProposalV2Schema.parse(proposal),
                    syntheticDocumentFactsV2(syntheticAuthorV2Schema.parse(evidence.authoring)),
                    { sha256Hex, now: () => new Date(evidence.recordedAt) },
                ),
            )
            const before = JSON.stringify(document)
            const activity = inputs.uiState?.busy?.activity
            const copy = waitCopyV2(inputs.kind, activity)
            await render(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{ ...bindings, busyActivity: activity }}
                        variant="busy"
                    />,
                ),
            )
            expect(screen.getByRole('header', { name: copy.heading })).toBeTruthy()
            expect(screen.queryByText(/Working on it|One moment, please\.|Working…|Please wait/u)).toBeNull()
            expect(await screen.findByTestId('blueprint-loader-screen')).toBeTruthy()
            expect(within(screen.getByTestId('blueprint-loader-screen')).queryByText(copy.heading)).toBeNull()
            expect(JSON.stringify(document)).toBe(before)
        },
    )

    it('a wait under 300ms keeps the header, the held photo and the disabled primary bar on screen', async () => {
        const { inputs, bindings } = await setup(true)
        const answer = heldPages(inputs, bindings).answerInputs
        const waiting = compose({ ...answer, uiState: { ...answer.uiState, busy: { activity: 'asking' } } })
        const copy = waitCopyV2('answer', 'asking')
        const primary = waiting.states.busy!.bar.primary.label
        jest.useFakeTimers()
        try {
            const view = await render(
                wrap(
                    <DocumentRenderer
                        document={waiting}
                        bindings={{
                            ...bindings,
                            busyActivity: 'asking',
                            waitCopy: copy,
                            resolve: () => ({ enabled: false, reason: copy.action, run: (): void => undefined }),
                        }}
                        variant="busy"
                    />,
                ),
            )
            await loadHeldPhoto()
            for (const advance of [0, 299]) {
                await act(() => jest.advanceTimersByTime(advance))
                expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
                expect(screen.getAllByRole('header', { name: copy.heading }).length).toBeGreaterThan(0)
                expect(screen.getByTestId('frozen-photo-frame')).toBeTruthy()
                expect(within(screen.getByTestId('bottom-bar')).getAllByText(copy.action)).toHaveLength(1)
                expect(screen.getByRole('button', { name: primary, disabled: true })).toBeTruthy()
            }
            await view.rerender(wrap(<DocumentRenderer document={compose(answer)} bindings={bindings} />))
            await act(() => jest.advanceTimersByTime(1_000))
            expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
            expect(screen.getByTestId('frozen-photo-frame')).toBeTruthy()
            expect(screen.getByTestId('bottom-bar')).toBeTruthy()
        } finally {
            jest.useRealTimers()
        }
    })

    it.each([true, false])(
        'renders a delayed blueprint for a valid wait without a progress node (scroll: %s)',
        async (scrolled) => {
            const { inputs, bindings } = await setup()
            const copy = waitCopyV2('home')
            const context = { ...inputs, kind: 'home' as const }
            const document = composeEdited(context, (body) => {
                const withoutProgress = inStack((children) => children.filter((node) => node.type !== 'Progress'))(body)
                return scrolled ? withoutProgress : unscrolled(withoutProgress)
            })
            jest.useFakeTimers()
            try {
                const view = await render(
                    wrap(<DocumentRenderer document={document} bindings={bindings} variant="pending" />),
                )
                expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
                await act(() => jest.advanceTimersByTime(300))
                expect(screen.getAllByTestId('blueprint-loader-screen')).toHaveLength(1)
                expect(screen.getByRole('header', { name: copy.heading })).toBeTruthy()
                await view.rerender(wrap(<DocumentRenderer document={document} bindings={bindings} />))
                expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
            } finally {
                jest.useRealTimers()
            }
        },
    )

    it('keeps a ready screen while the app prepares the next one, then removes the small scene at once', async () => {
        const { inputs, bindings } = await setup()
        const ready = compose(inputs)
        const copy = waitCopyV2('pages', 'saving')
        const preparing: FrameBindings = { ...bindings, preparingDocument: true, waitCopy: copy }
        jest.useFakeTimers()
        try {
            const view = await render(wrap(<DocumentRenderer document={ready} bindings={preparing} />))
            expect(screen.queryByTestId('document-preparing-wait')).toBeNull()
            await act(() => jest.advanceTimersByTime(299))
            expect(screen.queryByTestId('document-preparing-wait')).toBeNull()
            await act(() => jest.advanceTimersByTime(1))
            expect(within(screen.getByTestId('document-preparing-wait')).getByText(copy.heading)).toBeTruthy()
            await view.rerender(wrap(<DocumentRenderer document={ready} bindings={bindings} />))
            expect(screen.queryByTestId('document-preparing-wait')).toBeNull()
        } finally {
            jest.useRealTimers()
        }
    })

    it('a wait that ends before 300ms never reveals the scene, even after its delay would have passed', async () => {
        const { inputs, bindings } = await setup()
        const waitingBindings: FrameBindings = { ...bindings, waitCopy: waitCopyV2('home') }
        const waiting = compose({ ...inputs, kind: 'home', uiState: { busy: { activity: 'working' } } })
        const ready = compose({ ...inputs, kind: 'home' })
        jest.useFakeTimers()
        try {
            const view = await render(
                wrap(<DocumentRenderer document={waiting} bindings={waitingBindings} variant="busy" />),
            )
            await act(() => jest.advanceTimersByTime(299))
            await view.rerender(wrap(<DocumentRenderer document={ready} bindings={bindings} />))
            await act(() => jest.advanceTimersByTime(1_000))
            expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
        } finally {
            jest.useRealTimers()
        }
    })

    it.each([false, true])(
        'removes a finished Guide wait immediately and preserves its scroller (reduced motion: %s)',
        async (reduceMotion) => {
            const { inputs, bindings } = await setup()
            const document = compose(inputs)
            const moving = (node: ReactElement): ReactElement => (
                <ThemeProvider>
                    <FeedbackProvider reduceMotion={reduceMotion}>{node}</FeedbackProvider>
                </ThemeProvider>
            )
            jest.useFakeTimers()
            try {
                const view = await render(
                    moving(<DocumentRenderer document={document} bindings={bindings} variant="busy" />),
                )
                const scroller = bodyScroller()
                expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
                await act(() => jest.advanceTimersByTime(300))
                expect(screen.getByTestId('blueprint-loader-screen')).toBeTruthy()
                spies.withTiming.mockClear()
                await view.rerender(moving(<DocumentRenderer document={document} bindings={bindings} />))
                if (reduceMotion) expect(spies.withTiming).not.toHaveBeenCalled()
                else expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 150 }))
                expect(bodyScroller()).toBe(scroller)
                expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
                expect(screen.queryByTestId('document-wait-transition')).toBeNull()
            } finally {
                jest.useRealTimers()
            }
        },
    )

    it('uses the selected variant heading despite stale bindings, and reserves title overrides for preparation', async () => {
        const { inputs, bindings } = await setup(true)
        const answer = heldPages(inputs, bindings).answerInputs
        const document = compose({ ...answer, uiState: { ...answer.uiState, busy: { activity: 'asking' } } })
        jest.useFakeTimers()
        try {
            const view = await render(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{ ...bindings, busyActivity: 'asking', waitCopy: waitCopyV2('pages', 'saving') }}
                        variant="busy"
                    />,
                ),
            )
            expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
            expect(screen.queryByText('Saving…')).toBeNull()
            await act(() => jest.advanceTimersByTime(300))
            expect(screen.getByTestId('blueprint-loader-screen')).toBeTruthy()
            expect(screen.queryByText('Saving…')).toBeNull()
            const opening = waitCopyV2('guide', null, 'Shelf unit')
            const guide = compose(inputs)
            await view.rerender(
                wrap(
                    <DocumentRenderer
                        document={guide}
                        bindings={{ ...bindings, preparingDocument: true, waitCopy: opening }}
                        variant="pending"
                    />,
                ),
            )
            expect(screen.queryByText(opening.heading)).toBeNull()
            await act(() => jest.advanceTimersByTime(300))
            expect(screen.getAllByText(opening.heading)).toHaveLength(1)
            expect(screen.queryByText(waitCopyV2('guide').heading)).toBeNull()
        } finally {
            jest.useRealTimers()
        }
    })

    it('resolves a listed body wait heading when a valid pending variant retains its ready header', async () => {
        const { inputs, bindings } = await setup()
        const document = compose({ ...inputs, kind: 'home', session: null, stepId: null })
        document.states.pending!.header.title = document.header.title
        jest.useFakeTimers()
        try {
            await render(wrap(<DocumentRenderer document={document} bindings={bindings} variant="pending" />))
            expect(screen.getAllByText(waitCopyV2('home').heading)).toHaveLength(1)
            expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
            await act(() => jest.advanceTimersByTime(300))
            expect(
                within(screen.getByTestId('blueprint-loader-screen')).queryByText(waitCopyV2('home').heading),
            ).toBeNull()
            expect(screen.getAllByText(waitCopyV2('home').heading)).toHaveLength(1)
        } finally {
            jest.useRealTimers()
        }
    })

    it('keeps bound manual text even when it matches the waiting header', async () => {
        const { inputs, bindings } = await setup()
        const heading = waitCopyV2('guide').heading
        inputs.session!.title = heading
        const document = composeEdited(inputs, (body) => ({
            type: 'Stack',
            gap: 'md',
            align: 'stretch',
            children: [
                {
                    type: 'Text',
                    content: { kind: 'bound', key: 'manual-title' },
                    role: 'body',
                    emphasis: 'normal',
                    tone: 'neutral',
                    align: 'start',
                },
                body,
            ],
        }))
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        jest.useFakeTimers()
        try {
            await render(wrap(<DocumentRenderer document={document} bindings={bindings} variant="pending" />))
            expect(screen.getAllByText(heading)).toHaveLength(2)
            await act(() => jest.advanceTimersByTime(300))
            expect(screen.getAllByText(heading)).toHaveLength(2)
        } finally {
            jest.useRealTimers()
        }
    })

    it('keeps a finished Completion’s own progress while a waiting one shows the build scene', async () => {
        const { inputs, bindings } = await setup()
        const completedStepIds = bindings.session!.reviewedSteps.map((step) => step.stepId)
        const completion = { ...inputs, kind: 'completion' as const, stepId: null, completedStepIds }
        const waiting = await render(
            wrap(
                <DocumentRenderer
                    document={compose({ ...completion, uiState: { busy: { activity: 'saving' } } })}
                    bindings={bindings}
                    variant="busy"
                />,
            ),
        )
        expect(await screen.findByTestId('blueprint-loader-screen')).toBeTruthy()
        expect(screen.queryByRole('progressbar')).toBeNull()
        await waiting.unmount()
        await render(wrap(<DocumentRenderer document={compose(completion)} bindings={bindings} />))
        expect(screen.queryByTestId('blueprint-loader-screen')).toBeNull()
        expect(screen.getByRole('progressbar')).toBeTruthy()
    })

    it.each([
        ['recorded-more-global', 'busy'],
        ['recorded-more-global', 'pending'],
        ['recorded-judge-global', 'busy'],
        ['recorded-judge-global', 'pending'],
    ] as const)('keeps the authored Close action usable in %s/%s', async (record, variant) => {
        const { bindings, run } = await setup()
        await render(
            wrap(
                <DocumentRenderer
                    document={recordedDocumentForTest(record)}
                    variant={variant}
                    bindings={{ ...bindings, session: undefined, workInProgress: true }}
                />,
            ),
        )
        const close = screen.getByRole('button', { name: 'Close' })
        expect(close).toBeEnabled()
        await fireEvent.press(close)
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('keeps the judge bar identity and honors a route-owned secondary identity', async () => {
        const { bindings, run } = await setup()
        const document = recordedDocumentForTest('recorded-more-global')
        const view = await render(
            wrap(<DocumentRenderer document={document} bindings={{ ...bindings, session: undefined }} />),
        )
        await fireEvent.press(screen.getByTestId('judge-entry'))
        expect(run).toHaveBeenCalledTimes(1)
        await view.rerender(
            wrap(
                <DocumentRenderer
                    document={document}
                    bindings={{ ...bindings, session: undefined, testIds: { secondary: 'existing-secondary' } }}
                />,
            ),
        )
        expect(screen.queryByTestId('judge-entry')).toBeNull()
        await fireEvent.press(screen.getByTestId('existing-secondary'))
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('blocks intrinsic mutations during document preparation while keeping Back available', async () => {
        const { bindings, inputs, controller, run } = await setup()
        const step = jest.spyOn(controller, 'step')
        const document = compose(inputs, [{ type: 'Stepper', binding: 'steps', label: null }])
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, workInProgress: true }} />))
        const next = screen.getByRole('button', { name: inputs.session!.reviewedSteps[1]!.title })
        expect(next.props.accessibilityState.disabled).toBe(true)
        await fireEvent.press(next)
        expect(step).not.toHaveBeenCalled()
        expect(screen.getByTestId('guide-primary').props.accessibilityState.disabled).toBe(true)
        await fireEvent.press(screen.getByRole('button', { name: /^Back$/u }))
        expect(run).toHaveBeenCalledTimes(1)
    })

    it.each(['ready', 'unavailable'] as const)(
        'ends a missing manual picture honestly after asset loading is %s',
        async (pageImageStatus) => {
            const { inputs, bindings } = await setup()
            await render(
                wrap(
                    <DocumentRenderer
                        document={compose(inputs)}
                        bindings={{ ...bindings, pageUris: {}, pageImageStatus }}
                    />,
                ),
            )
            expect(screen.getByText('This manual picture is unavailable.')).toBeTruthy()
            expect(screen.queryByTestId('guide-hero-frame')).toBeNull()
            await fireEvent.press(screen.getAllByRole('link', { name: 'See it in the manual' })[0]!)
            expect(screen.getAllByText('This manual picture is unavailable.')).toHaveLength(2)
        },
    )

    it('shows freshly parsed facts and parts even when stale reviewed data remains', async () => {
        const { inputs, bindings } = await setup()
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            reviewStatus: 'unreviewed',
            rawExtraction: {
                parts: inputs.session!.parts,
                steps: inputs.session!.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            },
            parts: inputs.session!.parts.map((part) => ({
                ...part,
                name: {
                    state: 'known',
                    value: 'Stale reviewed part',
                    sourceRefs: inputs.session!.pages.map((page) => ({ pageId: page.pageId, region: null })),
                },
            })),
            reviewedSteps: [{ ...inputs.session!.reviewedSteps[0]!, title: 'Stale reviewed instruction' }],
        })
        const document = compose(
            {
                kind: 'quick-check',
                session,
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                uiState: { review: { currentQuestion: null, blockers: 0, canConfirm: true } },
            },
            [{ type: 'Stepper', binding: 'steps', label: null }],
        )
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, session }} />))
        expect(screen.getByText('Side panel')).toBeTruthy()
        expect(screen.getByText('Divider shelf')).toBeTruthy()
        // The parts cite a page with no figure region: no whole-page picture is drawn for either tile.
        expect(screen.queryByTestId('part-hero-side-panel')).toBeNull()
        expect(screen.getByTestId('part-tile-divider')).toBeTruthy()
        expect(screen.queryByTestId('part-hero-divider')).toBeNull()
        // The same page is already cited by the step overview: one shared opener replaces repeated tile links.
        const sideTile = screen.getByTestId('part-tile-side-panel')
        expect(within(sideTile).queryByTestId('diagram-0')).toBeNull()
        expect(within(sideTile).queryByRole('link', { name: 'See it in the manual: Side panel' })).toBeNull()
        const openers = screen.getAllByRole('link', { name: /^See it in the manual(?:$|:)/u })
        expect(openers).toHaveLength(1)
        await fireEvent.press(openers[0]!)
        expect(screen.getByTestId('diagram-0')).toBeTruthy()
        expect(screen.getByText('Picture from your manual · Page 1')).toBeTruthy()
        expect(screen.getByRole('button', { name: inputs.session!.reviewedSteps[1]!.title })).toBeDisabled()
        expect(screen.queryByText('Stale reviewed instruction')).toBeNull()
        expect(screen.queryByText('Stale reviewed part')).toBeNull()
        expect(screen.queryByText(/^×/u)).toBeNull()
    })

    it('keeps a part-only page reachable when no other visible source opener cites it', async () => {
        const { inputs, bindings } = await setup()
        const original = inputs.session!
        const partPage = {
            ...original.pages[0]!,
            pageId: 'part-only-page',
            assetId: 'part-only-asset',
            contentHash: '2'.repeat(64),
        }
        const session = manualSessionSchema.parse({
            ...original,
            pages: [...original.pages, partPage],
            parts: original.parts.map((part) =>
                part.partId === 'side-panel'
                    ? {
                          ...part,
                          name: {
                              state: 'known',
                              value: 'Side panel',
                              sourceRefs: [{ pageId: partPage.pageId, region: null }],
                          },
                      }
                    : part,
            ),
        })
        await render(
            wrap(<DocumentRenderer document={compose({ ...inputs, session })} bindings={{ ...bindings, session }} />),
        )
        const tile = within(screen.getByTestId('part-tile-side-panel'))
        expect(tile.queryByTestId('part-hero-side-panel')).toBeNull()
        await fireEvent.press(tile.getByRole('link', { name: 'See it in the manual: Side panel' }))
        expect(tile.getByTestId('diagram-0')).toBeTruthy()
        expect(tile.getByText('Picture from your manual · Page 2')).toBeTruthy()
        expect(tile.getByRole('link', { name: 'Hide the manual page: Side panel' })).toBeTruthy()
    })

    it('uses the explicit part drawing instead of the name citation and hides crops without a drawing box', async () => {
        const { inputs, bindings } = await setup()
        const pageId = inputs.session!.pages[0]!.pageId
        const sideName = inputs.session!.parts.find((part) => part.partId === 'side-panel')?.name
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            parts: inputs.session!.parts.map((part) =>
                part.partId === 'side-panel'
                    ? {
                          ...part,
                          name: {
                              state: 'known' as const,
                              value: sideName?.state === 'known' ? sideName.value : 'Side panel',
                              sourceRefs: [{ pageId, region: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 } }],
                          },
                          drawingBox: [0.6, 0.2, 0.2, 0.3],
                      }
                    : {
                          ...part,
                          name:
                              part.name.state === 'known'
                                  ? {
                                        ...part.name,
                                        sourceRefs: [{ pageId, region: { x: 0.1, y: 0.7, width: 0.4, height: 0.04 } }],
                                    }
                                  : part.name,
                      },
            ),
        })
        const document = compose(
            {
                kind: 'quick-check',
                session,
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                uiState: { review: { currentQuestion: null, blockers: 0, canConfirm: true } },
            },
            [{ type: 'Stepper', binding: 'steps', label: null }],
        )
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, session }} />))
        const hero = screen.getByTestId('part-hero-side-panel')
        await fireEvent(hero, 'layout', { nativeEvent: { layout: { width: 300, height: 160 } } })
        const image = within(hero).getByLabelText('Picture from your manual')
        expect(StyleSheet.flatten(image.props.style)).toEqual(
            expect.objectContaining(
                placeCrop(
                    { width: 300, height: 100 },
                    session.pages[0]!,
                    cropFor({ x: 0.6, y: 0.2, width: 0.2, height: 0.3 }),
                ),
            ),
        )
        expect(screen.getByTestId('part-tile-divider')).toBeTruthy()
        expect(screen.queryByTestId('part-hero-divider')).toBeNull()
    })

    it('shows neither a picture nor a manual link when a part has no resolved citation', async () => {
        const { inputs, bindings } = await setup()
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            reviewStatus: 'unreviewed',
            rawExtraction: {
                parts: inputs.session!.parts.map((part) => ({
                    ...part,
                    name: { state: 'unknown' as const, reason: 'Unreadable.' },
                })),
                steps: inputs.session!.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            },
        })
        const document = compose(
            {
                kind: 'quick-check',
                session: inputs.session!,
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                uiState: { review: { currentQuestion: null, blockers: 0, canConfirm: true } },
            },
            [{ type: 'Stepper', binding: 'steps', label: null }],
        )
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, session }} />))
        expect(screen.queryByTestId('part-hero-side-panel')).toBeNull()
        const sideTile = screen.getByTestId('part-tile-side-panel')
        expect(within(sideTile).queryByRole('button', { name: /manual/u })).toBeNull()
        expect(within(sideTile).queryByTestId('diagram-0')).toBeNull()
    })

    it('never uses a reviewed-step index to select an unreviewed part quantity citation', async () => {
        const { inputs } = await setup()
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            reviewStatus: 'unreviewed',
            rawExtraction: {
                parts: inputs.session!.parts.map((part) => ({
                    ...part,
                    name: { state: 'unknown', reason: 'Unreadable.' },
                })),
                steps: inputs.session!.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            },
        })
        expect(partSourceRefs(session, 'side-panel', 0)).toEqual([])
    })

    it('preserves semantic text roles, selected layout tokens and own-path origins without v1 adaptation', async () => {
        const { inputs, bindings } = await setup()
        const document = compose(inputs, [
            {
                type: 'Text',
                content: { kind: 'literal', text: 'More' },
                role: 'heading',
                emphasis: 'normal',
                tone: 'caution',
                align: 'end',
            },
        ])
        await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        expect(screen.getByRole('header', { name: 'More' })).toBeTruthy()
        expect(screen.getByRole('header', { name: 'More' }).parent?.props.nativeID).toBe(
            'truebuild-render-origin:generated',
        )
        expect(screen.getByRole('header', { name: 'More' }).props.style).toEqual(
            expect.arrayContaining([expect.objectContaining({ textAlign: 'right' })]),
        )
        expect(screen.getByTestId('guide-primary').props.nativeID).toBe('truebuild-render-origin:generated')
    })

    it('uses the entire busy variant including its header and one fixed primary', async () => {
        const { inputs, bindings } = await setup()
        const document = compose(inputs)
        await render(wrap(<DocumentRenderer document={document} bindings={bindings} variant="busy" />))
        expect(screen.getAllByTestId('bottom-bar')).toHaveLength(1)
        expect((await screen.findByTestId('guide-primary')).props.nativeID).toBe(
            document.metadata.origins['states.busy.bar.primary'] === 'generated'
                ? 'truebuild-render-origin:generated'
                : 'truebuild-render-origin:fallback',
        )
        expect(await screen.findByText(waitCopyV2('guide').action)).toBeTruthy()
    })

    it('keeps the uncapped header copy in a wrapping, non-scrolling persistent native view', async () => {
        const { inputs, bindings } = await setup()
        await render(wrap(<DocumentRenderer document={compose(inputs)} bindings={bindings} />))
        const header = screen.getByTestId('document-header-copy')
        expect(header.type).toBe('View')
        expect(StyleSheet.flatten(header.props.style)).not.toEqual(
            expect.objectContaining({ maxHeight: expect.anything() }),
        )
        expect(header.queryAll((node) => node.type === 'RCTScrollView')).toHaveLength(0)
        expect(header.queryAll((node) => node.props.maxFontSizeMultiplier === 0).length).toBeGreaterThan(0)
    })

    it.each([
        { label: 'a legacy Guide with no stepActions echo', legacy: true, shown: 1 },
        { label: 'a numbered Guide with the stepActions echo', legacy: false, shown: 1 },
    ])('guards duplicate bound titles and subtitles only for $label', async ({ legacy, shown }) => {
        const { inputs, bindings } = await setup()
        const document = compose(inputs, [
            {
                type: 'Text',
                content: { kind: 'bound', key: 'step-title' },
                role: 'body',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            },
        ])
        const direction = inputs.session!.reviewedSteps[0]!.title
        document.header.subtitle = { kind: 'literal', text: direction }
        if (legacy) delete document.metadata.stepActions
        await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        expect(screen.getAllByText(direction)).toHaveLength(shown)
    })

    it('shows Guide directions and Home resume copy once, with room below the final Guide piece', async () => {
        const { inputs, bindings } = await setup()
        const document = compose(inputs)
        const direction = inputs.session!.reviewedSteps[0]!.title
        // The contracts author the saved title once as its fallback direction; the renderer does not infer duplicates.
        const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        expect(screen.getAllByText(direction)).toHaveLength(1)
        await fireEvent(screen.getByTestId('bottom-bar'), 'layout', {
            nativeEvent: { layout: { width: 390, height: 128 } },
        })
        expect(StyleSheet.flatten(bodyScroller().props.contentContainerStyle).paddingBottom).toBe(space.md + 128)

        const homeInputs = {
            ...inputs,
            kind: 'home' as const,
            stepId: null,
            uiState: homeUiState(bindings.live!.state.entries),
        }
        await view.rerender(wrap(<DocumentRenderer document={compose(homeInputs)} bindings={bindings} />))
        expect(screen.queryByText('Pick up where you left off.')).toBeNull()
        expect(screen.getByText("What's next")).toBeTruthy()
    })

    it.each(['kind', 'manual', 'step', 'result capture', 'answer capture'] as const)(
        'starts a fresh native body scroller when the workflow page changes its %s',
        async (change) => {
            const { inputs, bindings } = await setup(true)
            const held = change.endsWith('capture')
            const initial: ScreenContextInputsV2 = {
                ...inputs,
                kind: change === 'answer capture' ? 'answer' : held ? 'result' : 'guide',
                captureId: held ? inputs.captureId : null,
                result:
                    change === 'answer capture'
                        ? {
                              kind: 'question',
                              question: 'Which way does the groove face?',
                              value: {
                                  answer: 'The groove faces inward.',
                                  sourceRefs: bindings.live!.state.check!.sourceRefs,
                                  missingEvidence: [],
                              },
                          }
                        : held
                          ? inputs.result
                          : null,
            }
            const next: ScreenContextInputsV2 =
                change === 'kind'
                    ? inputs
                    : change === 'manual'
                      ? { ...initial, session: { ...initial.session!, manualId: 'next-manual' } }
                      : change === 'step'
                        ? { ...initial, stepId: initial.session!.reviewedSteps[1]!.stepId }
                        : { ...initial, captureId: 'next-capture' }
            const extras: ScreenNodeV2[] =
                change === 'step' ? [{ type: 'Icon', name: 'info', size: 'sm', tone: 'neutral' }] : []
            const view = await render(
                wrap(<DocumentRenderer document={compose(initial, extras)} bindings={bindings} />),
            )
            const body = screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
            const header = screen.getByTestId('document-header-copy')
            const bar = screen.getByTestId('bottom-bar')
            await fireEvent.scroll(body, { nativeEvent: { contentOffset: { x: 0, y: 500 } } })
            await view.rerender(wrap(<DocumentRenderer document={compose(next, extras)} bindings={bindings} />))
            expect(screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]).not.toBe(
                body,
            )
            expect(screen.getByTestId('document-header-copy')).toBe(header)
            expect(screen.getByTestId('bottom-bar')).toBe(bar)
            if (change === 'kind') {
                expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
                expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            }
        },
    )

    it('keeps the native scroller and an open local disclosure across a new composition of the same page', async () => {
        const { inputs, bindings } = await setup()
        const section: ScreenNodeV2 = {
            type: 'Section',
            title: { kind: 'bound', key: 'manual-title' },
            collapsible: true,
            initiallyOpen: false,
            children: [
                {
                    type: 'Text',
                    content: { kind: 'literal', text: 'More' },
                    role: 'caption',
                    emphasis: 'normal',
                    tone: 'neutral',
                    align: 'start',
                },
            ],
        }
        const fallback = compose(inputs, [section], 'fallback')
        const generated = compose(inputs, [section])
        expect(fallback.screenId).not.toBe(generated.screenId)
        const view = await render(wrap(<DocumentRenderer document={fallback} bindings={bindings} />))
        const body = screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
        const disclosure = screen.getByRole('button', { name: inputs.session!.title })
        await fireEvent.press(disclosure)
        expect(disclosure.props.accessibilityState.expanded).toBe(true)
        await view.rerender(wrap(<DocumentRenderer document={generated} bindings={bindings} />))
        expect(screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]).toBe(body)
        expect(screen.getByRole('button', { name: inputs.session!.title }).props.accessibilityState.expanded).toBe(true)
    })

    describe('a held photo shared by its Result and its Answer', () => {
        const scrollTo = jest.mocked(ScrollView.prototype.scrollTo)
        beforeEach(() => scrollTo.mockClear())

        it('keeps the loaded native image, its measured frame and its earned reveal across the published Result and Answer', async () => {
            const { inputs, bindings } = await setup(true)
            const { result, answer, answered } = heldPages(inputs, bindings)
            const reason = bindings.live!.state.check!.reason
            const view = await render(wrap(<DocumentRenderer document={result} bindings={bindings} />))
            await loadHeldPhoto()
            expect(screen.getByText(reason)).toBeTruthy()
            const frame = screen.getByTestId('frozen-photo-frame')
            const image = screen.getByTestId('frozen-photo-image')
            expect(StyleSheet.flatten(image.props.style).width).toBeGreaterThan(0)

            // Nothing is measured or loaded again: the same native image still holds the photo, and still has its size.
            await view.rerender(wrap(<DocumentRenderer document={answer} bindings={answered} />))
            expect(screen.getByTestId('frozen-photo-frame')).toBe(frame)
            expect(screen.getByTestId('frozen-photo-image')).toBe(image)
            expect(StyleSheet.flatten(image.props.style).width).toBeGreaterThan(0)
            expect(StyleSheet.flatten(image.props.style).height).toBeGreaterThan(0)
            expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
            expect(screen.queryByText(reason)).toBeNull()

            // Back to the guide is the same page change in reverse.
            await view.rerender(wrap(<DocumentRenderer document={result} bindings={bindings} />))
            expect(screen.getByTestId('frozen-photo-image')).toBe(image)
            expect(screen.getByText(reason)).toBeTruthy()
            expect(screen.queryByText(HELD_ANSWER)).toBeNull()
        })

        it('starts the Answer at the top of the Result’s own scroller', async () => {
            const { inputs, bindings } = await setup(true)
            const { result, answer, answered } = heldPages(inputs, bindings)
            const view = await render(wrap(<DocumentRenderer document={result} bindings={bindings} />))
            await loadHeldPhoto()
            const body = bodyScroller()
            expect(scrollTo).not.toHaveBeenCalled()

            await view.rerender(wrap(<DocumentRenderer document={answer} bindings={answered} />))
            expect(bodyScroller()).toBe(body)
            expect(scrollTo).toHaveBeenCalledTimes(1)
            expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false })
            expect(scrollTo.mock.contexts[0]).toBe(scrollViewOf(body))
        })

        it('starts the Answer at the top of the scroller the renderer supplies for a body without one', async () => {
            const { inputs, bindings } = await setup(true)
            const { answerInputs, answered } = heldPages(inputs, bindings)
            const result = composeEdited(inputs, unscrolled)
            const answer = composeEdited(answerInputs, unscrolled)
            const view = await render(wrap(<DocumentRenderer document={result} bindings={bindings} />))
            await loadHeldPhoto()
            const body = bodyScroller()
            const image = screen.getByTestId('frozen-photo-image')
            expect(scrollTo).not.toHaveBeenCalled()

            await view.rerender(wrap(<DocumentRenderer document={answer} bindings={answered} />))
            expect(bodyScroller()).toBe(body)
            expect(screen.getByTestId('frozen-photo-image')).toBe(image)
            expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
            expect(scrollTo).toHaveBeenCalledTimes(1)
            expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false })
            expect(scrollTo.mock.contexts[0]).toBe(scrollViewOf(body))
        })

        it('closes the Details section the person opened on the Result when the Answer arrives', async () => {
            const { inputs, bindings } = await setup(true)
            // A step with an explicit safety classification keeps its optional directions behind one Details section.
            inputs.session!.reviewedSteps[0]!.safetyNotes = []
            const { result, answer, answered } = heldPages(inputs, bindings)
            const view = await render(wrap(<DocumentRenderer document={result} bindings={bindings} />))
            await loadHeldPhoto()
            const image = screen.getByTestId('frozen-photo-image')
            await fireEvent.press(screen.getByRole('button', { name: 'Details' }))
            expect(screen.getByRole('button', { name: 'Details' }).props.accessibilityState.expanded).toBe(true)

            await view.rerender(wrap(<DocumentRenderer document={answer} bindings={answered} />))
            expect(screen.getByTestId('frozen-photo-image')).toBe(image)
            expect(screen.getByRole('button', { name: 'Details' }).props.accessibilityState.expanded).toBe(false)
        })

        it.each(['published', 'composed'] as const)(
            'closes the manual source the person opened on the Result when the %s Answer arrives',
            async (pages) => {
                const { inputs, bindings } = await setup(true)
                const held = heldPages(inputs, bindings)
                const [result, answer] =
                    pages === 'published' ? [held.result, held.answer] : [compose(inputs), compose(held.answerInputs)]
                const view = await render(wrap(<DocumentRenderer document={result} bindings={bindings} />))
                await loadHeldPhoto()
                const openers = (): TestInstance[] => screen.getAllByRole('link', { name: 'See it in the manual' })
                const image = screen.getByTestId('frozen-photo-image')
                for (const opener of openers()) await fireEvent.press(opener)
                expect(openers().map((opener) => opener.props.accessibilityState.expanded)).not.toContain(false)

                await view.rerender(wrap(<DocumentRenderer document={answer} bindings={held.answered} />))
                expect(screen.getByTestId('frozen-photo-image')).toBe(image)
                expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
                expect(openers().map((opener) => opener.props.accessibilityState.expanded)).not.toContain(true)
            },
        )

        it('starts a source opener of the Answer closed even where it lines up with the one opened on the Result', async () => {
            const { inputs, bindings } = await setup(true)
            const { answerInputs, answered } = heldPages(inputs, bindings)
            const result = composeEdited(inputs, withOpener)
            const answer = composeEdited(answerInputs, withOpener)
            const view = await render(wrap(<DocumentRenderer document={result} bindings={bindings} />))
            await loadHeldPhoto()
            const opener = (): TestInstance => screen.getAllByRole('link', { name: 'See it in the manual' })[0]!
            await fireEvent.press(opener())
            expect(opener().props.accessibilityState.expanded).toBe(true)
            const image = screen.getByTestId('frozen-photo-image')

            await view.rerender(wrap(<DocumentRenderer document={answer} bindings={answered} />))
            expect(screen.getByTestId('frozen-photo-image')).toBe(image)
            expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
            expect(opener().props.accessibilityState.expanded).toBe(false)
        })

        it('leaves the scroller where it is for another composition and variant of the same page', async () => {
            const { inputs, bindings } = await setup(true)
            const { answer, answerInputs, answered } = heldPages(inputs, bindings)
            const view = await render(wrap(<DocumentRenderer document={answer} bindings={answered} />))
            await loadHeldPhoto()
            const body = bodyScroller()
            const recomposed = compose(answerInputs, [], 'fallback')
            expect(recomposed.screenId).not.toBe(answer.screenId)
            await view.rerender(wrap(<DocumentRenderer document={recomposed} bindings={answered} />))
            await view.rerender(wrap(<DocumentRenderer document={recomposed} bindings={answered} variant="busy" />))
            expect(bodyScroller()).toBe(body)
            expect(scrollTo).not.toHaveBeenCalled()
        })

        it('never gates the loaded held photo again when a compatible composition replaces the shown Answer', async () => {
            const { inputs, bindings } = await setup(true)
            const { answerInputs, answered } = heldPages(inputs, bindings)
            const first = compose(answerInputs)
            const second = composeEdited(answerInputs, withOpener)
            // Another document, the same mounted native image: only the content around the photo differs.
            expect(second.screenId).not.toBe(first.screenId)
            expect(capturePlacement(second)).toBe(capturePlacement(first))
            const shown = jest.fn()
            const view = await render(
                wrap(<DocumentRenderer document={first} bindings={{ ...answered, onVariantShown: shown }} />),
            )
            await loadHeldPhoto()
            const image = screen.getByTestId('frozen-photo-image')
            expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
            shown.mockClear()

            await view.rerender(
                wrap(<DocumentRenderer document={second} bindings={{ ...answered, onVariantShown: shown }} />),
            )
            expect(screen.getByTestId('frozen-photo-image')).toBe(image)
            expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
            const states = shown.mock.calls.filter(([candidate]) => candidate === second).map(([, state]) => state)
            expect(states).not.toContain('pending')
            expect(readyShown(shown, second)).toBeGreaterThan(0)
        })

        it('still waits for the first load of a freshly mounted Answer before revealing it', async () => {
            const { inputs, bindings } = await setup(true)
            const { answer, answered } = heldPages(inputs, bindings)
            await render(wrap(<DocumentRenderer document={answer} bindings={answered} />))
            expect(screen.queryByText(HELD_ANSWER)).toBeNull()
            await loadHeldPhoto()
            expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
        })

        it('still waits for a fresh scroller and native image when the Answer holds another capture', async () => {
            const { inputs, bindings } = await setup(true)
            const { result } = heldPages(inputs, bindings)
            const capture = {
                ...bindings.capture!,
                binding: { ...bindings.capture!.binding, captureId: 'next-capture' },
            }
            const other: FrameBindings = {
                ...bindings,
                capture,
                live: { ...bindings.live!, state: { ...bindings.live!.state, capture } },
            }
            const next = heldPages({ ...inputs, captureId: 'next-capture' }, other)
            const shown = jest.fn()
            const view = await render(wrap(<DocumentRenderer document={result} bindings={bindings} />))
            await loadHeldPhoto()
            const body = bodyScroller()
            const image = screen.getByTestId('frozen-photo-image')
            await view.rerender(
                wrap(
                    <DocumentRenderer document={next.answer} bindings={{ ...next.answered, onVariantShown: shown }} />,
                ),
            )
            expect(bodyScroller()).not.toBe(body)
            expect(screen.getByTestId('frozen-photo-image')).not.toBe(image)
            expect(screen.queryByText(HELD_ANSWER)).toBeNull()
            expect(readyShown(shown, next.answer)).toBe(0)
            await loadHeldPhoto()
            expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
            expect(readyShown(shown, next.answer)).toBeGreaterThan(0)
        })

        it('still waits for a fresh native image when the Answer places the photo in another ancestry', async () => {
            const { inputs, bindings } = await setup(true)
            const { result, answerInputs, answered } = heldPages(inputs, bindings)
            const elsewhere = composeEdited(answerInputs, deeper)
            const shown = jest.fn()
            const view = await render(wrap(<DocumentRenderer document={result} bindings={bindings} />))
            await loadHeldPhoto()
            const image = screen.getByTestId('frozen-photo-image')
            await view.rerender(
                wrap(<DocumentRenderer document={elsewhere} bindings={{ ...answered, onVariantShown: shown }} />),
            )
            expect(screen.getByTestId('frozen-photo-image')).not.toBe(image)
            expect(screen.queryByText(HELD_ANSWER)).toBeNull()
            expect(readyShown(shown, elsewhere)).toBe(0)
            await loadHeldPhoto()
            expect(screen.getByText(HELD_ANSWER)).toBeTruthy()
            expect(readyShown(shown, elsewhere)).toBeGreaterThan(0)
        })
    })

    it('gives an inspected authored body scroller its allocated viewport even with its source disclosure open', async () => {
        const { inputs, bindings } = await setup()
        const document = compose(inputs)
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, inspect: true }} />))
        const body = screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
        const inspector = body.parent!
        expect(inspector.props.onTouchEnd).toEqual(expect.any(Function))
        expect(StyleSheet.flatten(inspector.props.style)).toEqual(expect.objectContaining({ flex: 1, minWidth: 0 }))
        await fireEvent(inspector, 'touchEnd', { stopPropagation: jest.fn() })
        expect(screen.getByText('Scroll · generated')).toBeTruthy()
        expect(screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]).toBe(body)
        expect(StyleSheet.flatten(inspector.props.style)).toEqual(expect.objectContaining({ flex: 1 }))
    })

    it('leaves both Android system edges to Back while claiming a real centre step swipe', async () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'android')
        const create = jest.spyOn(PanResponder, 'create')
        try {
            const { inputs, bindings } = await setup()
            await render(wrap(<DocumentRenderer document={compose(inputs)} bindings={bindings} />))
            const config = create.mock.calls.find(([candidate]) => candidate.onPanResponderRelease !== undefined)![0]
            const width = Dimensions.get('window').width
            const claims = (start: number, dx: number): boolean =>
                config.onMoveShouldSetPanResponder?.({} as never, { dx, dy: 0, moveX: start + dx } as never) ?? false
            expect(claims(10, 70)).toBe(false)
            expect(claims(width - 10, -70)).toBe(false)
            expect(claims(width / 2, -70)).toBe(true)
        } finally {
            create.mockRestore()
            platform.restore()
        }
    })

    it('does not claim a step swipe or change progress for unreviewed facts even if an injected resolver enables capture', async () => {
        const create = jest.spyOn(PanResponder, 'create')
        const { inputs, bindings } = await setup()
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            reviewStatus: 'unreviewed',
            rawExtraction: {
                parts: inputs.session!.parts,
                steps: inputs.session!.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            },
        })
        const step = jest.spyOn(bindings.live!.controller, 'step').mockResolvedValue(undefined)
        try {
            await render(
                wrap(
                    <DocumentRenderer document={compose({ ...inputs, session })} bindings={{ ...bindings, session }} />,
                ),
            )
            const config = create.mock.calls.find(([candidate]) => candidate.onPanResponderRelease !== undefined)![0]
            const gesture = { dx: -100, dy: 0, moveX: Dimensions.get('window').width / 2 - 100 } as never
            const claims = config.onMoveShouldSetPanResponder?.({} as never, gesture)
            config.onPanResponderRelease?.({} as never, gesture)
            expect(claims).toBe(false)
            expect(step).not.toHaveBeenCalled()
        } finally {
            create.mockRestore()
            step.mockRestore()
        }
    })

    it('shows a known page count without fabricating per-page reading progress', async () => {
        const { inputs, bindings } = await setup()
        const document = compose({
            ...inputs,
            kind: 'reading',
            stepId: null,
            uiState: { busy: { activity: 'reading' } },
        })
        const reading = (pending: string): ReactElement =>
            wrap(
                <DocumentRenderer
                    document={document}
                    bindings={{ ...bindings, live: { ...bindings.live!, state: { ...bindings.live!.state, pending } } }}
                    variant="busy"
                />,
            )
        const view = await render(reading('Reading your pages…'))
        expect(await screen.findByRole('header', { name: 'Reading your manual' })).toBeTruthy()
        const progress = await screen.findByRole('progressbar', { name: 'Reading your manual' })
        expect(progress.props.accessibilityValue).toEqual({ text: 'Reading your manual. This can take a minute.' })
        expect(screen.getByText('1 manual page')).toBeTruthy()
        expect(screen.queryByText('Page 1 of 1')).toBeNull()
        await view.rerender(reading('Reading manual pages: laying out steps…'))
        expect(screen.getByRole('progressbar', { name: 'Reading your manual' }).props.accessibilityValue).toEqual({
            text: 'Laying out steps…',
        })
        expect(within(await screen.findByTestId('reading-stream-phase')).getByText('Laying out steps…')).toBeTruthy()
        expect(screen.getByText('1 manual page')).toBeTruthy()
        expect(screen.queryByText('Page 1 of 1')).toBeNull()
    })

    it.each([
        { manualId: 'another-manual' },
        { revision: 999 },
        { stepId: 'another-step' },
        { captureId: 'another-capture' },
    ])(
        'shows the verdict only after its exact held-photo binding loads; mismatch %j never resolves it',
        async (mismatch) => {
            const { inputs, bindings } = await setup(true)
            const document = compose(inputs)
            const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            const waitingImage = screen.getByTestId('frozen-photo-image')
            // A held build photo is catalog Image content, never a manual-page capability exclusion.
            expect(parseNativeMeterMarkers(waitingImage.props.nativeID)).toMatchObject({
                origin: 'generated',
                capability: null,
            })
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 200 } },
            })
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
            expect(screen.getByTestId('frozen-photo-image')).toBe(waitingImage)
            expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
            await view.rerender(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{
                            ...bindings,
                            capture: {
                                ...bindings.capture!,
                                binding: { ...bindings.capture!.binding, ...mismatch },
                            },
                        }}
                    />,
                ),
            )
            expect(screen.queryByTestId('frozen-photo-image')).toBeNull()
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            await view.rerender(wrap(<DocumentRenderer document={document} bindings={bindings} />))
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 200 } },
            })
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
            expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
            await view.rerender(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{ ...bindings, capture: { ...bindings.capture!, reusable: false } }}
                    />,
                ),
            )
            expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
        },
    )

    it('waits for the new native image when a deeper composition moves the same held photo', async () => {
        const { inputs, bindings } = await setup(true)
        const document = compose(inputs)
        const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        const body = screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
        const material = documentMaterialV2(inputs, false)
        const proposal = buildFallbackProposalV2(material)
        for (const { variant } of variantsOfV2(proposal)) {
            if (variant.body.type === 'Scroll' && variant.body.children[0]?.type === 'Stack') {
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
        }
        const next = screenDocumentV2Schema.parse(
            assembleDocumentV2(
                material,
                proposal,
                { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
                { sha256Hex, now: () => new Date('2026-10-29T00:00:00Z') },
            ),
        )
        expect(next.screenId).not.toBe(document.screenId)
        await view.rerender(wrap(<DocumentRenderer document={next} bindings={bindings} />))
        expect(screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]).toBe(body)
        expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
    })

    it('waits for the new native photo when inspection adds or removes its wrapper', async () => {
        const { inputs, bindings } = await setup(true)
        const document = compose(inputs)
        const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        const load = async (): Promise<void> => {
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 200 } },
            })
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        }
        await load()
        expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
        for (const inspect of [true, false]) {
            const previous = screen.getByTestId('frozen-photo-image')
            await view.rerender(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, inspect }} />))
            expect(screen.getByTestId('frozen-photo-image')).not.toBe(previous)
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            await load()
            expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
        }
    })

    it('binds only the camera shutter to capture and routes Choose photos to the independent library capability', async () => {
        const { inputs, bindings, run } = await setup()
        const cameraInputs: ScreenContextInputsV2 = {
            ...inputs,
            kind: 'camera',
            uiState: { camera: { mode: 'build-photo', permission: 'granted' } },
        }
        const document = compose(cameraInputs)
        const capture = jest.fn()
        const mounted = jest.fn()
        const unmounted = jest.fn()
        function CameraPreview(): ReactElement {
            useEffect(() => {
                mounted()
                return unmounted
            }, [])
            return <View testID="raw-camera-preview" />
        }
        const cameraBindings = {
            ...bindings,
            camera: { permission: 'granted' as const, ready: true, capture, preview: <CameraPreview /> },
        }
        const view = await render(wrap(<DocumentRenderer document={document} bindings={cameraBindings} />))
        const preview = screen.getByTestId('raw-camera-preview')
        expect(screen.getAllByTestId('camera-shutter')).toHaveLength(1)
        await fireEvent.press(screen.getByTestId('camera-shutter'))
        expect(capture).toHaveBeenCalledTimes(1)
        expect(run).not.toHaveBeenCalled()
        const choose = jest.fn()
        const imported = {
            ...document,
            bar: {
                ...document.bar,
                secondary: {
                    type: 'SecondaryAction' as const,
                    label: 'Choose photos',
                    intent: { intent: 'capture' as const, target: 'choose-pages' as const },
                    icon: null,
                },
            },
            metadata: {
                ...document.metadata,
                origins: { ...document.metadata.origins, 'bar.secondary': 'generated' as const },
            },
        }
        const imports = {
            ...cameraBindings,
            camera: { ...cameraBindings.camera, ready: false },
            resolve: (intent: Parameters<typeof resolveCameraCapture>[0]): ReturnType<FrameBindings['resolve']> =>
                resolveCameraCapture(intent, cameraBindings.camera, false, choose) ?? {
                    enabled: true,
                    reason: null,
                    run,
                },
        }
        await view.rerender(wrap(<DocumentRenderer document={imported} bindings={imports} />))
        expect(screen.getAllByTestId('camera-shutter')).toHaveLength(1)
        expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled()
        await fireEvent.press(screen.getByRole('button', { name: 'Choose photos' }))
        expect(choose).toHaveBeenCalledTimes(1)
        expect(capture).toHaveBeenCalledTimes(1)
        await view.rerender(wrap(<DocumentRenderer document={document} bindings={cameraBindings} variant="busy" />))
        expect(screen.getByTestId('raw-camera-preview')).toBeTruthy()
        expect(mounted).toHaveBeenCalledTimes(1)
        expect(unmounted).not.toHaveBeenCalled()
        await fireEvent.press(await screen.findByRole('button', { name: waitCopyV2('camera').action }))
        expect(capture).toHaveBeenCalledTimes(1)
        await view.rerender(wrap(<DocumentRenderer document={document} bindings={cameraBindings} variant="pending" />))
        expect(screen.getByTestId('camera-shutter')).toBeEnabled()
        expect(mounted).toHaveBeenCalledTimes(1)
        expect(unmounted).not.toHaveBeenCalled()
        const next = compose(cameraInputs, [], 'fallback')
        expect(next.screenId).not.toBe(document.screenId)
        await view.rerender(wrap(<DocumentRenderer document={next} bindings={cameraBindings} />))
        expect(screen.getByTestId('raw-camera-preview')).toBe(preview)
        expect(mounted).toHaveBeenCalledTimes(1)
        expect(unmounted).not.toHaveBeenCalled()
    })

    it('keeps the held result’s exact missing evidence and citations visible and reveals its feedback only once', async () => {
        const { inputs, bindings } = await setup(true)
        const check = {
            ...bindings.live!.state.check!,
            decision: 'cannot_verify' as const,
            missingEvidence: ['The far joint is hidden.'],
        }
        const liveBindings = { ...bindings, live: { ...bindings.live!, state: { ...bindings.live!.state, check } } }
        const document = compose({ ...inputs, result: { kind: 'check', value: check } })
        const trigger = jest.fn()
        const haptics = { trigger }
        const view = await render(wrap(<DocumentRenderer document={document} bindings={liveBindings} />, haptics))
        expect(screen.queryByText(check.missingEvidence[0]!)).toBeNull()
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(check.reason)).toBeTruthy()
        expect(screen.getByText(check.missingEvidence[0]!)).toBeTruthy()
        expect(screen.getAllByRole('link', { name: 'See it in the manual' }).length).toBeGreaterThan(0)
        expect(trigger).toHaveBeenCalledWith('warning')
        await view.rerender(wrap(<DocumentRenderer document={document} bindings={{ ...liveBindings }} />, haptics))
        expect(trigger).toHaveBeenCalledTimes(1)
    })

    it('lets a question about a step without named parts choose a real photo point and blocks edits while busy', async () => {
        const { inputs, bindings, controller } = await setup(true, true)
        const target = jest.spyOn(controller, 'targetChanged')
        const document = compose({
            ...inputs,
            kind: 'questions',
            result: null,
            uiState: {
                capture: {
                    captureId: bindings.capture!.binding.captureId,
                    reusable: true,
                    target: null,
                    questionDraftPresent: false,
                },
            },
        })
        const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        expect(bindings.capture?.reusable).toBe(true)
        expect(document.bound.captureId).toBe(bindings.capture?.binding.captureId)
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 168.75 } },
        })
        await fireEvent.press(screen.getByTestId('frozen-photo-frame'), {
            nativeEvent: { locationX: 150, locationY: 84.375 },
        })
        expect(target).toHaveBeenLastCalledWith({ kind: 'point', x: 0.5, y: 0.5 })
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'accessibilityTap')
        expect(target).toHaveBeenCalledTimes(2)
        await view.rerender(
            wrap(
                <DocumentRenderer
                    document={document}
                    bindings={{
                        ...bindings,
                        live: { ...bindings.live!, state: { ...bindings.live!.state, pending: 'Still thinking…' } },
                    }}
                />,
            ),
        )
        await fireEvent.press(screen.getByTestId('frozen-photo-frame'), {
            nativeEvent: { locationX: 150, locationY: 84.375 },
        })
        expect(target).toHaveBeenCalledTimes(2)
    })

    it.each(['equal', 'disjoint', 'result-extra', 'manual-extra'] as const)(
        'shares a result sentence with a manual fact only when their citation sets are equal: %s',
        async (sourceCase) => {
            const { inputs, bindings } = await setup(true)
            const initial = documentMaterialV2(inputs, false).facts.find((item) => item.kind === 'orientation')!
            const extra = { pageId: initial.sourceRefs[0]!.pageId, region: { x: 0, y: 0, width: 0.5, height: 0.5 } }
            const orientation = inputs.session!.reviewedSteps[0]!.orientation
            if (sourceCase === 'manual-extra' && orientation.state === 'known') orientation.sourceRefs.push(extra)
            const fact = documentMaterialV2(inputs, false).facts.find((item) => item.kind === 'orientation')!
            const check = {
                ...bindings.live!.state.check!,
                reason: fact.text,
                sourceRefs:
                    sourceCase === 'disjoint'
                        ? [extra]
                        : sourceCase === 'result-extra'
                          ? [...fact.sourceRefs, extra]
                          : sourceCase === 'manual-extra'
                            ? [fact.sourceRefs[0]!]
                            : [...fact.sourceRefs],
            }
            const document = compose({ ...inputs, result: { kind: 'check', value: check } })
            const view = await render(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{
                            ...bindings,
                            live: { ...bindings.live!, state: { ...bindings.live!.state, check } },
                        }}
                    />,
                ),
            )
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 200 } },
            })
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
            expect(screen.getAllByText(fact.text)).toHaveLength(sourceCase === 'equal' ? 1 : 2)
            await view.rerender(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{
                            ...bindings,
                            live: { ...bindings.live!, state: { ...bindings.live!.state, check: null } },
                        }}
                    />,
                ),
            )
            expect(screen.getAllByText(fact.text)).toHaveLength(1)
        },
    )

    it('deduplicates repeated facts and their own citation controls by fact id', async () => {
        const { inputs, bindings } = await setup()
        const material = documentMaterialV2(inputs, false)
        const fact = material.facts.find((item) => item.sourceRefs.length > 0 && item.kind === 'orientation')!
        const citation = material.sources.findIndex((item) => item.pageId === fact.sourceRefs[0]!.pageId)
        const duplicate: ScreenNodeV2[] = [
            {
                type: 'Text',
                content: { kind: 'fact', factId: fact.factId },
                role: 'body',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            },
            { type: 'Citation', sources: [citation], label: null, display: 'chip' },
        ]
        await render(
            wrap(<DocumentRenderer document={compose(inputs, [...duplicate, ...duplicate])} bindings={bindings} />),
        )
        expect(screen.getAllByText(fact.text)).toHaveLength(1)
    })

    it('keeps a safety warning even when the held verdict repeats its exact cited sentence', async () => {
        const { inputs, bindings } = await setup(true)
        const fact = documentMaterialV2(inputs, false).facts.find((item) => item.kind === 'orientation')!
        inputs.session!.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'keep-warning',
                note: { state: 'known', value: fact.text, sourceRefs: [...fact.sourceRefs] },
            },
        ]
        const check = { ...bindings.live!.state.check!, reason: fact.text, sourceRefs: [...fact.sourceRefs] }
        const document = compose({ ...inputs, result: { kind: 'check', value: check } })
        await render(
            wrap(
                <DocumentRenderer
                    document={document}
                    bindings={{ ...bindings, live: { ...bindings.live!, state: { ...bindings.live!.state, check } } }}
                />,
            ),
        )
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getAllByText(fact.text)).toHaveLength(2)
        expect(screen.getByText('Safety')).toBeTruthy()
    })

    it('keeps the fact citation when an earlier repeated statement had no citation control', async () => {
        const { inputs, bindings } = await setup()
        const material = documentMaterialV2(inputs, false)
        const fact = material.facts.find((item) => item.kind === 'orientation')!
        const bare: ScreenNodeV2 = {
            type: 'Text',
            content: { kind: 'fact', factId: fact.factId },
            role: 'body',
            emphasis: 'normal',
            tone: 'neutral',
            align: 'start',
        }
        await render(wrap(<DocumentRenderer document={compose(inputs, [bare])} bindings={bindings} />))
        expect(screen.getAllByText(fact.text)).toHaveLength(1)
        // One citation affordance per exact source on the screen: every demo fact cites the same
        // page region, so one button offers it however many facts cite it (source access preserved).
        expect(screen.getAllByRole('link', { name: 'See it in the manual' })).toHaveLength(1)
        expect(material.facts.length).toBeGreaterThan(1)
    })

    it('renders a bounded varied set of valid recursive compositions without losing the required frame', async () => {
        const { inputs, bindings } = await setup()
        for (let seed = 0; seed < 24; seed++) {
            const leaf: ScreenNodeV2 = {
                type: 'Text',
                content: { kind: 'literal', text: 'More' },
                role: seed % 2 === 0 ? 'body' : 'caption',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            }
            const tree: ScreenNodeV2 = {
                type: 'Card',
                padding: seed % 2 === 0 ? 'none' : 'lg',
                surface: 'raised',
                tone: 'neutral',
                children: [
                    {
                        type: 'Grid',
                        columns: ((seed % 4) + 1) as 1 | 2 | 3 | 4,
                        gap: 'sm',
                        children: [
                            {
                                type: 'Row',
                                gap: 'none',
                                align: 'center',
                                justify: 'between',
                                wrap: true,
                                children: [leaf],
                            },
                        ],
                    },
                ],
            }
            const view = await render(wrap(<DocumentRenderer document={compose(inputs, [tree])} bindings={bindings} />))
            expect(screen.getAllByTestId('bottom-bar')).toHaveLength(1)
            expect(screen.getByTestId('guide-primary')).toBeTruthy()
            await view.unmount()
        }
    })
})

it('shows each resolved Guide pill once across nested containers without dropping distinct labels', async () => {
    const { inputs, bindings, controller } = await setup()
    const more: ScreenNodeV2 = { type: 'Badge', label: { kind: 'literal', text: 'More' }, tone: 'info' }
    const parts: ScreenNodeV2 = { type: 'Badge', label: { kind: 'literal', text: 'Close' }, tone: 'neutral' }
    const extras: ScreenNodeV2[] = [
        more,
        {
            type: 'Row',
            gap: 'sm',
            align: 'center',
            justify: 'start',
            wrap: true,
            children: [more, parts, { type: 'Stack', gap: 'sm', align: 'stretch', children: [more, more, more] }],
        },
    ]
    const view = await render(
        <StrictMode>{wrap(<DocumentRenderer document={compose(inputs, extras)} bindings={bindings} />)}</StrictMode>,
    )
    try {
        expect(view.getAllByText('More')).toHaveLength(1)
        expect(view.getAllByText('Close')).toHaveLength(1)
        await view.rerender(
            <StrictMode>
                {wrap(<DocumentRenderer document={compose(inputs, extras)} bindings={bindings} />)}
            </StrictMode>,
        )
        expect(view.getAllByText('More')).toHaveLength(1)
    } finally {
        await view.unmount()
        controller.dispose()
    }
})

it('shows a fallback Guide piece once, and a drag on its 3D view holds the page body still', async () => {
    const { inputs, bindings, controller } = await setup()
    const linkedPart = bindings.session!.parts[0]!
    const pieceId = pieceIdsByPartId(bindings.session!).get(linkedPart.partId)!
    const name = linkedPart.name.state === 'known' ? linkedPart.name.value : 'Part'
    expect(pieceId).not.toBe(linkedPart.partId)
    const part = {
        type: 'box' as const,
        dimensions: { width: 1, height: 1, depth: 1 },
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
    }
    const guideBindings: FrameBindings = {
        ...bindings,
        pieces: [{ id: pieceId, name, color: '#5A7CA5', parts: [part] }],
        stepPieces: [{ pieceId, name, quantity: 2, state: 'pending' }],
    }
    const create = jest.spyOn(PanResponder, 'create')
    const view = await render(
        wrap(<DocumentRenderer document={compose(inputs, [], 'fallback')} bindings={guideBindings} />),
    )
    try {
        expect(screen.getByTestId(`piece-tile-${pieceId}`)).toBeTruthy()
        await fireEvent.press(screen.getByTestId(`piece-tile-${pieceId}`))
        const card = screen.getByTestId(`piece-card-${pieceId}`)
        expect(within(card).queryByTestId('piece-viewer-fallback')).toBeNull()
        expect(screen.queryByTestId(`piece-placeholder-${pieceId}`)).toBeNull()
        expect(within(card).getAllByText(name)).toHaveLength(1)
        expect(within(card).getAllByText(/^×\s*2$/u)).toHaveLength(1)
        expect(within(card).getByTestId('guide-piece-gl-surface')).toBeTruthy()
        // Selecting a chip opens the modal; the existing drag still locks its owning page scroll until release.
        const event = { nativeEvent: { touches: [] } } as unknown as GestureResponderEvent
        const touch: PanResponderGestureState = {
            stateID: 1,
            moveX: 0,
            moveY: 0,
            x0: 0,
            y0: 0,
            dx: 0,
            dy: 0,
            vx: 0,
            vy: 0,
            numberActiveTouches: 1,
        }
        const drag = create.mock.calls
            .map(([candidate]) => candidate)
            .find((candidate) => candidate.onStartShouldSetPanResponder?.(event, touch) === true)!
        expect(bodyScroller().props.scrollEnabled).toBe(true)
        await act(() => drag.onPanResponderGrant?.(event, touch))
        expect(bodyScroller().props.scrollEnabled).toBe(false)
        await act(() => drag.onPanResponderRelease?.(event, touch))
        expect(bodyScroller().props.scrollEnabled).toBe(true)
    } finally {
        await view.unmount()
        controller.dispose()
        create.mockRestore()
    }
})

it('production More edits an optional unstated count during review and respects read-only rendering', async () => {
    const { bindings, inputs, controller } = await setup()
    const session = structuredClone(inputs.session!)
    session.reviewStatus = 'unreviewed'
    session.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason: 'The manual gives no count.' }
    const accept = jest.spyOn(controller, 'acceptStepFacts').mockResolvedValue(true)
    const moreInputs: ScreenContextInputsV2 = { ...inputs, kind: 'more', session }
    const document = compose(moreInputs)
    const reviewBindings: FrameBindings = {
        ...bindings,
        session,
        live: { ...bindings.live!, state: { ...bindings.live!.state, route: 'overview' } },
    }
    const { rerender } = await render(wrap(<DocumentRenderer document={document} bindings={reviewBindings} />))
    expect(screen.getByText('Side panel: count not stated in the manual.')).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Count for Side panel (optional)'), '3')
    await fireEvent.press(screen.getByRole('button', { name: 'Save count for Side panel' }))
    await waitFor(() =>
        expect(accept).toHaveBeenCalledWith(
            { kind: 'manual', manualId: session.manualId, revision: session.revision },
            session.reviewedSteps[0]!.stepId,
            { quantity: { partId: 'side-panel', value: 3 } },
        ),
    )
    await rerender(wrap(<DocumentRenderer document={document} bindings={{ ...reviewBindings, readOnly: true }} />))
    expect(screen.queryByLabelText('Count for Side panel (optional)')).toBeNull()
    controller.dispose()
})
