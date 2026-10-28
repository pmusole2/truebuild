import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import { Keyboard, type KeyboardEvent } from 'react-native'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture, type WorkflowPreviewCase } from '../../ui/preview/workflow-fixtures'
import { GuideScreen } from './guide-screen'
import type { WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import type { WorkflowController } from './workflow-types'

const mockWindow = { width: 390, height: 844, fontScale: 1 }
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): typeof mockWindow & { scale: number } => ({ ...mockWindow, scale: 2 }),
}))
beforeEach(() => {
    Object.assign(mockWindow, { width: 390, height: 844, fontScale: 1 })
})

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

type Spies = { [K in 'camera' | 'step' | 'completeStep' | 'ask' | 'targetChanged' | 'questionChanged']: jest.Mock }

const STEP_COUNT = 3

async function setup(
    id: WorkflowPreviewCase,
    options: {
        state?: Partial<WorkflowState>
        entry?: Partial<LibraryEntry>
        controller?: Partial<WorkflowController>
        reviewStatus?: 'unreviewed'
    } = {},
): Promise<Spies> {
    const fixture = workflowPreviewFixture(id)
    const state = { ...fixture.state, ...options.state }
    const entry = { ...fixture.entry, ...options.entry }
    // The synthetic manual has two steps; a third makes step index 1 a middle step with both neighbours.
    const steps = entry.session.reviewedSteps
    if (steps.length < STEP_COUNT) {
        const last = steps[steps.length - 1]!
        entry.session.reviewedSteps = [...steps, { ...last, stepId: 'synthetic-step-3', order: last.order + 1 }]
    }
    if (options.reviewStatus !== undefined) {
        entry.session.reviewStatus = options.reviewStatus
    }
    const spies: Spies = {
        camera: jest.fn(),
        step: jest.fn(async () => undefined),
        completeStep: jest.fn(async () => undefined),
        ask: jest.fn(async () => undefined),
        targetChanged: jest.fn(),
        questionChanged: jest.fn(),
    }
    const controller: WorkflowController = { ...INERT_WORKFLOW_CONTROLLER, ...spies, ...options.controller }
    await render(<GuideScreen state={state} controller={controller} entry={entry} />)
    return spies
}

const PRIMARY = 'Take new photo and check'
const ACTIONS = [PRIMARY, 'Take photo to ask', 'Previous step', 'Next step', 'Mark step complete myself'] as const
const disabled = (name: string): unknown => screen.getByRole('button', { name }).props.accessibilityState.disabled

it('calls each public controller action exactly once with its original arguments', async () => {
    const spies = await setup('guide-photo', { entry: { stepIndex: 1 } })
    for (const name of ACTIONS) {
        await fireEvent.press(screen.getByRole('button', { name }))
    }
    expect(spies.camera.mock.calls).toEqual([[{ kind: 'check' }], [{ kind: 'question' }]])
    expect(spies.step.mock.calls).toEqual([[0], [2]])
    expect(spies.completeStep).toHaveBeenCalledTimes(1)
})

describe('action availability', () => {
    // Camera actions also wait for a reviewed manual and coverage; step moves and completion only wait for idleness.
    it.each([
        ['a request is pending', { state: { pending: 'Checking the frozen photo…' } }, [true, true, true, true, true]],
        ['storage is read-only', { state: { storageReadOnly: true } }, [true, true, true, true, true]],
        [
            'coverage blocks the step',
            { controller: { coverageNotice: (): string => 'Pages are not covered.' } },
            [true, true, false, false, false],
        ],
        ['the manual is unreviewed', { reviewStatus: 'unreviewed' as const }, [true, true, false, false, false]],
        ['the guide is idle', {}, [false, false, false, false, false]],
    ] as const)('when %s', async (_name, options, expected) => {
        await setup('guide-photo', { ...options, entry: { stepIndex: 1 } })
        expect(ACTIONS.map(disabled)).toEqual(expected)
    })

    it.each([
        ['first step', 'first', [true, false]],
        ['last step', 'last', [false, true]],
    ] as const)('stops navigation on the %s', async (_name, position, [previous, next]) => {
        await setup('guide-photo', { entry: { stepIndex: position === 'first' ? 0 : STEP_COUNT - 1 } })
        expect([disabled('Previous step'), disabled('Next step')]).toEqual([previous, next])
    })

    it('does not call the controller when a disabled action is pressed', async () => {
        const spies = await setup('guide-photo', { state: { pending: 'Checking the frozen photo…' } })
        for (const name of ACTIONS) {
            await fireEvent.press(screen.getByRole('button', { name }))
        }
        expect(spies.camera).not.toHaveBeenCalled()
        expect(spies.step).not.toHaveBeenCalled()
        expect(spies.completeStep).not.toHaveBeenCalled()
    })
})

