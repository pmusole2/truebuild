import { describe, expect, it } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import { ProgressBar, StepList, type StepListItem } from './progress'

describe('ProgressBar', () => {
    it('reports its value and total as an accessible progress bar', async () => {
        await render(<ProgressBar label="Steps confirmed" value={2} total={5} />)
        const bar = screen.getByRole('progressbar', { name: 'Steps confirmed' })
        expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 5, now: 2, text: '2 of 5' })
    })

    it('clamps out-of-range and non-finite input instead of drawing outside the track', async () => {
        await render(<ProgressBar label="Photos" value={9} total={3} />)
        expect(screen.getByRole('progressbar', { name: 'Photos' }).props.accessibilityValue).toMatchObject({
            now: 3,
            max: 3,
        })
        await render(<ProgressBar label="Pages" value={Number.NaN} total={4} />)
        expect(screen.getByRole('progressbar', { name: 'Pages' }).props.accessibilityValue).toMatchObject({ now: 0 })
    })
})

const STEPS: readonly StepListItem[] = [
    { id: 'a', title: 'Stand the side panel upright', state: 'done' },
    { id: 'b', title: 'Seat the divider in the groove', state: 'current' },
    { id: 'c', title: 'Fit the shelf pins', state: 'upcoming' },
    { id: 'd', title: 'Attach the back', state: 'blocked' },
]

describe('StepList', () => {
    it('names every step with its position and state, so state is never a marker alone', async () => {
        await render(<StepList steps={STEPS} />)
        expect(screen.getByLabelText('Step 1, Done: Stand the side panel upright')).toBeTruthy()
        expect(screen.getByLabelText('Step 2, Current: Seat the divider in the groove')).toBeTruthy()
        expect(screen.getByLabelText('Step 3, Not started: Fit the shelf pins')).toBeTruthy()
        expect(screen.getByLabelText('Step 4, Blocked: Attach the back')).toBeTruthy()
    })

    it('marks only the current step as selected', async () => {
        await render(<StepList steps={STEPS} />)
        expect(
            screen.getByLabelText('Step 2, Current: Seat the divider in the groove').props.accessibilityState,
        ).toEqual({ selected: true })
        expect(screen.getByLabelText('Step 1, Done: Stand the side panel upright').props.accessibilityState).toEqual({
            selected: false,
        })
    })
})
