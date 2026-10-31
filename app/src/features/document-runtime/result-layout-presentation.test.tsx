import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { StyleSheet, Text } from 'react-native'
import type { ReactElement } from 'react'
import { variantsOfV2, type ScreenContextInputsV2, type ScreenProposalV2 } from '@truebuild/contracts'
import { WorkflowContext, type WorkflowValue } from '../capture/workflow-context'
import { documentInputs } from '../capture/document-inputs'
import { defaultNav } from '../capture/screen-nav'
import { resolveIntent } from '../screens/intents'
import { entry, runtime, source } from '../screens/test-support/route-harness'
import { fixtureDocuments } from '../screens/test-support/fixture-server'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { DocumentRenderer } from '../documents/document-renderer'
import type { FrameBindings } from '../documents/types'
import { resultLayoutDocument } from './result-layout-runtime'
import { DocumentStore } from './store'
import { useDocument } from './use-document'

const fixtureFlag = process.env.EXPO_PUBLIC_RELEASE_FIXTURE
beforeEach(() => {
    process.env.EXPO_PUBLIC_RELEASE_FIXTURE = '1'
})
afterEach(() => {
    if (fixtureFlag === undefined) delete process.env.EXPO_PUBLIC_RELEASE_FIXTURE
    else process.env.EXPO_PUBLIC_RELEASE_FIXTURE = fixtureFlag
})

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

function Observed({
    inputs,
    bindings,
    focused = true,
}: {
    inputs: ScreenContextInputsV2
    bindings?: FrameBindings
    focused?: boolean
}): ReactElement {
    const reading = useDocument(inputs, { focused, state: inputs.uiState?.busy == null ? 'ready' : 'busy' })
    return (
        <>
            <Text testID="catalog-document">{`${reading.document.screenId}:${reading.issue ?? 'none'}:${reading.document.metadata.source}:${reading.document.metadata.authoring?.fixtureId ?? 'exact'}`}</Text>
            {bindings === undefined ? null : (
                <DocumentRenderer document={reading.document} variant={reading.activeState} bindings={bindings} />
            )}
        </>
    )
}
function tree(
    value: WorkflowValue,
    inputs: ScreenContextInputsV2,
    bindings?: FrameBindings,
    focused = true,
): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <WorkflowContext.Provider value={value}>
                    <Observed inputs={inputs} bindings={bindings} focused={focused} />
                </WorkflowContext.Provider>
            </FeedbackProvider>
        </ThemeProvider>
    )
}

/** Mirrors the native fixture's cards arrangement: its held photo has another valid container ancestry. */
function cardResult(proposal: ScreenProposalV2, inputs: ScreenContextInputsV2): ScreenProposalV2 {
    if (inputs.kind !== 'result') return proposal
    for (const { variant } of variantsOfV2(proposal)) {
        if (variant.body.type !== 'Scroll' || variant.body.children[0]?.type !== 'Stack')
            throw new Error('Expected fixture body stack')
        variant.body.children[0].children = variant.body.children[0].children.map((child) => ({
            type: 'Card',
            surface: 'plain',
            padding: 'sm',
            tone: 'neutral',
            children: [child],
        }))
    }
    return proposal
}

/** Android uses different native scroll/content components for this otherwise valid catalog layout. */
function horizontalResult(proposal: ScreenProposalV2, inputs: ScreenContextInputsV2): ScreenProposalV2 {
    if (inputs.kind === 'result')
        for (const { variant } of variantsOfV2(proposal)) {
            if (variant.body.type !== 'Scroll') throw new Error('Expected fixture scroll')
            variant.body.axis = 'horizontal'
        }
    return proposal
}

