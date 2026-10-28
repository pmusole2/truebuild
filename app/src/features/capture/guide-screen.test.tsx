import type { ReactElement } from 'react'
import type { CheckResult, Layout } from '@truebuild/contracts'
import { act, fireEvent, render as renderScreen, screen, within } from '@testing-library/react-native'
import { Keyboard, PanResponder, Platform, StyleSheet, type KeyboardEvent, type StyleProp } from 'react-native'
import { FeedbackProvider } from '../../ui/feedback'
import { spies as animationSpies } from '../../ui/test-support/reanimated-mock'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture, type WorkflowPreviewCase } from '../../ui/preview/workflow-fixtures'
import { EDGE_RESERVE, GuideScreen, startsAtSystemEdge } from './guide-screen'
import { plainWords } from './plain-copy'
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

// Evidence, comparison and citation tests all read More. This opens it right after each render in those suites.
let autoMore = false
const render: typeof renderScreen = async (ui, options) => {
    const result = await renderScreen(ui, options)
    if (autoMore) {
        await fireEvent.press(screen.getByRole('button', { name: 'More' }))
    }
    return result
}

// The default surface is the hero, one sentence and the primary. Everything else is in the More sheet, opened from the
// header's More button.
const openMore = async (): Promise<void> => {
    await fireEvent.press(screen.getByRole('button', { name: 'More' }))
}
const more = (): ReturnType<typeof within> => within(screen.getByTestId('more-sheet'))

