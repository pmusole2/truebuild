import type { ReactElement } from 'react'
import type { ManualSession, ManualStep } from '@truebuild/contracts'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { DemoControls } from './demo-controls'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

// Synthetic unit data only (the shared preview fixture); nothing here is a recorded or live result.
function session(): ManualSession {
    return workflowPreviewFixture('guide-empty').entry.session
}

type Props = { manual: ManualSession; stepIndex?: number; completed?: string[]; locked?: boolean; onSelect?: jest.Mock }

function controls({
    manual,
    stepIndex = 0,
    completed = [],
    locked = false,
    onSelect = jest.fn(),
}: Props): ReactElement {
    return (
        <DemoControls
            session={manual}
            stepIndex={stepIndex}
            completedStepIds={completed}
            locked={locked}
            onSelectStep={onSelect}
        />
    )
}

const press = (name: string): Promise<unknown> => fireEvent.press(screen.getByRole('button', { name }))
const NOT_YET = (count: number): string => `Not yet located: ${count}, please confirm`
const ALL_CONFIRMED = 'All counted parts located by you'

function withQuantity(manual: ManualSession, stepIndex: number, partIndex: number, quantity: number): void {
    manual.reviewedSteps[stepIndex]!.parts[partIndex]!.quantity = {
        state: 'known',
        value: quantity,
        sourceRefs: [{ pageId: 'demo-page-1', region: null }],
    }
}