it.each(
    (['cards', 'horizontal scroll'] as const).flatMap((layout) =>
        (['cached before mount', 'cached while the question covers the Result'] as const).map(
            (timing) => [layout, timing] as const,
        ),
    ),
)(
    'keeps the loaded held image across Result activity keys and Answer when exact %s were %s',
    async (layout, timing) => {
        const { controller } = await runtime([entry()], {
            check: { decision: 'refuse', reason: 'The current joint is not seated.' },
        })
        await controller.restore()
        await controller.open(controller.getSnapshot().entries[0]!.session.manualId, 'guide')
        controller.camera({ kind: 'check' })
        await controller.shutter(async () => source)
        const state = controller.getSnapshot()
        const selected = controller.current!
        let release!: () => void
        const server = fixtureDocuments({
            generated: ['result', 'answer'],
            arrange: layout === 'cards' ? cardResult : horizontalResult,
            ...(timing === 'cached before mount' ? {} : { gate: new Promise<void>((resolve) => (release = resolve)) }),
        })
        const store = new DocumentStore({ client: server, mode: 'full', id: (): string => 'cached-cards' })
        const value: WorkflowValue = { controller, state, entry: selected, screens: null, documents: store }
        const inputs = documentInputs('result', value)
        const asking: ScreenContextInputsV2 = {
            ...inputs,
            uiState: { ...inputs.uiState, busy: { activity: 'asking' } },
        }
        const waiting: ScreenContextInputsV2 = {
            ...inputs,
            uiState: { ...inputs.uiState, busy: { activity: 'question-waiting' } },
        }
        const more = { open: false, mode: 'details' as const, show: (): void => undefined, hide: (): void => undefined }
        const bindings: FrameBindings = {
            resolve: () => ({ enabled: true, reason: null, run: (): void => undefined }),
            live: { state, entry: selected, controller, nav: defaultNav(controller), more },
            session: selected.session,
            pageUris: state.pageUris,
            capture: state.capture,
            marks: [],
            heroMode: 'inline',
            inspect: false,
        }
        if (timing === 'cached before mount') await store.waitForGenerated(inputs)
        const view = await render(tree(value, inputs, bindings))
        try {
            await loadPhoto()
            const image = screen.getByTestId('frozen-photo-image')
            const uri = image.props.source.uri as string
            const bodyScroll = (): boolean =>
                screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!.props
                    .horizontal as boolean
            expect(bodyScroll()).toBe(false)
            if (timing !== 'cached before mount') {
                await act(async () => release())
                await waitFor(() => expect(store.peek(inputs)?.exactGeneration).toBeUndefined())
            }
            // Warmups can finish before a new activity key is rendered, even with the Result behind the Ask sheet.
            await act(async () => {
                await store.waitForGenerated(asking)
                await store.waitForGenerated(waiting)
            })
            const cachedAsking = store.peek(asking)!.document
            expect(cachedAsking.metadata.authoring).toBeUndefined()
            for (const busyInputs of [asking, waiting]) {
                await view.rerender(tree(value, busyInputs, { ...bindings, workInProgress: true }, false))
                expect(screen.getByTestId('frozen-photo-image')).toBe(image)
                expect(StyleSheet.flatten(image.props.style).width).toBeGreaterThan(0)
                expect(screen.getByTestId('frozen-photo-image').props.source.uri).toBe(uri)
                expect(bodyScroll()).toBe(false)
            }
            await act(async () => {
                controller.questionChanged('Which way should this face?')
                controller.targetChanged({ kind: 'part', partId: 'side-panel' })
                await controller.ask()
            })
            const answeredState = controller.getSnapshot()
            const answeredValue = { ...value, state: answeredState, entry: controller.current }
            const answer = documentInputs('answer', answeredValue)
            await view.rerender(
                tree(answeredValue, answer, {
                    ...bindings,
                    answeredQuestion: answeredState.answeredQuestion,
                    live: { ...bindings.live!, state: answeredState, entry: controller.current },
                }),
            )
            expect(screen.getByTestId('frozen-photo-image')).toBe(image)
            expect(StyleSheet.flatten(image.props.style).width).toBeGreaterThan(0)
            expect(screen.getByText(answeredState.answer!.answer)).toBeTruthy()
            expect(screen.getByRole('button', { name: 'Back to the guide' })).toBeEnabled()
            // Selecting a continuous presentation does not rewrite the provider's cached document or its receipt.
            expect(store.peek(asking)!.document).toBe(cachedAsking)
        } finally {
            await view.unmount()
            release?.()
            store.dispose()
            controller.dispose()
        }
    },
)