async function setup(
    id: WorkflowPreviewCase,
    options: {
        state?: Partial<WorkflowState>
        entry?: Partial<LibraryEntry>
        controller?: Partial<WorkflowController>
        reviewStatus?: 'unreviewed'
        more?: boolean
        // Open More on the question composer, through its early row.
        ask?: boolean
        // Open the discreet judge entry in More, where the judge and demo controls live.
        judge?: boolean
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
    if (options.more === true) {
        await openMore()
        if (options.ask === true) {
            await fireEvent.press(screen.getByRole('button', { name: 'Ask about this step' }))
        }
        if (options.judge === true) {
            await fireEvent.press(screen.getByTestId('judge-entry'))
        }
    }
    return spies
}

const PRIMARY = 'Take photo'
// Asking is an early row in More that switches the same sheet to the composer, where Take photo to ask lives.
const MORE_ACTIONS = ['Ask about this step', 'Previous step', 'Next step', 'Mark step complete myself'] as const
// RNTL treats everything behind an open modal sheet as hidden, so the default surface is read with this option.
const behind = { includeHiddenElements: true } as const
const disabled = (name: string): unknown =>
    screen.getByRole('button', { name, ...behind }).props.accessibilityState.disabled
const primaryDisabled = (): unknown => screen.getByTestId('guide-primary', behind).props.accessibilityState.disabled

it('calls each public controller action exactly once with its original arguments', async () => {
    const spies = await setup('guide-photo', { entry: { stepIndex: 1 } })
    await fireEvent.press(screen.getByRole('button', { name: PRIMARY }))
    await openMore()
    for (const name of ['Previous step', 'Next step', 'Mark step complete myself', 'Ask about this step']) {
        await fireEvent.press(screen.getByRole('button', { name }))
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Take photo to ask' }))
    expect(spies.camera.mock.calls).toEqual([[{ kind: 'check' }], [{ kind: 'question' }]])
    expect(spies.step.mock.calls).toEqual([[0], [2]])
    expect(spies.completeStep).toHaveBeenCalledTimes(1)
})

describe('the primary after a pass is the person’s own completion', () => {
    it('Next step records the step as done and moves on, instead of only browsing', async () => {
        const spies = await setup('guide-pass', { entry: { stepIndex: 0 } })
        await fireEvent.press(screen.getByRole('button', { name: 'Next step' }))
        expect(spies.completeStep).toHaveBeenCalledTimes(1)
        expect(spies.step).not.toHaveBeenCalled()
    })

    it('Finish on the last step records it through the same completion', async () => {
        const spies = await setup('guide-pass', { entry: { stepIndex: STEP_COUNT - 1 } })
        await fireEvent.press(screen.getByRole('button', { name: 'Finish' }))
        expect(spies.completeStep).toHaveBeenCalledTimes(1)
        expect(spies.step).not.toHaveBeenCalled()
    })

    it('browsing from More never records a completion', async () => {
        const spies = await setup('guide-pass', { entry: { stepIndex: 1 }, more: true })
        await fireEvent.press(screen.getByRole('button', { name: 'Previous step' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Next step' }))
        expect(spies.step.mock.calls).toEqual([[0], [2]])
        expect(spies.completeStep).not.toHaveBeenCalled()
    })

    it('does not repeat the saved-progress notice as a second sentence under the instruction', async () => {
        await setup('guide-photo', {
            state: { notice: 'Progress saved as your own completion. Take a new photo for the next check.' },
        })
        expect(screen.queryByText('Marked as done. Take a new photo for the next step.')).toBeNull()
    })

    it('after Finish leaves earlier steps open, offers the first open step instead of another Take photo', async () => {
        const spies = await setup('guide-empty', {
            entry: { stepIndex: STEP_COUNT - 1, completedStepIds: ['synthetic-step-3'] },
        })
        expect(screen.getByText('Step 1 is not marked done yet.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Go to step 1' }))
        expect(spies.step.mock.calls).toEqual([[0]])
        expect(spies.completeStep).not.toHaveBeenCalled()
    })

    it('keeps Take photo when every earlier step is marked too', async () => {
        const ids = workflowPreviewFixture('guide-empty').entry.session.reviewedSteps.map((step) => step.stepId)
        await setup('guide-empty', {
            entry: { stepIndex: STEP_COUNT - 1, completedStepIds: [...ids, 'synthetic-step-3'] },
        })
        expect(screen.queryByText(/is not marked done yet/u)).toBeNull()
        expect(screen.getByRole('button', { name: 'Take photo' })).toBeTruthy()
    })
})

describe('action availability', () => {
    // Camera actions also wait for a reviewed manual and coverage; step moves and completion only wait for idleness.
    // When coverage or the unanswered questions block the step, the primary becomes the way forward (answer the
    // questions or add clearer photos) and stays pressable; only the camera actions are held back.
    it.each([
        [
            'a request is pending',
            { state: { pending: 'Checking the frozen photo…' } },
            [true, false, true, true, true, true],
        ],
        ['storage is read-only', { state: { storageReadOnly: true } }, [true, false, true, true, true, true]],
        [
            'coverage blocks the step',
            { controller: { coverageNotice: (): string => 'Pages are not covered.' } },
            [false, false, false, false, false, true],
        ],
        [
            'the manual is unreviewed',
            { reviewStatus: 'unreviewed' as const },
            [false, false, false, false, false, true],
        ],
        ['the guide is idle', {}, [false, false, false, false, false, false]],
    ] as const)('when %s', async (_name, options, expected) => {
        await setup('guide-photo', { ...options, entry: { stepIndex: 1 }, more: true })
        const available = [primaryDisabled(), ...MORE_ACTIONS.map(disabled)]
        await fireEvent.press(screen.getByRole('button', { name: 'Ask about this step' }))
        expect([...available, disabled('Take photo to ask')]).toEqual(expected)
    })

    it.each([
        ['first step', 'first', [true, false]],
        ['last step', 'last', [false, true]],
    ] as const)('stops navigation on the %s', async (_name, position, [previous, next]) => {
        await setup('guide-photo', { entry: { stepIndex: position === 'first' ? 0 : STEP_COUNT - 1 }, more: true })
        expect([disabled('Previous step'), disabled('Next step')]).toEqual([previous, next])
        // No arrows sit on the picture: stepping is a swipe on it, or in More.
        expect(screen.queryByRole('button', { name: 'Earlier step', ...behind })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Later step', ...behind })).toBeNull()
    })

    it('does not call the controller when a disabled action is pressed', async () => {
        const spies = await setup('guide-photo', { state: { pending: 'Checking the frozen photo…' }, more: true })
        await fireEvent.press(screen.getByTestId('guide-primary', behind))
        for (const name of ['Previous step', 'Next step', 'Mark step complete myself', 'Ask about this step']) {
            await fireEvent.press(screen.getByRole('button', { name }))
        }
        await fireEvent.press(screen.getByRole('button', { name: 'Take photo to ask' }))
        expect(spies.camera).not.toHaveBeenCalled()
        expect(spies.step).not.toHaveBeenCalled()
        expect(spies.completeStep).not.toHaveBeenCalled()
    })
})

it('keeps the primary in a fixed bar outside the scrolling text, with every other action in More', async () => {
    await setup('guide-photo')
    const scroll = screen.getByTestId('guide-panel')
    const bar = within(screen.getByTestId('bottom-bar'))
    expect(bar.getByTestId('guide-primary')).toBeTruthy()
    expect(within(scroll).queryByTestId('guide-primary')).toBeNull()
    // One primary, and no second button in the bar.
    expect(bar.getAllByRole('button')).toHaveLength(1)
    for (const name of MORE_ACTIONS) {
        expect(screen.queryByRole('button', { name })).toBeNull()
    }
    await openMore()
    for (const name of MORE_ACTIONS) {
        expect(more().getByRole('button', { name })).toBeTruthy()
    }
})

describe('the hero stays large and pinned', () => {
    const heroHeight = (): number => {
        const flat = StyleSheet.flatten(screen.getByTestId('guide-hero').props.style) as { height: number }
        return flat.height
    }

    it.each([
        ['a standard phone', { width: 390, height: 844, fontScale: 1 }, 464],
        ['a short phone', { width: 320, height: 568, fontScale: 1 }, 312],
        [
            'large system text, with only overflowing instructions scrolling',
            { width: 390, height: 844, fontScale: 2 },
            464,
        ],
    ])('takes 55 percent of the window on %s', async (_label, dimensions, expected) => {
        Object.assign(mockWindow, dimensions)
        await setup('guide-empty')
        expect(heroHeight()).toBe(expected)
        // Only the text region scrolls; the primary is outside it.
        expect(within(screen.getByTestId('guide-panel')).queryByRole('button', { name: PRIMARY })).toBeNull()
        expect(screen.getByRole('button', { name: PRIMARY })).toBeTruthy()
    })

    it('shrinks the hero while the keyboard is open, then restores it', async () => {
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
            expect(heroHeight()).toBeLessThan(464)
            expect(screen.getByRole('button', { name: PRIMARY })).toBeTruthy()
            await act(async () => hide?.())
            expect(heroHeight()).toBe(464)
        } finally {
            listen.mockRestore()
        }
    })
})

it('shows the step in one sentence with its parts, and the step picture as the hero, before any photo', async () => {
    await setup('guide-empty')
    const { session } = workflowPreviewFixture('guide-empty').entry
    const step = session.reviewedSteps[0]!
    expect(screen.getByText(step.title)).toBeTruthy()
    expect(screen.getByText(`Step 1 of ${STEP_COUNT}`)).toBeTruthy()
    expect(screen.getByTestId('guide-hero')).toBeTruthy()
    const names = step.parts.map((part) => {
        const registry = session.parts.find((candidate) => candidate.partId === part.partId)
        const name = registry?.name.state === 'known' ? registry.name.value : 'a part'
        return `${name} ×${part.quantity.state === 'known' ? part.quantity.value : ''}`
    })
    expect(screen.getByText(`You need: ${names.join(', ')}`)).toBeTruthy()
    // Nothing else competes on the default surface: no guide progress bar, no ask card, no step list.
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText('Ask about this photo')).toBeNull()
    expect(screen.queryByText('No photo for this step yet.')).toBeNull()
})

it('keeps an unknown orientation reason in the full step, in More', async () => {
    const fixture = workflowPreviewFixture('review-unresolved')
    const reason = 'The inward groove is obscured in this synthetic page.'
    await setup('guide-empty', { entry: fixture.entry, more: true })
    expect(more().getByText(`Which way it faces: The manual does not say. ${reason}`)).toBeTruthy()
})

it('opens and closes More with the full step, the earlier progress and the step list', async () => {
    await setup('guide-photo')
    expect(screen.queryByText('More about this step')).toBeNull()
    await openMore()
    expect(screen.getByText('More about this step')).toBeTruthy()
    expect(more().getByRole('progressbar', { name: 'Steps marked complete' })).toBeTruthy()
    expect(more().getAllByText(/^Which way it faces: /u)).toHaveLength(1)
    await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(screen.queryByText('More about this step')).toBeNull()
})

describe('results', () => {
    it('says the verdict in one sentence on the hero, with the full reason in More', async () => {
        await setup('guide-pass')
        const check = workflowPreviewFixture('guide-pass').state.check!
        // The default surface says the model's reason in plain words: "Synthetic" is not shown there.
        expect(screen.getByText(`Looks right. ${plainWords(check.reason)}`)).toBeTruthy()
        expect(screen.queryByText(/Synthetic result/u)).toBeNull()
        // The verdict tag, missing-evidence list and provenance are not on the default surface.
        expect(screen.queryByText('Looks right')).toBeNull()
        await openMore()
        expect(more().getByText('Looks right')).toBeTruthy()
        expect(more().getByText(check.reason)).toBeTruthy()
    })

    it('places refusal evidence before the parts summary so the comparison reads first in More', async () => {
        const fixture = workflowPreviewFixture('guide-refuse')
        const { toJSON } = await render(
            <GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />,
        )
        await openMore()
        const tree = JSON.stringify(toJSON())
        const comparison = tree.indexOf('Manual diagram')
        const summary = tree.indexOf('"Parts"')
        expect(comparison).toBeGreaterThanOrEqual(0)
        expect(summary).toBeGreaterThanOrEqual(0)
        expect(comparison).toBeLessThan(summary)
    })

    it('places a new answer before a retained check so the answer reads first in More', async () => {
        const fixture = workflowPreviewFixture('guide-answer')
        fixture.state.check = workflowPreviewFixture('guide-cannot-verify').state.check
        await render(<GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        await openMore()
        // Compare the actual sentences within More, excluding both its heading and the hero's copy of the answer.
        const details = JSON.stringify(screen.getByTestId('more-sheet').toJSON())
        const answerPosition = details.indexOf(fixture.state.answer!.answer)
        const checkPosition = details.indexOf(fixture.state.check!.reason)
        expect(answerPosition).toBeGreaterThanOrEqual(0)
        expect(checkPosition).toBeGreaterThanOrEqual(0)
        expect(answerPosition).toBeLessThan(checkPosition)
        expect(more().getByText('Can’t tell')).toBeTruthy()
    })

    it('shows a check result with its reason and missing evidence in More', async () => {
        await setup('guide-cannot-verify', { more: true })
        expect(
            more().getByText('Synthetic uncertainty: the groove direction is not visible from this angle.'),
        ).toBeTruthy()
        expect(more().getByText('Missing: A clear view of the inward face and groove.')).toBeTruthy()
    })

    it('says "We can’t tell" plainly for an unverifiable photo and never prints the system phrase', async () => {
        await setup('guide-cannot-verify')
        expect(screen.getByText(/^We can't tell from this photo\./u)).toBeTruthy()
        expect(screen.queryByText(/cannot verify/iu)).toBeNull()
    })

    it('shows a neutral answer in a live region without any verdict', async () => {
        await setup('guide-answer', { more: true })
        expect(more().getByText('Answer')).toBeTruthy()
        expect(more().getByText(/^Synthetic answer:/u)).toBeTruthy()
        for (const verdict of ['Looks right', 'Not yet', 'Can’t tell']) {
            expect(more().queryByText(verdict)).toBeNull()
        }
        expect(more().getByText('Answer to your question from the manual pages. It is not a step check.')).toBeTruthy()
        let node = more().getByText('Answer').parent
        while (node !== null && node !== undefined && node.props.accessibilityLiveRegion === undefined) {
            node = node.parent
        }
        expect(node?.props.accessibilityLiveRegion).toBe('polite')
    })

    it('shows an answer on the hero as the existing response text, never as a check', async () => {
        await setup('guide-answer')
        const answer = workflowPreviewFixture('guide-answer').state.answer!
        expect(screen.getByText(plainWords(answer.answer))).toBeTruthy()
        expect(screen.queryByText(/^Looks right\./u)).toBeNull()
    })

    it('keeps model names and notes out of More until About this check is opened', async () => {
        const fixture = workflowPreviewFixture('guide-pass')
        const check = { ...fixture.state.check!, model: 'muse-spark-1.3' as const, modelNotes: ['Synthetic note.'] }
        await setup('guide-pass', { state: { check }, more: true })
        expect(more().queryByText('Model: muse-spark-1.3')).toBeNull()
        await fireEvent.press(screen.getByTestId('judge-entry'))
        expect(screen.getByText('Model: muse-spark-1.3')).toBeTruthy()
        expect(screen.getByText('Model note: Synthetic note.')).toBeTruthy()
    })
})

describe('question composer', () => {
    it('stays blocked without a target and chooses a step part through the controller', async () => {
        const spies = await setup('guide-photo', {
            state: { question: 'Which way?', target: null },
            more: true,
            ask: true,
        })
        expect(disabled('Send question')).toBe(true)
        expect(screen.getByText('Choose a point or part.')).toBeTruthy()
        const part = workflowPreviewFixture('guide-photo').entry.session.reviewedSteps[0]!.parts[0]!.partId
        await fireEvent.press(screen.getAllByRole('radio')[0]!)
        expect(spies.targetChanged).toHaveBeenCalledTimes(1)
        expect(spies.targetChanged.mock.calls[0]![0]).toEqual({ kind: 'part', partId: part })
    })

    it('has no Ask icon in the header and opens the question from its early row in More', async () => {
        await setup('guide-photo')
        expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull()
        await openMore()
        const bodyBefore = more()
            .getAllByRole('button')
            .map((button) => button.props.accessibilityLabel as string)
        // Ask comes before every other action in the sheet.
        expect(bodyBefore.indexOf('Ask about this step')).toBeLessThan(bodyBefore.indexOf('Previous step'))
        await fireEvent.press(more().getByRole('button', { name: 'Ask about this step' }))
        expect(screen.getAllByText('Ask about this step').length).toBeGreaterThan(0)
        expect(screen.getByLabelText('Question about your photo')).toBeTruthy()
        expect(screen.queryByText('All steps')).toBeNull()
    })

    it('asks for a photo first when there is none', async () => {
        const spies = await setup('guide-empty', { more: true, ask: true })
        expect(screen.getByText('Take a photo first, then ask about it.')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Take photo to ask' }))
        expect(spies.camera.mock.calls).toEqual([[{ kind: 'question' }]])
    })

    it.each([
        ['text and a part target', 'Which way?', { kind: 'part' as const, partId: 'side-panel' }, false],
        ['a target but blank text', '   ', { kind: 'part' as const, partId: 'side-panel' }, true],
    ])('gates Send with %s', async (_name, question, target, expectedDisabled) => {
        const spies = await setup('guide-photo', { state: { question, target }, more: true, ask: true })
        expect(disabled('Send question')).toBe(expectedDisabled)
        await fireEvent.press(screen.getByRole('button', { name: 'Send question' }))
        expect(spies.ask).toHaveBeenCalledTimes(expectedDisabled ? 0 : 1)
    })

    it('stays blocked when the controller cannot compose', async () => {
        await setup('guide-answer', { controller: { canCompose: false }, more: true, ask: true })
        expect(disabled('Send question')).toBe(true)
    })
})

describe('grounded region overlay', () => {
    // Synthetic region: no recorded or live model output backs it.
    const region = { x: 0.2, y: 0.3, width: 0.4, height: 0.25 }
    const trigger = jest.fn()

    beforeEach(() => {
        trigger.mockClear()
        for (const spy of Object.values(animationSpies)) spy.mockClear()
    })

    // FrozenPhoto draws its overlay only after its frame is measured. The frame has no test id, so the layout event
    // goes to the first child of the element that holds the caption, which is the measured frame.
    async function measurePhoto(): Promise<void> {
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 200 } },
        })
    }

    function view(fixtureId: WorkflowPreviewCase, patch: Partial<WorkflowState>): ReactElement {
        const fixture = workflowPreviewFixture(fixtureId)
        const state = { ...fixture.state, ...patch }
        return (
            <FeedbackProvider reduceMotion={false} haptics={{ trigger }}>
                <GuideScreen state={state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />
            </FeedbackProvider>
        )
    }

    function passWith(observedRegion: typeof region | null, patch: Partial<CheckResult> = {}): CheckResult {
        return { ...workflowPreviewFixture('guide-pass').state.check!, observedRegion, ...patch }
    }

    it('outlines the returned region on the frozen photo and pulses it once for a pass', async () => {
        await render(view('guide-pass', { check: passWith(region) }))
        await measurePhoto()
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
        expect(screen.getByTestId('grounded-outline-pulse')).toBeTruthy()
        expect(animationSpies.withSequence).toHaveBeenCalledTimes(1)
    })

    it('draws nothing and pulses nothing for a pass that returned no region', async () => {
        await render(view('guide-pass', { check: passWith(null) }))
        await measurePhoto()
        expect(screen.queryByTestId('grounded-outline-line')).toBeNull()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
        expect(animationSpies.withSequence).not.toHaveBeenCalled()
    })

    it('does not pulse a region returned with an answer, even beside a passing check', async () => {
        const answer = { ...workflowPreviewFixture('guide-answer').state.answer!, observedRegion: region }
        await render(view('guide-photo', { check: passWith(region), answer }))
        await measurePhoto()
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
        expect(animationSpies.withSequence).not.toHaveBeenCalled()
    })

    it('stays static under Reduce Motion', async () => {
        const fixture = workflowPreviewFixture('guide-pass')
        const state = { ...fixture.state, check: passWith(region) }
        await render(
            <FeedbackProvider reduceMotion haptics={{ trigger }}>
                <GuideScreen state={state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />
            </FeedbackProvider>,
        )
        await measurePhoto()
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
        expect(animationSpies.withSequence).not.toHaveBeenCalled()
    })

    it('neither re-pulses nor re-notifies on a metadata-only rerender of the same result', async () => {
        const { rerender } = await render(view('guide-pass', { check: passWith(region) }))
        await measurePhoto()
        await rerender(view('guide-pass', { check: passWith(region, { modelNotes: ['Metadata only.'] }) }))
        expect(animationSpies.withSequence).toHaveBeenCalledTimes(1)
        expect(trigger).toHaveBeenCalledTimes(1)
    })

    it('does not replay the same pass after a regionless answer is cleared', async () => {
        const check = passWith(region)
        const answer = { ...workflowPreviewFixture('guide-answer').state.answer!, observedRegion: null }
        const { rerender } = await render(view('guide-pass', { check }))
        await measurePhoto()
        await rerender(view('guide-pass', { check, answer }))
        expect(screen.queryByTestId('grounded-outline-line')).toBeNull()
        await rerender(view('guide-pass', { check, answer: null }))
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
        expect(animationSpies.withSequence).toHaveBeenCalledTimes(1)
        expect(trigger.mock.calls.filter(([kind]) => kind === 'success')).toHaveLength(1)
    })

    it('carries no region into a new capture and pulses the next pass for its own capture', async () => {
        const first = workflowPreviewFixture('guide-pass').state.capture!
        const second = { ...first, binding: { ...first.binding, captureId: 'synthetic-capture-2' } }
        const { rerender } = await render(view('guide-pass', { check: passWith(region), capture: first }))
        await measurePhoto()
        await rerender(view('guide-pass', { check: null, capture: second }))
        expect(screen.queryByTestId('grounded-outline-line')).toBeNull()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
        await rerender(view('guide-pass', { check: passWith(region), capture: second }))
        await measurePhoto()
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
        expect(animationSpies.withSequence).toHaveBeenCalledTimes(2)
    })

    it('leaves the refusal comparison and its tappable photo pane alone, with no pulse', async () => {
        const fixture = workflowPreviewFixture('guide-refuse')
        await render(
            <FeedbackProvider reduceMotion={false}>
                <GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />
            </FeedbackProvider>,
        )
        await openMore()
        expect(screen.getByTestId('photo-tap')).toBeTruthy()
        expect(screen.queryByTestId('grounded-outline-line')).toBeNull()
        expect(animationSpies.withSequence).not.toHaveBeenCalled()
    })
})

describe('step layout and demo controls', () => {
    // Synthetic layouts and results from the shared preview fixtures: no recorded or live model output.
    const CHECK_TEXT = 'The inward-facing groove is visible.'
    const visibleChecks: Layout = {
        source: 'fallback',
        components: [{ type: 'visible_checks', checkIds: ['groove-inward'] }],
    }
    const staleLayout: Layout = {
        source: 'model',
        components: [
            { type: 'visible_checks', checkIds: ['groove-inward'] },
            { type: 'part_grid', partIds: ['ghost-part'] },
        ],
    }
    const checkWith = (id: WorkflowPreviewCase, layout: Layout | undefined): CheckResult => ({
        ...workflowPreviewFixture(id).state.check!,
        layout,
    })

    it('replaces the step summary with a valid layout while the verdict and reason stay', async () => {
        await setup('guide-pass', { more: true, state: { check: checkWith('guide-pass', visibleChecks) } })
        expect(screen.getAllByText(CHECK_TEXT).length).toBeGreaterThan(0)
        expect(screen.queryByText('Parts')).toBeNull()
        expect(
            screen.getAllByText(/Synthetic result: the groove faces inward as shown in the manual\./u).length,
        ).toBeGreaterThan(0)
    })

    it('keeps the step summary when the layout is absent or any reference is stale', async () => {
        await setup('guide-pass', { more: true, state: { check: checkWith('guide-pass', staleLayout) } })
        expect(screen.getByText('Parts')).toBeTruthy()
        expect(screen.queryByText(CHECK_TEXT)).toBeNull()
        expect(
            screen.getAllByText(/Synthetic result: the groove faces inward as shown in the manual\./u).length,
        ).toBeGreaterThan(0)
    })

    it('reads the layout from the answer when an answer and a check are both present', async () => {
        const answer = { ...workflowPreviewFixture('guide-answer').state.answer!, layout: visibleChecks }
        const check = checkWith('guide-pass', {
            source: 'fallback',
            components: [{ type: 'part_grid', partIds: ['side-panel'] }],
        })
        await setup('guide-photo', { more: true, state: { answer, check } })
        expect(screen.getAllByText(CHECK_TEXT).length).toBeGreaterThan(0)
        expect(screen.queryByText('1 × Side panel')).toBeNull()
    })

    it('keeps the refusal comparison before the layout, and recovery appears only after a refusal', async () => {
        const fixture = workflowPreviewFixture('guide-refuse')
        const check = {
            ...fixture.state.check!,
            layout: { source: 'fallback', components: [{ type: 'recovery', actionIds: ['turn-panel'] }] } as Layout,
        }
        const { toJSON } = await render(
            <GuideScreen
                state={{ ...fixture.state, check }}
                entry={fixture.entry}
                controller={INERT_WORKFLOW_CONTROLLER}
            />,
        )
        await openMore()
        const tree = JSON.stringify(toJSON())
        expect(tree.indexOf('Manual diagram')).toBeLessThan(tree.indexOf('Turn the panel so the groove faces inward.'))
        expect(
            screen.getAllByText(/Synthetic refusal: turn the panel so the groove faces inward before continuing\./u)
                .length,
        ).toBeGreaterThan(0)
    })

    it('chooses a known-orientation step through the existing controller', async () => {
        const spies = await setup('guide-photo', { more: true, judge: true, entry: { stepIndex: 1 } })
        await fireEvent.press(screen.getByRole('button', { name: /^Step 3:/u }))
        expect(spies.step.mock.calls).toEqual([[2]])
        expect(screen.getByRole('button', { name: /^Current · Step 2:/u }).props.accessibilityState.disabled).toBe(true)
    })

    it.each([
        ['a request is pending', { state: { pending: 'Checking the frozen photo…' } }],
        ['storage is read-only', { state: { storageReadOnly: true } }],
        ['the manual is unreviewed', { reviewStatus: 'unreviewed' as const }],
    ])('does not choose a step when %s', async (_name, options) => {
        const spies = await setup('guide-photo', { more: true, judge: true, ...options, entry: { stepIndex: 1 } })
        await fireEvent.press(screen.getByRole('button', { name: /^Step 3:/u }))
        expect(spies.step).not.toHaveBeenCalled()
    })

    it('recaps only the saved completions under Earlier progress', async () => {
        await setup('guide-empty', { more: true, judge: true, entry: { completedStepIds: ['step-2'] } })
        expect(screen.getByText('Earlier progress')).toBeTruthy()
        expect(screen.getByText('Marked complete: 2. Seat the divider in the groove')).toBeTruthy()
        expect(screen.queryByText('Marked complete: 1. Stand the side panel upright')).toBeNull()
    })

    it('resets the user’s part count when the step changes', async () => {
        const fixture = workflowPreviewFixture('guide-empty')
        const view = (stepIndex: number): ReactElement => (
            <GuideScreen
                state={fixture.state}
                entry={{ ...fixture.entry, stepIndex }}
                controller={INERT_WORKFLOW_CONTROLLER}
            />
        )
        const { rerender } = await render(view(0))
        await openMore()
        await fireEvent.press(screen.getByTestId('judge-entry'))
        await fireEvent.press(screen.getByRole('button', { name: 'Mark one Side panel located' }))
        expect(screen.getByText('All counted parts located by you')).toBeTruthy()
        await rerender(view(1))
        expect(screen.queryByText('All counted parts located by you')).toBeNull()
    })
})

describe('next part and target guidance', () => {
    // Synthetic fixtures only (mocked geometry, mocked part names): no recorded or live model output backs any value.
    const trigger = jest.fn()
    beforeEach(() => {
        trigger.mockClear()
        for (const spy of Object.values(animationSpies)) spy.mockClear()
    })

    const view = (
        fixtureId: WorkflowPreviewCase,
        patch: Partial<WorkflowState> = {},
        reduceMotion = false,
    ): ReactElement => {
        const fixture = workflowPreviewFixture(fixtureId)
        return (
            <FeedbackProvider reduceMotion={reduceMotion} haptics={{ trigger }}>
                <GuideScreen
                    state={{ ...fixture.state, ...patch }}
                    entry={fixture.entry}
                    controller={INERT_WORKFLOW_CONTROLLER}
                />
            </FeedbackProvider>
        )
    }
    async function measureFrozenPhoto(width = 300): Promise<void> {
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width, height: 200 } },
        })
    }
    const NEXT_ID = 'part-next-line'
    const TARGET_ID = 'part-target-line'
    const ARROW_ID = 'part-arrow-line'
    const absent = (...ids: string[]): void => {
        for (const id of ids) expect(screen.queryByTestId(id, { includeHiddenElements: true })).toBeNull()
    }
    const NO_TEXT = [/^Next part: /u, /^Target for /u, /^Move .* to the marked area$/u]
    const noGuidanceText = (): void => {
        for (const pattern of NO_TEXT) expect(screen.queryByText(pattern)).toBeNull()
    }

    it('draws no highlight, arrow or caption for a result without either region', async () => {
        await render(view('guide-pass'))
        await measureFrozenPhoto()
        absent(NEXT_ID, TARGET_ID, ARROW_ID)
        noGuidanceText()
    })

    it('draws a matching pair on the frozen photo with the part named in text, and one arrow', async () => {
        await render(view('guide-pass-guided'))
        await measureFrozenPhoto()
        expect(screen.getByTestId(NEXT_ID).props.strokeDasharray).toEqual([6, 4])
        expect(screen.getByTestId(TARGET_ID).props.strokeDasharray).toBeUndefined()
        expect(screen.getAllByTestId(ARROW_ID)).toHaveLength(1)
        expect(screen.getByText('Next part: Divider shelf')).toBeTruthy()
        expect(screen.getByText('Target for Divider shelf')).toBeTruthy()
        expect(screen.getByText('Move Divider shelf to the marked area')).toBeTruthy()
    })

    it('draws one field only when only the next part was located: no target, no arrow, no destination text', async () => {
        await render(view('guide-pass-next-only'))
        await measureFrozenPhoto()
        expect(screen.getByTestId(NEXT_ID)).toBeTruthy()
        absent(TARGET_ID, ARROW_ID)
        expect(screen.getByText('Next part: Divider shelf')).toBeTruthy()
        expect(screen.queryByText(/^Target for /u)).toBeNull()
        expect(screen.queryByText(/to the marked area$/u)).toBeNull()
    })

    it('draws one field only when only the target was located', async () => {
        const next = workflowPreviewFixture('guide-pass-guided').state.check!
        const { nextPartRegion: _dropped, ...targetOnly } = next
        await render(view('guide-pass-guided', { check: targetOnly }))
        await measureFrozenPhoto()
        expect(screen.getByTestId(TARGET_ID)).toBeTruthy()
        absent(NEXT_ID, ARROW_ID)
        expect(screen.queryByText(/^Next part: /u)).toBeNull()
    })

    it('draws both boxes under their own part names and no arrow when the parts differ (second manual)', async () => {
        await render(view('guide-stool-mismatched'))
        await measureFrozenPhoto()
        expect(screen.getByTestId(NEXT_ID)).toBeTruthy()
        expect(screen.getByTestId(TARGET_ID)).toBeTruthy()
        absent(ARROW_ID)
        expect(screen.getByText('Next part: Folding leg')).toBeTruthy()
        expect(screen.getByText('Target for Seat plate')).toBeTruthy()
        expect(screen.queryByText(/to the marked area$/u)).toBeNull()
    })

    it('draws the pair and the arrow for a second, unrelated manual using its own part names', async () => {
        await render(view('guide-stool-guided'))
        await measureFrozenPhoto()
        expect(screen.getAllByTestId(ARROW_ID)).toHaveLength(1)
        expect(screen.getByText('Move Folding leg to the marked area')).toBeTruthy()
        expect(screen.queryByText(/Divider/u)).toBeNull()
    })

    it.each([
        ['an out-of-step part', { partId: 'ghost-part' }],
        ['an invalid box', { partId: 'divider', region: { x: 0.8, y: 0.8, width: 0.5, height: 0.5 } }],
    ])('draws nothing and names nothing for %s', async (_name, override) => {
        const check = workflowPreviewFixture('guide-pass-guided').state.check!
        const bad = { ...check.nextPartRegion!, ...override }
        await render(
            view('guide-pass-guided', {
                check: { ...check, nextPartRegion: bad, targetRegion: { ...check.targetRegion!, ...override } },
            }),
        )
        await measureFrozenPhoto()
        absent(NEXT_ID, TARGET_ID, ARROW_ID)
        noGuidanceText()
    })

    it('never turns an observed region into a destination: observed alone draws no part guidance', async () => {
        const check = { ...workflowPreviewFixture('guide-pass').state.check!, observedRegion: workflowObserved() }
        await render(view('guide-pass', { check }))
        await measureFrozenPhoto()
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
        absent(NEXT_ID, TARGET_ID, ARROW_ID)
        noGuidanceText()
    })

    it('places regions inside the contained photo rect for a portrait photo, never on the letterbox bands', async () => {
        const capture = workflowPreviewFixture('guide-pass-guided').state.capture!
        const check = {
            ...workflowPreviewFixture('guide-pass-guided').state.check!,
            nextPartRegion: { partId: 'divider', region: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        }
        await render(
            view('guide-pass-guided', {
                check,
                capture: { ...capture, observation: { ...capture.observation, width: 400, height: 600 } },
            }),
        )
        await measureFrozenPhoto(300)
        // The hero frame is 300 wide and 464 tall (55 percent of the window): the 400x600 photo is contained at
        // 300x450, centred 7 down, and the region follows the image, not the frame.
        expect(screen.getByTestId(NEXT_ID).props).toMatchObject({ x: 0, y: 7, width: 150, height: 225 })
    })

    it('draws the answer’s regions on the frozen photo, and the answer’s result wins over a retained check', async () => {
        const { state } = workflowPreviewFixture('guide-answer-guided')
        const check = workflowPreviewFixture('guide-pass-next-only').state.check!
        await render(view('guide-answer-guided', { check }))
        await measureFrozenPhoto()
        expect(state.answer?.nextPartRegion).toBeDefined()
        expect(screen.getAllByTestId(ARROW_ID)).toHaveLength(1)
        expect(screen.getByText('Target for Divider shelf')).toBeTruthy()
    })

    it('draws guidance inside the refusal comparison photo pane, beside the observed region, with the pane tappable', async () => {
        const onTarget = jest.fn()
        const fixture = workflowPreviewFixture('guide-refuse-guided')
        await render(
            <FeedbackProvider reduceMotion={false}>
                <GuideScreen
                    state={fixture.state}
                    entry={fixture.entry}
                    controller={{ ...INERT_WORKFLOW_CONTROLLER, targetChanged: onTarget }}
                />
            </FeedbackProvider>,
        )
        await openMore()
        await fireEvent(screen.getByTestId('photo-frame'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 220 } },
        })
        expect(screen.getByTestId('photo-region-observed', { includeHiddenElements: true })).toBeTruthy()
        expect(screen.getByText('Highlighted: Observed part')).toBeTruthy()
        const overlay = within(screen.getByTestId('photo-overlay', { includeHiddenElements: true }))
        expect(overlay.getByTestId(NEXT_ID, { includeHiddenElements: true })).toBeTruthy()
        expect(overlay.getByTestId(TARGET_ID, { includeHiddenElements: true })).toBeTruthy()
        expect(overlay.getAllByTestId(ARROW_ID, { includeHiddenElements: true })).toHaveLength(1)
        expect(screen.getByText('Move Divider shelf to the marked area')).toBeTruthy()
        // The manual diagram pane never receives the photo's part guidance.
        expect(screen.queryByTestId('diagram-overlay', { includeHiddenElements: true })).toBeNull()
        await fireEvent.press(screen.getByTestId('photo-tap'), { nativeEvent: { locationX: 150, locationY: 110 } })
        expect(onTarget).toHaveBeenCalledTimes(1)
        expect(animationSpies.withSequence).not.toHaveBeenCalled()
    })

    it('draws no overlay or note in the refusal comparison when the refusal located nothing', async () => {
        await render(view('guide-refuse'))
        await openMore()
        await fireEvent(screen.getByTestId('photo-frame'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 220 } },
        })
        expect(screen.queryByTestId('photo-overlay', { includeHiddenElements: true })).toBeNull()
        noGuidanceText()
    })

    it('keeps the pass pulse and its identity: one pulse for the observed region, none for guidance', async () => {
        const check = {
            ...workflowPreviewFixture('guide-pass-guided').state.check!,
            observedRegion: { x: 0.3, y: 0.2, width: 0.2, height: 0.6 },
        }
        const { rerender } = await render(view('guide-pass-guided', { check }))
        await measureFrozenPhoto()
        expect(animationSpies.withSequence).toHaveBeenCalledTimes(1)
        expect(screen.getByTestId('grounded-outline-pulse')).toBeTruthy()
        expect(screen.getAllByTestId(ARROW_ID)).toHaveLength(1)
        // Metadata, a changed pairing or removed guidance neither replays the pulse nor re-notifies.
        await rerender(view('guide-pass-guided', { check: { ...check, modelNotes: ['Metadata only.'] } }))
        const { nextPartRegion: _next, ...withoutNext } = check
        await rerender(view('guide-pass-guided', { check: withoutNext }))
        expect(animationSpies.withSequence).toHaveBeenCalledTimes(1)
        expect(trigger.mock.calls.filter(([kind]) => kind === 'success')).toHaveLength(1)
    })

    it('does not pulse a pass that has guidance but no observed region, and keeps the guidance static', async () => {
        await render(view('guide-pass-guided'))
        await measureFrozenPhoto()
        expect(animationSpies.withSequence).not.toHaveBeenCalled()
        // Only the existing result entrance may animate; the 900ms pulse and the guidance never do.
        expect(animationSpies.withTiming.mock.calls.some(([, config]) => config?.duration === 900)).toBe(false)
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
        expect(screen.getAllByTestId(ARROW_ID)).toHaveLength(1)
    })

    it('draws the same static guidance under Reduce Motion, with no animation at all', async () => {
        await render(view('guide-pass-guided', {}, true))
        await measureFrozenPhoto()
        expect(screen.getByTestId(NEXT_ID)).toBeTruthy()
        expect(screen.getAllByTestId(ARROW_ID)).toHaveLength(1)
        expect(animationSpies.withSequence).not.toHaveBeenCalled()
    })

    it('carries no guidance into a new capture', async () => {
        const first = workflowPreviewFixture('guide-pass-guided').state.capture!
        const second = { ...first, binding: { ...first.binding, captureId: 'synthetic-capture-2' } }
        const { rerender } = await render(view('guide-pass-guided', { capture: first }))
        await measureFrozenPhoto()
        expect(screen.getByTestId(NEXT_ID)).toBeTruthy()
        await rerender(view('guide-pass-guided', { check: null, capture: second }))
        absent(NEXT_ID, TARGET_ID, ARROW_ID)
        noGuidanceText()
    })
})

