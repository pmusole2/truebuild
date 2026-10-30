import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { Text } from 'react-native'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { JudgeProvider, useJudge } from './judge-context'
import { createJudgeStore, JUDGE_STORAGE_KEY } from './judge-store'
import { BuiltToggleRow, BUILT_TOGGLE_LABEL, StagesPanel } from './attribution'
import { createDemoManual } from '@truebuild/contracts'
import { mandatoryFacts, MandatoryFacts } from './mandatory'
import { makeDocument } from './test-support/documents'
import { WorkflowContext, type WorkflowValue } from '../capture/workflow-context'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

describe('judge preference in the tree', () => {
    function Probe(): ReactElement {
        const { showBuilt } = useJudge()
        return <Text testID="probe">{showBuilt ? 'on' : 'off'}</Text>
    }

    it('is off with no provider at all, so a screen outside the app shows nothing extra', async () => {
        await render(wrap2(<Probe />))
        expect(screen.getByTestId('probe').props.children).toBe('off')
    })

    it('restores a saved choice after a restart and writes only its own key', async () => {
        const data = new Map<string, string>([[JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: true })]])
        const writes: string[] = []
        const storage = {
            getItem: async (key: string): Promise<string | null> => data.get(key) ?? null,
            setItem: async (key: string, value: string): Promise<void> => {
                writes.push(key)
                data.set(key, value)
            },
        }
        const store = createJudgeStore(storage)
        await render(
            wrap2(
                <JudgeProvider store={store}>
                    <BuiltToggleRow />
                </JudgeProvider>,
            ),
        )
        const toggle = await screen.findByRole('switch', { name: BUILT_TOGGLE_LABEL })
        await act(async () => store.restore())
        expect(screen.getByRole('switch', { name: BUILT_TOGGLE_LABEL }).props.accessibilityState).toMatchObject({
            checked: true,
        })
        await fireEvent.press(toggle)
        expect(screen.getByRole('switch', { name: BUILT_TOGGLE_LABEL }).props.accessibilityState).toMatchObject({
            checked: false,
        })
        await act(async () => Promise.resolve())
        expect(new Set(writes)).toEqual(new Set([JUDGE_STORAGE_KEY]))
    })

    it('is labelled exactly "Show how Meta AI built this"', () => {
        expect(BUILT_TOGGLE_LABEL).toBe('Show how Meta AI built this')
    })
})

describe('mandatory warning identity', () => {
    it('keeps the actual warning when a shown warning has the opposite numeric sign', () => {
        const session = createDemoManual()
        session.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'turn',
                note: {
                    state: 'known',
                    value: 'Rotate -90 degrees.',
                    sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                },
            },
        ]
        const document = makeDocument({
            body: [{ type: 'Warning', text: 'Rotate +90 degrees.', tone: 'caution', citations: [] }],
        })
        expect(mandatoryFacts(session, 'step-1', document).map(({ fact }) => fact.text)).toContain(
            'Rotate -90 degrees.',
        )
    })

    it('shows local required facts on an explicitly enabled native compatibility surface', async () => {
        const session = createDemoManual()
        session.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'wait',
                note: {
                    state: 'known',
                    value: 'Keep children away.',
                    sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                },
            },
        ]
        await render(wrap2(<MandatoryFacts session={session} stepId="step-1" enabled />))
        expect(screen.getByText('Keep children away.')).toBeTruthy()
    })

    it.each([
        ['the complete native sentence', 'Keep children away.', false],
        ['only a shortened native sentence', 'Keep children…', true],
        ['a different native warning', 'Keep children near.', true],
    ] as const)('deduplicates only %s', async (_label, visibleText, remains) => {
        const session = createDemoManual()
        session.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'wait',
                note: {
                    state: 'known',
                    value: 'Keep children away.',
                    sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                },
            },
        ]
        await render(wrap2(<MandatoryFacts session={session} stepId="step-1" enabled visibleText={visibleText} />))
        expect(screen.queryByText('Keep children away.') !== null).toBe(remains)
    })
})

it('pairs the retained primary model with its own timing after the shown verdict changes', async () => {
    const store = createJudgeStore({ getItem: async () => null, setItem: async () => undefined })
    store.setShowBuilt(true)
    const workflow = { state: { primary: { model: 'muse-spark-1.3', deviceMs: 240 } } } as unknown as WorkflowValue
    await render(
        wrap2(
            <WorkflowContext.Provider value={workflow}>
                <JudgeProvider store={store}>
                    <StagesPanel check={{ model: 'muse-wonder-1.0', decision: 'refuse' }} stages={null} />
                </JudgeProvider>
            </WorkflowContext.Provider>,
        ),
    )
    expect(screen.getByText('1. Verdict: muse-spark-1.3, 240 ms (measured on this phone)')).toBeTruthy()
    expect(screen.queryByText(/1\. Verdict: muse-wonder/u)).toBeNull()
})

function wrap2(node: ReactElement): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>{node}</FeedbackProvider>
        </ThemeProvider>
    )
}