it('can adopt a compatible exact response after retrying an incompatible cached Result', async () => {
    const { controller } = await runtime([entry()])
    await controller.restore()
    await controller.open(controller.getSnapshot().entries[0]!.session.manualId, 'guide')
    controller.camera({ kind: 'check' })
    await controller.shutter(async () => source)
    let cards = true
    const server = fixtureDocuments({
        generated: ['result'],
        arrange: (proposal, inputs) => (cards ? cardResult(proposal, inputs) : proposal),
    })
    const store = new DocumentStore({ client: server, mode: 'full', id: (): string => 'retry-placement' })
    const value: WorkflowValue = {
        controller,
        state: controller.getSnapshot(),
        entry: controller.current,
        screens: null,
        documents: store,
    }
    const inputs = documentInputs('result', value)
    await store.waitForGenerated(inputs)
    const view = await render(tree(value, inputs))
    try {
        expect(screen.getByTestId('catalog-document').props.children).toContain('recorded-result-layout-sol-v1')
        cards = false
        // Retry may commit the authored pending receipt; a later compatible exact response must still replace it.
        await act(async () => {
            store.retry(inputs)
            await store.waitForGenerated(inputs)
        })
        const exact = store.peek(inputs)!.document
        expect(exact.metadata.authoring).toBeUndefined()
        expect(screen.getByTestId('catalog-document').props.children).toBe(`${exact.screenId}:none:generated:exact`)
        expect(server.requests).toHaveLength(2)
    } finally {
        await view.unmount()
        store.dispose()
        controller.dispose()
    }
})
async function loadPhoto(): Promise<void> {
    await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
        nativeEvent: { layout: { width: 390, height: 520 } },
    })
    await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
}

it.each([
    ['result', 'pass', 'Next step'],
    ['result', 'refuse', 'Retake photo'],
    ['result', 'cannot_verify', 'Retake photo'],
    ['answer', 'pass', 'Back to the guide'],
] as const)(
    'shows the real held %s/%s and enabled action after photo load while exact composition stays held',
    async (kind, decision, primary) => {
        const missingEvidence =
            decision === 'pass' && kind === 'result'
                ? []
                : ['The actual near edge is hidden.', 'The actual far edge is hidden.']
        const { controller } = await runtime([entry()], {
            check: { decision, reason: `Actual current ${decision} reason.`, missingEvidence },
            answer: { missingEvidence },
        })
        await controller.restore()
        await controller.open(controller.getSnapshot().entries[0]!.session.manualId, 'guide')
        controller.camera({ kind: kind === 'result' ? 'check' : 'question' })
        await controller.shutter(async () => source)
        if (kind === 'answer') {
            controller.questionChanged('Which way should this face?')
            controller.targetChanged({ kind: 'part', partId: 'side-panel' })
            await controller.ask()
        }
        const state = controller.getSnapshot()
        const selected = controller.current!
        let release!: () => void
        const server = fixtureDocuments({
            generated: ['result', 'answer'],
            gate: new Promise<void>((resolve) => {
                release = resolve
            }),
        })
        const store = new DocumentStore({ client: server, mode: 'full', id: (): string => 'presentation' })
        const value: WorkflowValue = { controller, state, entry: selected, screens: null, documents: store }
        const inputs = documentInputs(kind, value)
        const nav = defaultNav(controller)
        const more = { open: false, mode: 'details' as const, show: (): void => undefined, hide: (): void => undefined }
        const bindings: FrameBindings = {
            resolve: (intent) =>
                resolveIntent(intent, {
                    kind,
                    state: controller.getSnapshot(),
                    entry: controller.current,
                    controller,
                    nav,
                    extras: {},
                }),
            live: { state, entry: selected, controller, nav, more },
            session: selected.session,
            pageUris: state.pageUris,
            capture: state.capture,
            marks: [],
            heroMode: 'inline',
            inspect: false,
        }
        const text = kind === 'result' ? state.check!.reason : state.answer!.answer
        const view = await render(tree(value, inputs, bindings))
        try {
            const initial = screen.getByTestId('catalog-document').props.children as string
            expect(initial).toContain(`:none:generated:recorded-${kind}-layout-sol-v1`)
            expect(screen.queryByText(text)).toBeNull()
            expect(screen.queryByRole('button', { name: primary })).toBeNull()
            await loadPhoto()
            expect(screen.getByText(text)).toBeTruthy()
            for (const missing of missingEvidence) expect(screen.getAllByText(missing)).toHaveLength(1)
            expect(screen.getByRole('button', { name: primary })).toBeEnabled()
            expect(state.capture?.observation.bytes).toBeDefined()
            const loadedImage = screen.getByTestId('frozen-photo-image')
            const loadedUri = loadedImage.props.source.uri as string
            expect(loadedUri).toMatch(/^data:image\/jpeg;base64,/u)
            const capture = state.capture
            const sourceDisclosure = screen.getAllByRole('button', { name: 'See it in the manual' })[0]!
            await fireEvent.press(sourceDisclosure)
            expect(screen.getAllByTestId('diagram-0').length).toBeGreaterThan(0)
            await waitFor(() => expect(server.requests).toHaveLength(1))
            expect(store.peek(inputs)?.exactGeneration).toBe('pending')
            await act(async () => {
                release()
            })
            await waitFor(() => expect(screen.getByTestId('catalog-document').props.children).not.toBe(initial))
            expect(screen.getByTestId('catalog-document').props.children).toContain(':none:generated:exact')
            expect(store.peek(inputs)?.document.bound.captureId).toBe(capture?.binding.captureId)
            // The native image remains mounted at the same spine and retains its actual loaded witness.
            expect(screen.getByTestId('frozen-photo-image')).toBe(loadedImage)
            expect(screen.getByTestId('frozen-photo-image').props.source.uri).toBe(loadedUri)
            expect(screen.getByText(text)).toBeTruthy()
            for (const missing of missingEvidence) expect(screen.getAllByText(missing)).toHaveLength(1)
            await fireEvent.press(screen.getByRole('button', { name: primary }))
            if (kind === 'result' && decision === 'pass')
                await waitFor(() => expect(controller.current?.stepIndex).toBe(1))
            else if (kind === 'result') expect(controller.getSnapshot().route).toBe('camera')
            else expect(controller.getSnapshot().route).toBe('guide')
            expect(server.requests).toHaveLength(1)
        } finally {
            await view.unmount()
            store.dispose()
            controller.dispose()
            release()
        }
    },
)