function workflowObserved(): { x: number; y: number; width: number; height: number } {
    return { x: 0.3, y: 0.2, width: 0.2, height: 0.6 }
}

describe('evidence pair for a source-backed result', () => {
    beforeEach(() => {
        autoMore = true
    })
    afterEach(() => {
        autoMore = false
    })

    const PHOTO_CAPTION = 'Your photo for this step.'
    const flat = (element: { props: { style?: StyleProp<object> } }): Record<string, unknown> =>
        StyleSheet.flatten(element.props.style) as Record<string, unknown>
    const measurePair = async (width: number): Promise<void> => {
        await fireEvent(screen.getByTestId('evidence-pair'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width, height: 300 } },
        })
    }

    it.each(['guide-pass', 'guide-cannot-verify', 'guide-answer'] as const)(
        '%s puts the first cited page beside the photo, keeping both captions and the page label',
        async (id) => {
            await setup(id)
            await measurePair(358)
            expect(flat(screen.getByTestId('evidence-pair')).flexDirection).toBe('row')
            await fireEvent(within(screen.getByTestId('evidence-pair')).getByTestId('diagram-0-frame'), 'layout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 175, height: 220 } },
            })
            const pair = within(screen.getByTestId('evidence-pair'))
            expect(pair.getByText(PHOTO_CAPTION)).toBeTruthy()
            expect(pair.getByText('Expected diagram · page 1')).toBeTruthy()
            expect(pair.getByTestId('diagram-0')).toBeTruthy()
            expect(pair.getByLabelText('Expected diagram page 1', { includeHiddenElements: true })).toBeTruthy()
        },
    )

    it('stacks the photo above the page for large system text or a narrow window', async () => {
        for (const patch of [{ fontScale: 1.5 }, { fontScale: 1 }]) {
            Object.assign(mockWindow, patch)
            const { unmount } = await render(
                <GuideScreen
                    state={workflowPreviewFixture('guide-pass').state}
                    entry={workflowPreviewFixture('guide-pass').entry}
                    controller={INERT_WORKFLOW_CONTROLLER}
                />,
            )
            await measurePair(patch.fontScale === 1 ? 300 : 358)
            expect(flat(screen.getByTestId('evidence-pair')).flexDirection).not.toBe('row')
            const tree = JSON.stringify(screen.toJSON())
            expect(tree.indexOf('Expected diagram · page 1')).toBeGreaterThan(tree.indexOf(PHOTO_CAPTION))
            await unmount()
        }
    })

    it('keeps point selection on the photo and every further cited page beneath the pair, once each', async () => {
        const fixture = workflowPreviewFixture('guide-pass')
        const pageId = fixture.entry.session.pages[0]!.pageId
        const check = {
            ...fixture.state.check!,
            sourceRefs: [
                { pageId, region: null },
                { pageId, region: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
            ],
        }
        const onTarget = jest.fn()
        await render(
            <GuideScreen
                state={{ ...fixture.state, check }}
                entry={fixture.entry}
                controller={{ ...INERT_WORKFLOW_CONTROLLER, targetChanged: onTarget }}
            />,
        )
        await measurePair(358)
        expect(within(screen.getByTestId('evidence-pair')).getByTestId('diagram-0')).toBeTruthy()
        expect(within(screen.getByTestId('evidence-pair')).queryByTestId('diagram-1')).toBeNull()
        // Every further cited page sits beneath the pair, once; the full step then repeats them full width.
        expect(screen.getAllByTestId('diagram-1')).toHaveLength(2)
        expect(within(screen.getByTestId('full-step')).getAllByTestId('diagram-0')).toHaveLength(1)
        expect(within(screen.getByTestId('full-step')).getAllByTestId('diagram-1')).toHaveLength(1)
        // FrozenPhoto draws its tap target only after its frame is measured; the frame precedes the caption.
        const frame = screen.getByText(PHOTO_CAPTION).parent?.children[0]
        if (frame === undefined || typeof frame === 'string') throw new Error('Frozen photo frame not found')
        await fireEvent(frame, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 200 } } })
        const photo = screen.getByRole('imagebutton', {
            name: 'Frozen photo of your assembly. Tap a spot to ask about it.',
        })
        await fireEvent.press(photo, { nativeEvent: { locationX: 150, locationY: 100 } })
        expect(onTarget).toHaveBeenCalledTimes(1)
    })

    it("lists both a new answer's and a retained check's cited pages, as before", async () => {
        const fixture = workflowPreviewFixture('guide-answer')
        fixture.state.check = workflowPreviewFixture('guide-cannot-verify').state.check
        await render(<GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        await measurePair(358)
        // The pair, the retained check's own page, and the full step's full-width page.
        expect(screen.getAllByTestId('diagram-0')).toHaveLength(3)
        expect(within(screen.getByTestId('evidence-pair')).getAllByTestId('diagram-0')).toHaveLength(1)
    })

    it('draws no pair for a refusal, which keeps its own comparison', async () => {
        await setup('guide-refuse')
        expect(screen.queryByTestId('evidence-pair')).toBeNull()
        expect(screen.getByTestId('diagram')).toBeTruthy()
    })

    it('shows the photo alone when the result cites no page', async () => {
        const fixture = workflowPreviewFixture('guide-pass')
        const check = { ...fixture.state.check!, sourceRefs: [] }
        await render(
            <GuideScreen
                state={{ ...fixture.state, check }}
                entry={fixture.entry}
                controller={INERT_WORKFLOW_CONTROLLER}
            />,
        )
        expect(screen.queryByTestId('evidence-pair')).toBeNull()
        expect(screen.getByText(PHOTO_CAPTION)).toBeTruthy()
    })

    it('shows the cited page alone when there is no photo yet', async () => {
        await setup('guide-pass', { state: { capture: null } })
        expect(screen.queryByTestId('evidence-pair')).toBeNull()
        // The hero is the step's own picture, and the cited page is the full-width one in the full step.
        expect(screen.getByTestId('guide-hero-picture', { includeHiddenElements: true })).toBeTruthy()
        expect(within(screen.getByTestId('full-step')).getByTestId('diagram-0')).toBeTruthy()
    })
})