it('keeps every step action in a dock outside the scrolling guide', async () => {
    await setup('guide-pass')
    const scroll = screen.getByTestId('guide-panel')
    expect(scroll.props.accessibilityLabel).toBe('Step guide and results')
    for (const name of ACTIONS) {
        expect(screen.getByRole('button', { name })).toBeTruthy()
        expect(within(scroll).queryByRole('button', { name })).toBeNull()
    }
    // The primary action is pinned above the secondary actions' own scroll, so it never scrolls out of reach.
    expect(within(screen.getByTestId('guide-actions')).queryByRole('button', { name: PRIMARY })).toBeNull()
})

it.each([
    ['a short phone', { width: 320, height: 568, fontScale: 1 }],
    ['large system text', { width: 390, height: 844, fontScale: 2 }],
])('keeps the composer and all actions in one reachable scroll with %s', async (_label, dimensions) => {
    Object.assign(mockWindow, dimensions)
    await setup('guide-photo')
    const scroll = within(screen.getByTestId('guide-panel'))
    expect(scroll.getByLabelText('Question about frozen photo')).toBeTruthy()
    expect(scroll.getByRole('button', { name: 'Back', exact: true })).toBeTruthy()
    for (const name of ACTIONS) {
        expect(scroll.getByRole('button', { name })).toBeTruthy()
    }
})

it('keeps the composer and all actions in one scroll while the keyboard is open, then restores the dock', async () => {
    let show: (() => void) | undefined
    let hide: (() => void) | undefined
    const listen = jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
        const call = (): void => {
            const event: KeyboardEvent = {
                duration: 0,
                easing: 'keyboard',
                endCoordinates: { height: 320, width: 390, screenX: 0, screenY: 524 },
            }
            listener(event)
        }
        if (name === 'keyboardDidShow') {
            show = call
        }
        if (name === 'keyboardDidHide') {
            hide = call
        }
        return { remove: jest.fn() }
    })
    try {
        await setup('guide-photo')
        await act(async () => show?.())
        const scroll = within(screen.getByTestId('guide-panel'))
        expect(scroll.getByLabelText('Question about frozen photo')).toBeTruthy()
        expect(scroll.getByRole('button', { name: 'Back', exact: true })).toBeTruthy()
        for (const name of ACTIONS) expect(scroll.getByRole('button', { name })).toBeTruthy()
        await act(async () => hide?.())
        expect(within(screen.getByTestId('guide-panel')).queryByRole('button', { name: PRIMARY })).toBeNull()
    } finally {
        listen.mockRestore()
    }
})

it('shows the current step, progress, parts with quantities and orientation without opening instructions', async () => {
    await setup('guide-empty')
    const { session } = workflowPreviewFixture('guide-empty').entry
    const step = session.reviewedSteps[0]!
    expect(screen.getByText(`${step.order}. ${step.title}`)).toBeTruthy()
    expect(screen.getByText(`Step 1 of ${STEP_COUNT}`)).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Guide progress' })).toBeTruthy()
    for (const part of step.parts) {
        expect(part.quantity.state).toBe('known')
        const registry = session.parts.find((candidate) => candidate.partId === part.partId)
        const name = registry?.name.state === 'known' ? registry.name.value : part.partId
        expect(screen.getByText(`${part.quantity.state === 'known' ? part.quantity.value : ''} × ${name}`)).toBeTruthy()
    }
    expect(step.orientation.state).toBe('known')
    expect(screen.getByText(step.orientation.state === 'known' ? step.orientation.value.description : '')).toBeTruthy()
    expect(screen.getByText('No photo for this step yet.')).toBeTruthy()
    expect(screen.queryByText('Ask about this photo')).toBeNull()
})

it('keeps an unknown orientation reason visible in the summary', async () => {
    const fixture = workflowPreviewFixture('review-unresolved')
    const reason = 'The inward groove is obscured in this synthetic page.'
    await setup('guide-empty', { entry: fixture.entry })
    expect(screen.getByText(`Unknown: ${reason}`)).toBeTruthy()
})

