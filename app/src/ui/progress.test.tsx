import { describe, expect, it } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { StyleSheet } from 'react-native'
import { FeedbackProvider } from './feedback'
import { ProgressBar, StepList, type StepListItem } from './progress'
import { spies } from './test-support/reanimated-mock'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

let mockFontScale = 1
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): { width: number; height: number; scale: number; fontScale: number } => ({
        width: 390,
        height: 844,
        scale: 3,
        fontScale: mockFontScale,
    }),
}))

describe('ProgressBar fill', () => {
    const bar = (value: number, reduced = false): ReactElement => (
        <FeedbackProvider reduceMotion={reduced}>
            <ProgressBar label="Steps" value={value} total={4} />
        </FeedbackProvider>
    )
    beforeEach(() => {
        spies.withTiming.mockClear()
        spies.cancelAnimation.mockClear()
    })

    it('starts at its true value and never grows from zero on mount', async () => {
        await render(bar(2))
        expect(spies.withTiming).not.toHaveBeenCalled()
        expect(StyleSheet.flatten(screen.getByTestId('progress-fill').props.style).width).toBe('50%')
    })

    it('eases the fill to a new value at the standard duration, and reports the target to assistive tech at once', async () => {
        const { rerender } = await render(bar(1))
        await rerender(bar(3))
        expect(spies.withTiming).toHaveBeenCalledWith(0.75, expect.objectContaining({ duration: 250 }))
        expect(screen.getByRole('progressbar', { name: 'Steps' }).props.accessibilityValue).toMatchObject({ now: 3 })
    })

    it('sets the fill instantly under reduced motion', async () => {
        const { rerender } = await render(bar(1, true))
        await rerender(bar(3, true))
        expect(spies.withTiming).not.toHaveBeenCalled()
    })

    it('is a thin decorative cue when slim, hidden from assistive tech', async () => {
        await render(
            <FeedbackProvider reduceMotion>
                <ProgressBar slim label="Steps" value={1} total={4} />
            </FeedbackProvider>,
        )
        expect(screen.queryByRole('progressbar')).toBeNull()
        expect(StyleSheet.flatten(screen.getByTestId('progress-track', { hidden: true }).props.style).height).toBe(4)
    })
})

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
    it.each([1, 3.12])('keeps its marker large enough for uncapped text at font scale %s', async (fontScale) => {
        mockFontScale = fontScale
        try {
            await render(<StepList steps={STEPS} />)
            expect(screen.getByTestId('step-marker-b')).toHaveStyle({
                width: 28 * fontScale,
                height: 28 * fontScale,
            })
        } finally {
            mockFontScale = 1
        }
    })

    it('names every step with its position and state, so state is never a marker alone', async () => {
        await render(<StepList steps={STEPS} />)
        expect(screen.getByLabelText('Step 1, Done: Stand the side panel upright')).toBeTruthy()
        expect(screen.getByLabelText('Step 2, Current: Seat the divider in the groove')).toBeTruthy()
        expect(screen.getByLabelText('Step 3, Not started: Fit the shelf pins')).toBeTruthy()
        expect(screen.getByLabelText('Step 4, Blocked: Attach the back')).toBeTruthy()
        expect(screen.getByText('2')).toHaveProp('maxFontSizeMultiplier', 0)
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
