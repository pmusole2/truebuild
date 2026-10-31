import { act, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { createDemoManual, type ScreenContextInputsV2 } from '@truebuild/contracts'
import { WorkflowContext, type WorkflowValue } from '../capture/workflow-context'
import { DocumentStore, localDocument } from './store'
import { useDocument } from './use-document'
import { entry, runtime } from '../screens/test-support/route-harness'

const inputs: ScreenContextInputsV2 = {
    kind: 'guide',
    session: createDemoManual(),
    stepId: 'step-1',
    captureId: null,
    result: null,
    failure: null,
}
function Observed({
    focused,
    context = inputs,
    waiting = false,
}: {
    focused: boolean
    context?: ScreenContextInputsV2
    waiting?: boolean
}): React.JSX.Element {
    const reading = useDocument(context, { focused, state: waiting ? 'busy' : 'ready' })
    return (
        <>
            <Text testID="reading-state">{`${reading.status}:${reading.issue ?? 'none'}:${reading.document.metadata.source}`}</Text>
            <Text testID="active-state">{reading.activeState}</Text>
            <Text testID="visible-variant">{JSON.stringify(reading.variant)}</Text>
        </>
    )
}

it('keeps a delivered verdict or Answer visible when only its screen composition times out', async () => {
    const sourceRefs = [{ pageId: inputs.session!.pages[0]!.pageId, region: null }]
    const contexts: ScreenContextInputsV2[] = [
        inputs,
        {
            ...inputs,
            kind: 'result',
            captureId: 'timeout-photo',
            result: {
                kind: 'check',
                value: {
                    decision: 'pass',
                    reason: 'The groove faces inward.',
                    sourceRefs,
                    missingEvidence: [],
                    observedRegion: null,
                },
            },
        },
        {
            ...inputs,
            kind: 'answer',
            captureId: 'timeout-photo',
            result: {
                kind: 'question',
                question: 'Which way?',
                value: { answer: 'Keep the groove inward.', sourceRefs, missingEvidence: [] },
            },
        },
    ]
    for (const context of contexts) {
        const store = new DocumentStore({ mode: 'off', id: (): string => 'timeout' })
        const document = localDocument(context, 'timeout')
        jest.spyOn(store, 'peek').mockReturnValue({ status: 'ready', document, issue: 'timeout' })
        const { controller } = await runtime([entry()])
        const value: WorkflowValue = {
            controller,
            state: controller.getSnapshot(),
            entry: entry(),
            screens: null,
            documents: store,
        }
        const view = await render(
            <WorkflowContext.Provider value={value}>
                <Observed focused context={context} />
            </WorkflowContext.Provider>,
        )
        try {
            expect(screen.getByTestId('active-state').props.children).toBe(context.kind === 'guide' ? 'error' : 'ready')
            if (context.kind === 'guide')
                expect(screen.getByTestId('visible-variant').props.children).toContain('That took too long')
            else {
                expect(screen.getByTestId('visible-variant').props.children).toContain('"type":"VerdictCard"')
                expect(screen.getByTestId('visible-variant').props.children).toContain(
                    context.kind === 'result' ? '"result":"check"' : '"result":"question"',
                )
            }
        } finally {
            await view.unmount()
            store.dispose()
            controller.dispose()
            jest.restoreAllMocks()
        }
    }
})

it('a focused pending screen gets a complete fallback immediately on cache eviction; only refocus requests again', async () => {
    const next = { ...inputs, stepId: 'step-2' }
    const bytes = (context: ScreenContextInputsV2): number =>
        new TextEncoder().encode(JSON.stringify(localDocument(context, 'busy'))).byteLength
    const screensV2 = jest.fn(() => new Promise<never>(() => undefined))
    const store = new DocumentStore({
        client: { screensV2 },
        mode: 'full',
        id: (): string => 'id',
        maxDocumentBytes: Math.max(bytes(inputs), bytes(next)) + 64,
    })
    const { controller } = await runtime([entry()])
    const value: WorkflowValue = {
        controller,
        state: controller.getSnapshot(),
        entry: entry(),
        screens: null,
        documents: store,
    }
    const tree = (focused: boolean, waiting = false): React.JSX.Element => (
        <WorkflowContext.Provider value={value}>
            <Observed
                focused={focused}
                waiting={waiting}
                context={waiting ? { ...inputs, uiState: { busy: { activity: 'working' } } } : inputs}
            />
        </WorkflowContext.Provider>
    )
    const view = await render(tree(true))
    try {
        expect(screen.getByTestId('reading-state').props.children).toBe('pending:none:fallback')
        await view.rerender(tree(true, true))
        expect(screensV2).toHaveBeenCalledTimes(1)
        await view.rerender(tree(true))
        await act(async () => {
            store.request(next)
        })
        expect(screen.getByTestId('reading-state').props.children).toBe('ready:budget_exhausted:fallback')
        expect(screensV2).toHaveBeenCalledTimes(2)
        await view.rerender(tree(false))
        expect(screensV2).toHaveBeenCalledTimes(2)
        await view.rerender(tree(true))
        expect(screensV2).toHaveBeenCalledTimes(3)
    } finally {
        await view.unmount()
        store.dispose()
        controller.dispose()
    }
})
