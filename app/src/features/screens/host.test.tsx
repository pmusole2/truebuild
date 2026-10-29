import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { Text } from 'react-native'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import type { CoachCandidate } from '../onboarding/coach-types'
import { applyTips, composeBar } from './host'
import { JudgeProvider, useJudge } from './judge-context'
import { createJudgeStore, JUDGE_STORAGE_KEY } from './judge-store'
import { BuiltToggleRow, BUILT_TOGGLE_LABEL, StagesPanel } from './attribution'
import type { GeneratedScreen, ScreenSlot } from './use-screen-slot'
import { createDemoManual } from '@truebuild/contracts'
import { mandatoryFacts, MandatoryFacts } from './mandatory'
import { makeDocument } from './test-support/documents'
import { WorkflowContext, type WorkflowValue } from '../capture/workflow-context'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

const candidate = (id: string, sentence = `native ${id}`): CoachCandidate => ({
    id,
    kind: 'control',
    heading: `H ${id}`,
    sentence,
})
const ready = (overrides: Partial<GeneratedScreen> = {}): ScreenSlot => ({
    status: 'ready',
    key: 'k',
    kind: 'guide',
    screen: {
        tips: new Map(),
        bar: { primary: { label: 'Composed', onPress: jest.fn(), nativeID: 'x' }, secondary: undefined },
        document: { body: [] },
        ...overrides,
    } as unknown as GeneratedScreen,
})

describe('coach copy and order from the document', () => {
    const native = [candidate('home-add'), candidate('header-more'), candidate('keep-building')]

    it('leaves the native tips alone without a composed screen', () => {
        expect(applyTips(native, undefined)).toBe(native)
        expect(applyTips(native, { status: 'pending', key: 'k', kind: 'home' })).toBe(native)
        expect(applyTips(native, ready())).toBe(native)
    })

    it('rewords and reorders only tips the screen really has, in the document’s order, keeping the rest after them', () => {
        const slot = ready({
            tips: new Map([
                ['header-more', { heading: 'More help', text: 'Everything else is here.' }],
                ['home-add', { heading: 'Start', text: 'Add your manual here.' }],
                ['camera-shutter', { heading: 'Not here', text: 'This screen has no shutter.' }],
            ]),
        })
        expect(applyTips(native, slot).map((tip) => [tip.id, tip.heading, tip.sentence])).toEqual([
            ['header-more', 'More help', 'Everything else is here.'],
            ['home-add', 'Start', 'Add your manual here.'],
            ['keep-building', 'H keep-building', 'native keep-building'],
        ])
    })
})

describe('the bar', () => {
    const nativeBar = {
        primary: { label: 'Native', testID: 'guide-primary', onPress: jest.fn() },
        secondary: { label: 'Native second', testID: 'second', onPress: jest.fn() },
    }
    const composed = ready({
        bar: {
            primary: { label: 'Composed', onPress: jest.fn(), nativeID: 'p' },
            secondary: { label: 'Composed second', onPress: jest.fn(), nativeID: 's' },
        },
    })

    it('is the native bar without a composed screen, and when a native state must win', () => {
        expect(composeBar(nativeBar, undefined)).toBe(nativeBar)
        expect(composeBar(nativeBar, composed, true)).toBe(nativeBar)
    })

    it('takes the document’s words and actions but keeps the native test identities', () => {
        const bar = composeBar(nativeBar, composed)
        expect(bar.primary).toMatchObject({ label: 'Composed', testID: 'guide-primary', nativeID: 'p' })
        expect(bar.secondary).toMatchObject({ label: 'Composed second', testID: 'second', nativeID: 's' })
    })

    it('never gains a secondary the document did not compose', () => {
        const single = ready({ bar: { primary: { label: 'Only', onPress: jest.fn() }, secondary: undefined } })
        expect(composeBar(nativeBar, single).secondary).toBeUndefined()
    })
})

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

    it('shows local required facts while an enabled native-pending surface has no slot', async () => {
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
        await render(wrap2(<MandatoryFacts session={session} stepId="step-1" slot={undefined} enabled />))
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
        await render(
            wrap2(
                <MandatoryFacts session={session} stepId="step-1" slot={undefined} enabled visibleText={visibleText} />,
            ),
        )
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
                    <StagesPanel
                        check={{ model: 'muse-wonder-1.0', decision: 'refuse' }}
                        stages={null}
                        resultSlot={undefined}
                    />
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