describe('inventory confirmation', () => {
    it('is labelled as the user’s own confirmation and states what is not yet located', async () => {
        await render(controls({ manual: session() }))
        expect(screen.getByText('USER CONFIRMATION')).toBeTruthy()
        expect(screen.getByText('Side panel')).toBeTruthy()
        expect(screen.getByText(NOT_YET(1))).toBeTruthy()
        expect(screen.queryByText(ALL_CONFIRMED)).toBeNull()
    })

    it('counts the user’s own taps up to the manual quantity and can undo', async () => {
        const manual = session()
        withQuantity(manual, 0, 0, 3)
        await render(controls({ manual }))
        await press('Mark one Side panel located')
        await press('Mark one Side panel located')
        expect(screen.getByText(NOT_YET(1))).toBeTruthy()
        expect(screen.getByText('Located by you: 2 of 3')).toBeTruthy()
        await press('Undo one Side panel located')
        expect(screen.getByText(NOT_YET(2))).toBeTruthy()
        await press('Mark one Side panel located')
        await press('Mark one Side panel located')
        expect(screen.getByText('Located by you: 3 of 3')).toBeTruthy()
        expect(screen.getByText(ALL_CONFIRMED)).toBeTruthy()
        expect(
            screen.getByRole('button', { name: 'Mark one Side panel located' }).props.accessibilityState.disabled,
        ).toBe(true)
        expect(screen.queryByText(/^Not yet located/u)).toBeNull()
    })

    it('never takes the count below zero', async () => {
        await render(controls({ manual: session() }))
        expect(
            screen.getByRole('button', { name: 'Undo one Side panel located' }).props.accessibilityState.disabled,
        ).toBe(true)
    })

    it('keeps an unknown quantity unknown, offers no count and never reports all located', async () => {
        const manual = session()
        manual.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason: 'The count is not printed.' }
        await render(controls({ manual }))
        expect(screen.getByText('Unknown: The count is not printed.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: /Mark one/u })).toBeNull()
        expect(screen.queryByText(/^Not yet located/u)).toBeNull()
        expect(screen.queryByText(ALL_CONFIRMED)).toBeNull()
    })

    it('does not report all located when one counted part is done but another quantity is unknown', async () => {
        const manual = session()
        manual.reviewedSteps[1]!.parts[1]!.quantity = { state: 'unknown', reason: 'The count is not printed.' }
        await render(controls({ manual, stepIndex: 1 }))
        await press('Mark one Side panel located')
        expect(screen.getByText('Located by you: 1 of 1')).toBeTruthy()
        expect(screen.queryByText(ALL_CONFIRMED)).toBeNull()
    })

    it('has nothing to confirm for a step that lists no parts', async () => {
        const manual = session()
        manual.reviewedSteps[0]!.parts = []
        await render(controls({ manual }))
        expect(screen.getByText('No parts listed for this step. Nothing to confirm.')).toBeTruthy()
        expect(screen.queryByText(ALL_CONFIRMED)).toBeNull()
    })

    it('does not infer a shortage or compare against a model result', async () => {
        await render(controls({ manual: session() }))
        expect(screen.queryByText(/short|missing|lack|score|detected|found/iu)).toBeNull()
    })

    it('counts a reused part separately in each step and resets when the step changes', async () => {
        const manual = session()
        const { rerender } = await render(controls({ manual, stepIndex: 0 }))
        await press('Mark one Side panel located')
        expect(screen.getByText(ALL_CONFIRMED)).toBeTruthy()
        // Step 2 reuses the side panel; the earlier tap neither carries over nor adds to a total.
        await rerender(controls({ manual, stepIndex: 1 }))
        expect(screen.getAllByText(NOT_YET(1))).toHaveLength(2)
        expect(screen.queryByText(ALL_CONFIRMED)).toBeNull()
        await rerender(controls({ manual, stepIndex: 0 }))
        expect(screen.getByText(NOT_YET(1))).toBeTruthy()
    })

    it('keeps the count across an unrelated render of the same step and resets for a new revision or manual', async () => {
        const manual = session()
        const { rerender } = await render(controls({ manual }))
        await press('Mark one Side panel located')
        await rerender(controls({ manual, completed: ['step-1'], locked: true }))
        expect(screen.getByText(ALL_CONFIRMED)).toBeTruthy()
        await rerender(controls({ manual: { ...manual, revision: manual.revision + 1 } }))
        expect(screen.getByText(NOT_YET(1))).toBeTruthy()
        await press('Mark one Side panel located')
        await rerender(controls({ manual: { ...manual, revision: manual.revision + 1, manualId: 'other-manual' } }))
        expect(screen.getByText(NOT_YET(1))).toBeTruthy()
    })
})

describe("judge's choice", () => {
    function threeSteps(): ManualSession {
        const manual = session()
        const last = manual.reviewedSteps[1]!
        const third: ManualStep = { ...last, stepId: 'synthetic-step-3', order: 3, title: 'Synthetic third step' }
        manual.reviewedSteps = [...manual.reviewedSteps, third]
        return manual
    }

    it('lists only steps with a known orientation and selects by the real step index', async () => {
        const manual = threeSteps()
        manual.reviewedSteps[1]!.orientation = { state: 'unknown', reason: 'Not visible in this synthetic page.' }
        const onSelect = jest.fn()
        await render(controls({ manual, onSelect }))
        expect(screen.getByText("Judge's choice")).toBeTruthy()
        expect(screen.queryByRole('button', { name: /Step 2:/u })).toBeNull()
        await press('Step 3: Synthetic third step')
        expect(onSelect.mock.calls).toEqual([[2]])
    })

    it('shows the current step as already selected', async () => {
        const onSelect = jest.fn()
        await render(controls({ manual: threeSteps(), stepIndex: 1, onSelect }))
        const current = screen.getByRole('button', { name: /^Current · Step 2:/u })
        expect(current.props.accessibilityState.disabled).toBe(true)
        await fireEvent.press(current)
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('does nothing while locked', async () => {
        const onSelect = jest.fn()
        await render(controls({ manual: threeSteps(), locked: true, onSelect }))
        const target = screen.getByRole('button', { name: 'Step 3: Synthetic third step' })
        expect(target.props.accessibilityState.disabled).toBe(true)
        await fireEvent.press(target)
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('says nothing about an outcome and leaves the photo check as the only verdict', async () => {
        await render(controls({ manual: threeSteps() }))
        expect(screen.queryByText(/score|correct|reversed|wrong|pass|refuse/iu)).toBeNull()
        expect(screen.getByText(/only verdict/u)).toBeTruthy()
    })

    it('says so when no step has a known orientation', async () => {
        const manual = session()
        for (const step of manual.reviewedSteps) {
            step.orientation = { state: 'unknown', reason: 'Not visible in this synthetic page.' }
        }
        await render(controls({ manual }))
        expect(screen.getByText('No steps with a known orientation yet.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: /^Step \d/u })).toBeNull()
    })
})

describe('earlier progress', () => {
    it('lists only persisted completed steps that resolve in this session, in manual order', async () => {
        await render(controls({ manual: session(), completed: ['step-2', 'removed-step', 'step-1'] }))
        expect(screen.getByText('Earlier progress')).toBeTruthy()
        const texts = screen.getAllByText(/^Marked complete: /u).map((node) => node.props.children)
        expect(texts).toEqual([
            'Marked complete: 1. Stand the side panel upright',
            'Marked complete: 2. Seat the divider in the groove',
        ])
        expect(screen.queryByText(/removed-step/u)).toBeNull()
    })

    it('makes no live or accuracy claim', async () => {
        await render(controls({ manual: session(), completed: ['step-1'] }))
        expect(screen.getByText(/saved on this device.*not a live check/iu)).toBeTruthy()
        expect(screen.queryByText(/accura|verified|confirmed/iu)).toBeNull()
    })

    it('says so when nothing is marked complete', async () => {
        await render(controls({ manual: session() }))
        expect(screen.getByText('No steps marked complete yet.')).toBeTruthy()
        expect(screen.queryByText(/^Marked complete: /u)).toBeNull()
    })
})