describe('no separate diagram button beside half-width evidence', () => {
    beforeEach(() => {
        autoMore = true
    })
    afterEach(() => {
        autoMore = false
    })

    const ACTION = 'View diagram full width'
    const measure = async (testID: string, width: number): Promise<void> => {
        await fireEvent(screen.getByTestId(testID), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width, height: 300 } },
        })
    }

    it('has no separate View diagram full width button: the full-width cited page is in the full step, in More', async () => {
        const spies = await setup('guide-pass')
        await measure('evidence-pair', 358)
        expect(screen.queryByRole('button', { name: ACTION })).toBeNull()
        expect(within(screen.getByTestId('full-step')).getByText('Expected diagram · page 1')).toBeTruthy()
        // Nothing ran: no controller action and no question target.
        expect(spies.targetChanged).not.toHaveBeenCalled()
        expect(spies.camera).not.toHaveBeenCalled()
    })

    it('has no button either when the pair stacks, where the diagram is already full width', async () => {
        Object.assign(mockWindow, { fontScale: 1.5 })
        await setup('guide-pass')
        await measure('evidence-pair', 358)
        expect(screen.queryByRole('button', { name: ACTION })).toBeNull()
    })

    it('draws the guidance lines once, full width beneath the side-by-side pair, and under the photo when stacked', async () => {
        const MOVE = 'Move Divider shelf to the marked area'
        const PHOTO_CAPTION = 'Your photo for this step.'
        const photoColumn = (): ReturnType<typeof within> => within(screen.getByText(PHOTO_CAPTION).parent!)
        const { unmount } = await render(
            <GuideScreen
                state={workflowPreviewFixture('guide-pass-guided').state}
                entry={workflowPreviewFixture('guide-pass-guided').entry}
                controller={INERT_WORKFLOW_CONTROLLER}
            />,
        )
        await measure('evidence-pair', 358)
        expect(screen.getAllByText(MOVE)).toHaveLength(1)
        expect(photoColumn().queryByText(MOVE)).toBeNull()
        expect(within(screen.getByTestId('evidence-pair').parent!).getByText(MOVE)).toBeTruthy()
        await unmount()
        Object.assign(mockWindow, { fontScale: 1.5 })
        await render(
            <GuideScreen
                state={workflowPreviewFixture('guide-pass-guided').state}
                entry={workflowPreviewFixture('guide-pass-guided').entry}
                controller={INERT_WORKFLOW_CONTROLLER}
            />,
        )
        await measure('evidence-pair', 358)
        expect(screen.getAllByText(MOVE)).toHaveLength(1)
        expect(photoColumn().getByText(MOVE)).toBeTruthy()
    })

    it('keeps the half-width refusal comparison free of a diagram button, with its guidance lines once beneath', async () => {
        await setup('guide-refuse-guided')
        await measure('comparison-stack', 358)
        // Beside the diagram the photo pane is narrow, so its guidance lines sit once beneath both panes.
        expect(screen.getAllByText('Move Divider shelf to the marked area')).toHaveLength(1)
        expect(within(screen.getByTestId('photo')).queryByText('Move Divider shelf to the marked area')).toBeNull()
        expect(screen.queryByRole('button', { name: ACTION })).toBeNull()
        expect(within(screen.getByTestId('full-step')).getByText('Expected diagram · page 1')).toBeTruthy()
    })
})