it('opens and closes the instructions sheet with the full facts and step list', async () => {
    await setup('guide-photo')
    expect(screen.queryByText('Step 1 instructions')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Step instructions' }))
    expect(screen.getByText('Step 1 instructions')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Steps marked complete' })).toBeTruthy()
    expect(screen.getAllByText(/^Orientation: /u)).toHaveLength(1)
    await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
    expect(screen.queryByText('Step 1 instructions')).toBeNull()
})

describe('results', () => {
    it('places refusal evidence before the parts summary so the comparison can fit beside the action dock', async () => {
        const fixture = workflowPreviewFixture('guide-refuse')
        const { toJSON } = await render(
            <GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />,
        )
        const tree = JSON.stringify(toJSON())
        const comparison = tree.indexOf('Manual diagram')
        const summary = tree.indexOf('"Parts"')
        expect(comparison).toBeGreaterThanOrEqual(0)
        expect(summary).toBeGreaterThanOrEqual(0)
        expect(comparison).toBeLessThan(summary)
    })

    it('places a new answer before a retained check so returning to the top reveals the answer', async () => {
        const fixture = workflowPreviewFixture('guide-answer')
        fixture.state.check = workflowPreviewFixture('guide-cannot-verify').state.check
        const { toJSON } = await render(
            <GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />,
        )
        const tree = JSON.stringify(toJSON())
        const answerPosition = tree.indexOf(fixture.state.answer!.answer)
        const checkPosition = tree.indexOf(fixture.state.check!.reason)
        expect(answerPosition).toBeGreaterThanOrEqual(0)
        expect(checkPosition).toBeGreaterThanOrEqual(0)
        expect(answerPosition).toBeLessThan(checkPosition)
        expect(screen.getByText('Cannot verify')).toBeTruthy()
    })

    it('shows a check result with its reason and missing evidence', async () => {
        await setup('guide-cannot-verify')
        expect(
            screen.getByText('Synthetic uncertainty: the groove direction is not visible from this angle.'),
        ).toBeTruthy()
        expect(screen.getByText('Missing: A clear view of the inward face and groove.')).toBeTruthy()
    })

    it('shows a neutral answer in a live region without any verdict', async () => {
        await setup('guide-answer')
        expect(screen.getByText('Answer')).toBeTruthy()
        expect(screen.getByText(/^Synthetic answer:/u)).toBeTruthy()
        for (const verdict of ['Pass', 'Refuse', 'Cannot verify']) {
            expect(screen.queryByText(verdict)).toBeNull()
        }
        expect(screen.getByText('Answer to your question from the manual pages. It is not a step check.')).toBeTruthy()
        let node = screen.getByText('Answer').parent
        while (node !== null && node !== undefined && node.props.accessibilityLiveRegion === undefined) {
            node = node.parent
        }
        expect(node?.props.accessibilityLiveRegion).toBe('polite')
    })
})

describe('question composer', () => {
    it('stays blocked without a target and chooses a step part through the controller', async () => {
        const spies = await setup('guide-photo', { state: { question: 'Which way?', target: null } })
        expect(disabled('Send question')).toBe(true)
        expect(screen.getByText('Choose a point or part.')).toBeTruthy()
        const part = workflowPreviewFixture('guide-photo').entry.session.reviewedSteps[0]!.parts[0]!.partId
        await fireEvent.press(screen.getAllByRole('radio')[0]!)
        expect(spies.targetChanged).toHaveBeenCalledTimes(1)
        expect(spies.targetChanged.mock.calls[0]![0]).toEqual({ kind: 'part', partId: part })
    })

    it.each([
        ['text and a part target', 'Which way?', { kind: 'part' as const, partId: 'side-panel' }, false],
        ['a target but blank text', '   ', { kind: 'part' as const, partId: 'side-panel' }, true],
    ])('gates Send with %s', async (_name, question, target, expectedDisabled) => {
        const spies = await setup('guide-photo', { state: { question, target } })
        expect(disabled('Send question')).toBe(expectedDisabled)
        await fireEvent.press(screen.getByRole('button', { name: 'Send question' }))
        expect(spies.ask).toHaveBeenCalledTimes(expectedDisabled ? 0 : 1)
    })

    it('stays blocked when the controller cannot compose', async () => {
        await setup('guide-answer', { controller: { canCompose: false } })
        expect(disabled('Send question')).toBe(true)
    })
})
