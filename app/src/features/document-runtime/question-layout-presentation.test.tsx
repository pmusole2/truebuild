import { useSyncExternalStore, type ReactElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { StyleSheet, Text } from 'react-native'
import {
    screenDocumentV2Schema,
    variantsOfV2,
    type ScreenContextInputsV2,
    type ScreenProposalV2,
} from '@truebuild/contracts'
import { CaptureController } from '../capture/controller'
import { WorkflowContext, type WorkflowValue } from '../capture/workflow-context'
import { documentInputs } from '../capture/document-inputs'
import { defaultNav } from '../capture/screen-nav'
import { bytes, deferred, entry, runtime, source } from '../screens/test-support/route-harness'
import { fixtureDocuments } from '../screens/test-support/fixture-server'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { DocumentRenderer } from '../documents/document-renderer'
import type { FrameBindings } from '../documents/types'
import { DocumentStore, documentKey } from './store'
import { useDocument } from './use-document'
import { recordedDocument } from './recorded-runtime'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

/** Exactly the native fixture's cards arrangement, including the photo in all six Question variants. */
function cardQuestion(proposal: ScreenProposalV2, inputs: ScreenContextInputsV2): ScreenProposalV2 {
    if (inputs.kind !== 'questions') return proposal
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

function value(controller: CaptureController, store: DocumentStore): WorkflowValue {
    return { controller, state: controller.getSnapshot(), entry: controller.current, screens: null, documents: store }
}
function inputs(controller: CaptureController, store: DocumentStore): ScreenContextInputsV2 {
    return documentInputs('questions', value(controller, store))
}
function Observed({ workflow }: { workflow: WorkflowValue }): ReactElement {
    const context = documentInputs('questions', workflow)
    const reading = useDocument(context, {
        // A replacement shutter temporarily leaves the Guide for the camera; that hidden Question cannot request work.
        focused: workflow.state.route === 'guide',
        state: workflow.state.pending === null ? 'ready' : 'busy',
    })
    const { controller, state, entry: selected } = workflow
    const bindings: FrameBindings = {
        // This slice calls the real controller's ask port directly. Route-level Ask intent resolution has its own
        // real-router tests; no mocked resolver dispatch is used as evidence here.
        resolve: () => ({ enabled: true, reason: null, run: (): void => undefined }),
        live: {
            state,
            entry: selected,
            controller,
            nav: defaultNav(controller),
            more: { open: true, mode: 'ask', show: (): void => undefined, hide: (): void => undefined },
        },
        session: selected?.session,
        pageUris: state.pageUris,
        capture: state.capture,
        marks: [],
        heroMode: 'inline',
        inspect: false,
        workInProgress: state.pending !== null,
    }
    return (
        <>
            <Text testID="question-origin">{`${reading.document.metadata.source}:${reading.document.metadata.authoring?.fixtureId ?? 'exact'}`}</Text>
            <DocumentRenderer document={reading.document} variant={reading.activeState} bindings={bindings} />
        </>
    )
}
function Fixture({ controller, store }: { controller: CaptureController; store: DocumentStore }): ReactElement {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    const workflow = { ...value(controller, store), state }
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <WorkflowContext.Provider value={workflow}>
                    <Observed workflow={workflow} />
                </WorkflowContext.Provider>
            </FeedbackProvider>
        </ThemeProvider>
    )
}
async function loadPhoto(): Promise<void> {
    await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
        nativeEvent: { layout: { width: 390, height: 520 } },
    })
    await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
}
async function freshQuestion(controller: CaptureController): Promise<void> {
    await controller.restore()
    await controller.open(controller.getSnapshot().entries[0]!.session.manualId, 'guide')
    controller.camera({ kind: 'question' })
    await controller.shutter(async () => source)
    expect(controller.getSnapshot().check).toBeNull()
    expect(controller.getSnapshot().capture?.reusable).toBe(true)
}