describe('portrait photo and page (guide-portrait-guided, mocked 400 x 600)', () => {
    beforeEach(() => {
        autoMore = true
    })
    afterEach(() => {
        autoMore = false
    })

    const PHOTO_CAPTION = 'Your photo for this step.'
    const frame = (): Parameters<typeof fireEvent>[0] => {
        const node = screen.getByText(PHOTO_CAPTION).parent?.children[0]
        if (node === undefined || typeof node === 'string') throw new Error('Frozen photo frame not found')
        return node
    }
    const flatStyle = (element: { props: { style?: StyleProp<object> } }): Record<string, unknown> =>
        StyleSheet.flatten(element.props.style) as Record<string, unknown>
    // The returned regions of the fixture, as the same fractions the fixture sends.
    const NEXT = { x: 0.08, y: 0.56, width: 0.28, height: 0.34 }
    const overlay = (id: string): Record<string, number> =>
        screen.getByTestId(id, { includeHiddenElements: true }).props

    it('keeps a true 2:3 photo in the 171 point half-width pane with no letterbox, regions and taps on the image', async () => {
        const spies = await setup('guide-portrait-guided')
        await fireEvent(screen.getByTestId('evidence-pair'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 300 } },
        })
        await fireEvent(frame(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 171, height: 256.5 } } })
        // 171 wide at 400 x 600 is 256.5 tall: under the 360 cap, so the image fills the frame.
        expect(flatStyle(frame() as never).height).toBeCloseTo(256.5, 6)
        const next = overlay('part-next-line')
        expect(next.x).toBeCloseTo(NEXT.x * 171, 6)
        expect(next.y).toBeCloseTo(NEXT.y * 256.5, 6)
        expect(next.width).toBeCloseTo(NEXT.width * 171, 6)
        expect(next.height).toBeCloseTo(NEXT.height * 256.5, 6)
        // A tap at the centre of the next part reports that normalized point.
        const photo = screen.getByRole('imagebutton', { name: /Frozen photo of your assembly/ })
        await fireEvent.press(photo, {
            nativeEvent: { locationX: (NEXT.x + NEXT.width / 2) * 171, locationY: (NEXT.y + NEXT.height / 2) * 256.5 },
        })
        const [point] = spies.targetChanged.mock.calls[0] as [{ kind: string; x: number; y: number }]
        expect(point.kind).toBe('point')
        expect(point.x).toBeCloseTo(NEXT.x + NEXT.width / 2, 6)
        expect(point.y).toBeCloseTo(NEXT.y + NEXT.height / 2, 6)
        expect(screen.getAllByTestId('part-arrow-line', { includeHiddenElements: true })).toHaveLength(1)
    })

    it('letterboxes the portrait photo at stacked full width: regions follow the contained image, bands ignore taps', async () => {
        Object.assign(mockWindow, { fontScale: 2 })
        const spies = await setup('guide-portrait-guided')
        await fireEvent(frame(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 360 } } })
        // 358 wide would be 537 tall, so the 360 cap applies: 400 x 600 contained is 240 x 360, centred 59 in from each side.
        expect(flatStyle(frame() as never).height).toBe(360)
        const next = overlay('part-next-line')
        expect(next.x).toBeCloseTo(59 + NEXT.x * 240, 6)
        expect(next.y).toBeCloseTo(NEXT.y * 360, 6)
        expect(next.width).toBeCloseTo(NEXT.width * 240, 6)
        const photo = screen.getByRole('imagebutton', { name: /Frozen photo of your assembly/ })
        await fireEvent.press(photo, { nativeEvent: { locationX: 20, locationY: 100 } })
        expect(spies.targetChanged).not.toHaveBeenCalled()
        await fireEvent.press(photo, { nativeEvent: { locationX: 59 + 120, locationY: 180 } })
        const [point] = spies.targetChanged.mock.calls[0] as [{ x: number; y: number }]
        expect(point.x).toBeCloseTo(0.5, 6)
        expect(point.y).toBeCloseTo(0.5, 6)
    })

    it("fits the portrait page to its own proportions in the pair's 171 point pane and contains it in the frame", async () => {
        await setup('guide-portrait-guided')
        await fireEvent(screen.getByTestId('evidence-pair'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 300 } },
        })
        const pairDiagram = within(screen.getByTestId('evidence-pair'))
        await fireEvent(pairDiagram.getByTestId('diagram-0-frame'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 171, height: 220 } },
        })
        // 171 wide would be 256.5 tall, so the 220 cap applies and the 400 x 600 page is contained: 146.67 wide, 12.17 in.
        const media = flatStyle(pairDiagram.getByTestId('diagram-0-media'))
        expect(media.height).toBeCloseTo(220, 6)
        expect(media.width).toBeCloseTo((220 * 400) / 600, 6)
        expect(media.left).toBeCloseTo((171 - (220 * 400) / 600) / 2, 6)
    })
})

