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
function Observed({ focused }: { focused: boolean }): React.JSX.Element {
    const reading = useDocument(inputs, { focused })
    return (
        <Text testID="reading-state">{`${reading.status}:${reading.issue ?? 'none'}:${reading.document.metadata.source}`}</Text>
    )
}

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
    const tree = (focused: boolean): React.JSX.Element => (
        <WorkflowContext.Provider value={value}>
            <Observed focused={focused} />
        </WorkflowContext.Provider>
    )
    const view = await render(tree(true))
    try {
        expect(screen.getByTestId('reading-state').props.children).toBe('pending:none:fallback')
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