/** Independent HTTP gates make Asking and the subsequent real 202 observable without replaying controller states. */
async function questionRuntime(
    ticket: Promise<void>,
    answer: Promise<void>,
): Promise<{
    controller: CaptureController
    calls: string[]
}> {
    const seeded = await runtime([entry()])
    seeded.controller.dispose()
    const calls: string[] = []
    let sourcePageId = ''
    const fetch: ModelFetch = async (url, init) => {
        const path = new URL(url).pathname
        calls.push(path)
        const collecting = path === '/api/questions/result'
        if (path !== '/api/questions' && !collecting) throw new Error(`Unexpected question-only request: ${path}`)
        const metadata = JSON.parse(String(collecting ? init.body : (init.body as FormData).get('metadata'))) as {
            requestId: string
            binding: Record<string, unknown>
            sourcePageIds?: string[]
        }
        if (!collecting) {
            sourcePageId = metadata.sourcePageIds![0]!
            await ticket
            return new Response(
                JSON.stringify({
                    status: 'pending',
                    requestId: metadata.requestId,
                    binding: metadata.binding,
                    ticket: 'question-layout-ticket',
                    retryAfterMs: 500,
                    expiresInMs: 30_000,
                }),
                { status: 202, headers: { 'content-type': 'application/json' } },
            )
        }
        await answer
        return new Response(
            JSON.stringify({
                status: 'ok',
                mode: 'model',
                requestId: metadata.requestId,
                binding: metadata.binding,
                value: {
                    answer: 'The groove faces inward.',
                    sourceRefs: [{ pageId: sourcePageId, region: null }],
                    missingEvidence: [],
                },
            }),
            { headers: { 'content-type': 'application/json' } },
        )
    }
    let id = 0
    return {
        controller: new CaptureController({
            storage: seeded.storage,
            client: new ModelApiClient({ baseUrl: 'https://flow.invalid', secret: '', fetch }),
            digest: async (): Promise<string> => 'a'.repeat(64),
            normalize: async () => ({ ...source, bytes, mimeType: 'image/jpeg' as const }),
            id: (): string => `question-layout-${++id}`,
        }),
        calls,
    }
}

it.each(['cached before mount', 'late while active'] as const)(
    'keeps one loaded fresh Question image through point/draft, Asking and a 202 when native cards are %s',
    async (timing) => {
        const answer = deferred<void>()
        const ticket = deferred<void>()
        const { controller, calls } = await questionRuntime(ticket.promise, answer.promise)
        await freshQuestion(controller)
        const exact = deferred<void>()
        const server = fixtureDocuments({
            generated: ['questions'],
            arrange: cardQuestion,
            ...(timing === 'late while active' ? { gate: exact.promise } : {}),
        })
        // These are genuine legacy exact responses, started before the record is enabled. Current normal Questions
        // use their saved editable form without another layout request; an existing flight/cache must remain intact.
        let recordingEnabled = false
        const store = new DocumentStore({
            client: server,
            mode: 'full',
            id: (): string => 'question-photo-layout',
            recordings: (context): ReturnType<typeof recordedDocument> =>
                recordingEnabled ? recordedDocument(context) : null,
        })
        const initial = inputs(controller, store)
        if (timing === 'cached before mount') await store.waitForGenerated(initial)
        else {
            store.request(initial)
            await waitFor(() => expect(server.requests).toHaveLength(1))
        }
        recordingEnabled = true
        const view = await render(<Fixture controller={controller} store={store} />)
        try {
            const firstOrigin = screen.getByTestId('question-origin').props.children as string
            await loadPhoto()
            const photo = screen.getByTestId('frozen-photo-image')
            const uri = photo.props.source.uri as string
            const samePhoto = (): void => {
                expect(screen.getByTestId('frozen-photo-image') === photo).toBe(true)
                expect(StyleSheet.flatten(photo.props.style).width).toBeGreaterThan(0)
                expect(screen.getByTestId('frozen-photo-image').props.source.uri).toBe(uri)
            }
            samePhoto()
            const initialKey = documentKey(initial)
            const captureId = controller.getSnapshot().capture!.binding.captureId
            // Point-only is the native regression path: no named-part target and no prior checked Result.
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'accessibilityTap')
            await fireEvent.changeText(screen.getByLabelText('Your question'), 'Is this facing the right way?')
            expect(controller.getSnapshot().target).toEqual({ kind: 'point', x: 0.5, y: 0.5 })
            expect(controller.getSnapshot().question).toBe('Is this facing the right way?')
            expect(documentKey(inputs(controller, store))).toBe(initialKey)
            expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy()
            const editor = screen.getByLabelText('Your question')
            if (timing === 'late while active') {
                await act(async () => exact.resolve())
                await waitFor(() => expect(store.peek(initial)?.document.metadata.source).toBe('generated'))
            }
            // A valid exact response cannot replace the loaded image or the editor holding the person's draft.
            samePhoto()
            expect(screen.getByLabelText('Your question') === editor).toBe(true)
            expect(editor.props.value).toBe('Is this facing the right way?')
            const cached = store.peek(initial)!.document
            expect(screenDocumentV2Schema.safeParse(cached).success).toBe(true)
            expect(cached.metadata.authoring).toBeUndefined()

            let question!: Promise<void>
            await act(async () => {
                question = controller.ask()
            })
            const asking = inputs(controller, store)
            expect(asking.uiState?.busy?.activity).toBe('asking')
            await waitFor(() => expect(store.peek(asking)?.document.metadata.source).toBe('generated'))
            samePhoto()
            expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull()
            await act(async () => ticket.resolve())
            await waitFor(() => expect(controller.getSnapshot().pending).toMatch(/^Still thinking/u))
            const waiting = inputs(controller, store)
            expect(waiting.uiState?.busy?.activity).toBe('question-waiting')
            expect(documentKey(waiting)).not.toBe(documentKey(asking))
            await waitFor(() => expect(store.peek(waiting)?.document.metadata.source).toBe('generated'))
            samePhoto()
            expect(screen.getByTestId('question-origin').props.children).toBe(
                'generated:recorded-question-layout-sol-v1',
            )
            expect(firstOrigin).toBe('generated:recorded-question-layout-sol-v1')
            // One pre-existing exact request is preserved. The current form and activity keys launch no new ones.
            expect(server.requests).toHaveLength(1)
            expect(store.peek(initial)!.document).toBe(cached)
            expect(controller.getSnapshot().capture?.binding.captureId).toBe(captureId)
            expect(controller.getSnapshot().target).toEqual({ kind: 'point', x: 0.5, y: 0.5 })
            expect(controller.getSnapshot().question).toBe('Is this facing the right way?')
            expect(calls.filter((path) => path === '/api/questions')).toHaveLength(1)
            expect(calls.filter((path) => path === '/api/checks')).toHaveLength(0)
            await act(async () => {
                answer.resolve()
                await question
            })
            expect(controller.getSnapshot().answer?.answer).toBe('The groove faces inward.')
            expect(calls.filter((path) => path === '/api/questions')).toHaveLength(1)
            expect(calls.filter((path) => path === '/api/questions/result')).toHaveLength(1)
            expect(server.requests).toHaveLength(1)
        } finally {
            ticket.resolve()
            answer.resolve()
            exact.resolve()
            await view.unmount()
            store.dispose()
            controller.dispose()
        }
    },
)