describe('arrow at the half-width pane a 390 point phone really gives each image (about 171 points)', () => {
    beforeEach(() => {
        autoMore = true
    })
    afterEach(() => {
        autoMore = false
    })

    it('draws the arrow, with its halo, in the refusal comparison photo pane', async () => {
        const fixture = workflowPreviewFixture('guide-refuse-guided')
        await render(<GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        await fireEvent(screen.getByTestId('photo-frame'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 171, height: 220 } },
        })
        const overlay = within(screen.getByTestId('photo-overlay', { includeHiddenElements: true }))
        expect(overlay.getAllByTestId('part-arrow-line', { includeHiddenElements: true })).toHaveLength(1)
        expect(overlay.getAllByTestId('part-arrow-halo', { includeHiddenElements: true })).toHaveLength(1)
        expect(overlay.getAllByTestId('part-arrow-head', { includeHiddenElements: true })).toHaveLength(1)
        expect(screen.getByText('Move Divider shelf to the marked area')).toBeTruthy()
    })

    it('draws the arrow on the frozen photo beside the cited page', async () => {
        const fixture = workflowPreviewFixture('guide-pass-guided')
        await render(<GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        const frame = screen.getByText('Your photo for this step.').parent?.children[0]
        if (frame === undefined || typeof frame === 'string') throw new Error('Frozen photo frame not found')
        await fireEvent(frame, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 171, height: 114 } } })
        expect(screen.getAllByTestId('part-arrow-line', { includeHiddenElements: true })).toHaveLength(1)
        expect(screen.getAllByTestId('part-arrow-halo', { includeHiddenElements: true })).toHaveLength(1)
    })
})