it.each(['competing request', 'oversized exact response'] as const)(
    'retains the actual generated layout after eviction by %s and reports the terminal cache cause',
    async (cause) => {
        const { controller } = await runtime([entry()])
        await controller.restore()
        await controller.open(controller.getSnapshot().entries[0]!.session.manualId, 'guide')
        controller.camera({ kind: 'check' })
        await controller.shutter(async () => source)
        const value: WorkflowValue = {
            controller,
            state: controller.getSnapshot(),
            entry: controller.current,
            screens: null,
        }
        const inputs = documentInputs('result', value)
        const next = { ...inputs, captureId: `${inputs.captureId}-next`, uiState: undefined }
        const size = (context: ScreenContextInputsV2): number =>
            new TextEncoder().encode(JSON.stringify(resultLayoutDocument(context))).length
        let release!: () => void
        const server = fixtureDocuments({
            generated: ['result'],
            gate: new Promise<void>((resolve) => {
                release = resolve
            }),
            ...(cause === 'oversized exact response'
                ? {
                      arrange: (proposal): ScreenProposalV2 => {
                          for (const { variant } of variantsOfV2(proposal)) {
                              if (!('children' in variant.body)) throw new Error('fixture_body_must_be_container')
                              variant.body.children.push({
                                  type: 'Stack',
                                  gap: 'md',
                                  align: 'stretch',
                                  children: [
                                      ...Array.from({ length: 60 }, () => ({
                                          type: 'Spacer' as const,
                                          size: 'md' as const,
                                      })),
                                  ],
                              })
                          }
                          return proposal
                      },
                  }
                : {}),
        })
        const store = new DocumentStore({
            client: server,
            mode: 'full',
            id: (): string => 'evicted-layout',
            maxDocumentBytes: Math.max(size(inputs), size(next)) + 128,
        })
        const view = await render(tree({ ...value, documents: store }, inputs))
        try {
            const first = store.peek(inputs)!.document
            await act(async () => {
                if (cause === 'competing request') store.request(next)
                else release()
            })
            if (cause === 'competing request') {
                await waitFor(() => expect(store.peek(inputs)).toBeUndefined())
                expect(store.cacheIssue(inputs)).toBe('budget_exhausted')
            } else {
                await waitFor(() => expect(store.peek(inputs)?.issue).toBe('budget_exhausted'))
                expect(store.peek(inputs)?.exactGeneration).toBe('unavailable')
                expect(store.peek(inputs)?.document).toBe(first)
                expect(store.readyAt(inputs)).toBeNull()
            }
            expect(screen.getByTestId('catalog-document').props.children).toBe(
                `${first.screenId}:budget_exhausted:generated:recorded-result-layout-sol-v1`,
            )
            await act(async () => {
                release()
            })
            expect(screen.getByTestId('catalog-document').props.children).toBe(
                `${first.screenId}:budget_exhausted:generated:recorded-result-layout-sol-v1`,
            )
            expect(server.requests).toHaveLength(cause === 'competing request' ? 2 : 1)
        } finally {
            await view.unmount()
            store.dispose()
            controller.dispose()
            release()
        }
    },
)