it.each(['off', 'steps', 'no recording'] as const)(
    'keeps Question fallback honest and exact composition eligible with %s',
    async (mode) => {
        const { controller } = await runtime([entry()])
        await freshQuestion(controller)
        const server = fixtureDocuments({ generated: ['questions'], arrange: cardQuestion })
        const store = new DocumentStore({
            client: server,
            mode: mode === 'no recording' ? 'full' : mode,
            id: (): string => 'no-question-record',
            ...(mode === 'no recording' ? { recordings: (): null => null } : {}),
        })
        try {
            const context = inputs(controller, store)
            const preview = store.preview(context)
            expect(preview.document.metadata.source).toBe('fallback')
            expect(preview.document.metadata.authoring).toBeUndefined()
            expect(preview.document.metadata.fallbackReason).toBe(mode === 'no recording' ? 'busy' : 'disabled')
            await store.waitForGenerated(context)
            expect(server.requests).toHaveLength(mode === 'no recording' ? 1 : 0)
            if (mode === 'no recording') {
                expect(store.peek(context)?.document.metadata.source).toBe('generated')
                expect(store.peek(context)?.document.metadata.authoring).toBeUndefined()
            }
        } finally {
            store.dispose()
            controller.dispose()
        }
    },
)

it('does not inherit a loaded Question image witness for a different fresh capture', async () => {
    const { controller } = await runtime([entry()])
    await freshQuestion(controller)
    const exact = deferred<void>()
    const server = fixtureDocuments({ generated: ['questions'], arrange: cardQuestion, gate: exact.promise })
    const store = new DocumentStore({ client: server, mode: 'full', id: (): string => 'next-question-photo' })
    const view = await render(<Fixture controller={controller} store={store} />)
    try {
        await loadPhoto()
        expect(server.requests).toHaveLength(0)
        expect(screen.getByTestId('question-origin').props.children).toBe('generated:recorded-question-layout-sol-v1')
        const captureId = controller.getSnapshot().capture!.binding.captureId
        await act(async () => {
            controller.camera({ kind: 'question' })
            await controller.shutter(async () => source)
        })
        expect(controller.getSnapshot().capture!.binding.captureId).not.toBe(captureId)
        expect(StyleSheet.flatten(screen.getByTestId('frozen-photo-image').props.style).width).toBe(0)
        expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull()
        await loadPhoto()
        expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy()
        expect(server.requests).toHaveLength(0)
        expect(controller.getSnapshot().check).toBeNull()
    } finally {
        exact.resolve()
        await view.unmount()
        store.dispose()
        controller.dispose()
    }
})