describe('full-width result citations', () => {
    beforeEach(() => {
        autoMore = true
    })
    afterEach(() => {
        autoMore = false
    })

    it.each(['guide-pass', 'guide-answer', 'guide-refuse'] as const)(
        '%s opens the actual cited page before the step page and keeps both once',
        async (id) => {
            const fixture = workflowPreviewFixture(id)
            const first = fixture.entry.session.pages[0]!
            fixture.entry.session.pages.push({ ...first, pageId: 'other-cited-page', assetId: 'other-cited-asset' })
            fixture.state.pageUris = {
                ...fixture.state.pageUris,
                'other-cited-page': fixture.state.pageUris[first.pageId]!,
            }
            const refs = [{ pageId: 'other-cited-page', region: null }]
            if (fixture.state.answer !== null) fixture.state.answer.sourceRefs = refs
            else fixture.state.check!.sourceRefs = refs
            await render(
                <GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />,
            )
            const pair = id === 'guide-refuse' ? 'comparison-stack' : 'evidence-pair'
            await fireEvent(screen.getByTestId(pair), 'layout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 300 } },
            })
            expect(screen.queryByRole('button', { name: 'View diagram full width' })).toBeNull()
            const sheet = within(screen.getByTestId('full-step'))
            const labels = sheet.getAllByText(/^Expected diagram · page /u).map((node) => node.props.children)
            expect(labels).toEqual(['Expected diagram · page 2', 'Expected diagram · page 1'])
        },
    )

    it('enlarges a portrait page to the sheet width instead of retaining the compact 220 point frame', async () => {
        await setup('guide-portrait-guided')
        await fireEvent(screen.getByTestId('evidence-pair'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 300 } },
        })
        const sheet = within(screen.getByTestId('full-step'))
        await fireEvent(sheet.getByTestId('diagram-0-frame'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 354, height: 220 } },
        })
        const media = StyleSheet.flatten(sheet.getByTestId('diagram-0-media').props.style)
        expect(media).toMatchObject({ left: 0, top: 0, width: 354, height: 531 })
    })
})

describe('hero and result mark', () => {
    it('runs the hero edge to edge with square corners and no side inset', async () => {
        await setup('guide-empty')
        const frame = screen.getByTestId('guide-hero-frame')
        expect(StyleSheet.flatten(frame.props.style) ?? {}).not.toHaveProperty('paddingHorizontal')
        expect(StyleSheet.flatten(screen.getByTestId('guide-hero-picture').props.style)).toMatchObject({
            borderRadius: 0,
        })
    })

    it('runs a photo hero edge to edge too', async () => {
        await setup('guide-pass')
        expect(StyleSheet.flatten(screen.getByTestId('frozen-photo-frame').props.style)).toMatchObject({
            borderRadius: 0,
        })
    })

    it.each([
        ['guide-pass', 'Looks right.'],
        ['guide-refuse', 'Not yet.'],
        ['guide-cannot-verify', "We can't tell from this photo."],
    ] as const)('puts one decorative tinted mark beside the sentence for %s', async (id, lead) => {
        await setup(id)
        const mark = screen.getByTestId('result-icon', behind)
        expect(mark.props.accessibilityElementsHidden).toBe(true)
        expect(StyleSheet.flatten(mark.props.style)).toMatchObject({ width: 48, height: 48 })
        expect(screen.getByText(lead, { exact: false })).toBeTruthy()
        // A mark is not a control: the primary is still the only button on the surface.
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(1)
        expect(within(mark).queryByRole('button')).toBeNull()
    })

    it('draws no verdict mark on the first screen or on an answer, even while a check is retained', async () => {
        await setup('guide-empty')
        expect(screen.queryByTestId('result-icon', behind)).toBeNull()
        const answer = workflowPreviewFixture('guide-answer').state.answer!
        await setup('guide-pass', { state: { answer } })
        expect(screen.queryByTestId('result-icon', behind)).toBeNull()
    })
})

describe('result haptic identity', () => {
    const trigger = jest.fn()
    beforeEach(() => trigger.mockClear())
    const withCapture = (captureId: string): Partial<WorkflowState> => {
        const base = workflowPreviewFixture('guide-pass').state
        return { capture: { ...base.capture!, binding: { ...base.capture!.binding, captureId } } }
    }
    const view = (patch: Partial<WorkflowState>): ReactElement => {
        const fixture = workflowPreviewFixture('guide-pass')
        return (
            <FeedbackProvider reduceMotion haptics={{ trigger }}>
                <GuideScreen
                    state={{ ...fixture.state, ...patch }}
                    entry={fixture.entry}
                    controller={INERT_WORKFLOW_CONTROLLER}
                />
            </FeedbackProvider>
        )
    }

    it('notifies again for a new photo whose result is worded exactly the same', async () => {
        const { rerender } = await render(view(withCapture('capture-one')))
        expect(trigger).toHaveBeenCalledTimes(1)
        expect(trigger).toHaveBeenLastCalledWith('success')
        await rerender(view(withCapture('capture-two')))
        expect(trigger).toHaveBeenCalledTimes(2)
    })

    it('never replays when More opens and closes, or when the same photo is shown again', async () => {
        const { rerender } = await render(view(withCapture('capture-one')))
        await openMore()
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
        await rerender(view(withCapture('capture-one')))
        // Pressing More and Close each give their own light selection tick; the result's notification fires once.
        expect(trigger.mock.calls.filter(([kind]) => kind !== 'selection')).toEqual([['success']])
    })

    it('does not replay a retained result after Guide is popped and mounted again under the root feedback provider', async () => {
        const fixture = workflowPreviewFixture('guide-pass')
        const page = (visible: boolean): ReactElement => (
            <FeedbackProvider reduceMotion haptics={{ trigger }}>
                {visible ? (
                    <GuideScreen state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />
                ) : null}
            </FeedbackProvider>
        )
        const { rerender } = await render(page(true))
        expect(trigger).toHaveBeenCalledTimes(1)
        await rerender(page(false))
        await rerender(page(true))
        expect(trigger).toHaveBeenCalledTimes(1)
    })
})

describe('step swipe and the system edge', () => {
    afterEach(() => jest.restoreAllMocks())
    it('reserves the leading strip, and only that strip, for the system', () => {
        expect(startsAtSystemEdge(0, 390, false)).toBe(true)
        expect(startsAtSystemEdge(EDGE_RESERVE - 1, 390, false)).toBe(true)
        expect(startsAtSystemEdge(EDGE_RESERVE, 390, false)).toBe(false)
        expect(startsAtSystemEdge(390, 390, false)).toBe(false)
        expect(startsAtSystemEdge(390 - 1, 390, true)).toBe(true)
        expect(startsAtSystemEdge(5, 390, true)).toBe(false)
    })

    it('does not claim a drag that starts at the iOS leading edge, and still claims one from the middle', async () => {
        const create = jest.spyOn(PanResponder, 'create')
        await setup('guide-photo')
        const config = create.mock.calls[0]![0]
        const move = (dx: number, moveX: number): boolean =>
            config.onMoveShouldSetPanResponder?.({} as never, { dx, dy: 0, moveX } as never) ?? false
        // Started at x = 10 and moved right: iOS edge Back owns it.
        expect(move(70, 80)).toBe(false)
        // Started mid-screen: browsing steps.
        expect(move(-70, 130)).toBe(true)
    })

    it('leaves the edge alone only on iOS', async () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'android')
        try {
            const create = jest.spyOn(PanResponder, 'create')
            await setup('guide-photo')
            const config = create.mock.calls[0]![0]
            expect(config.onMoveShouldSetPanResponder?.({} as never, { dx: 70, dy: 0, moveX: 80 } as never)).toBe(true)
        } finally {
            platform.restore()
        }
    })

    it('browses with a centre swipe without completing the step', async () => {
        const create = jest.spyOn(PanResponder, 'create')
        const spies = await setup('guide-photo', { entry: { stepIndex: 1 } })
        const config = create.mock.calls[0]![0]
        await act(async () => config.onPanResponderRelease?.({} as never, { dx: -90, dy: 0 } as never))
        expect(spies.step).toHaveBeenCalledWith(2)
        expect(spies.completeStep).not.toHaveBeenCalled()
    })
})

describe('the primary at accessibility text sizes', () => {
    it.each([
        ['guide-empty', 'Take photo', 'Photo'],
        ['guide-refuse', 'Take another photo', 'Retake'],
        ['guide-pass', 'Next step', 'Next'],
    ] as const)('shows one short verb for %s and keeps %s as the accessible name', async (id, full, short) => {
        mockWindow.fontScale = 3.4
        await setup(id)
        const primary = screen.getByTestId('guide-primary')
        expect(within(primary).getByText(short)).toBeTruthy()
        expect(primary).toHaveProp('accessibilityLabel', full)
        expect(screen.getByRole('button', { name: full })).toBe(primary)
        // The hero is still 55 percent of the window and the text region is the only thing that scrolls.
        expect((StyleSheet.flatten(screen.getByTestId('guide-hero').props.style) as { height: number }).height).toBe(
            464,
        )
    })
})
