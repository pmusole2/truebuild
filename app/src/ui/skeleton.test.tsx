import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, type EventSubscription } from 'react-native'
import { spies } from './test-support/reanimated-mock'
import { FeedbackProvider } from './feedback'
import { LoadingState } from './states'
import { Skeleton } from './skeleton'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

beforeEach(() => {
    spies.withRepeat.mockClear()
    spies.withTiming.mockClear()
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(
        () => ({ remove: (): void => undefined }) as unknown as EventSubscription,
    )
})

describe('Skeleton', () => {
    it.each([false, true])('is a static placeholder that starts no loop (reduced motion %s)', async (reduced) => {
        await render(
            <FeedbackProvider reduceMotion={reduced}>
                <Skeleton />
            </FeedbackProvider>,
        )
        expect(screen.getByTestId('skeleton-block', { hidden: true })).toBeTruthy()
        expect(spies.withRepeat).not.toHaveBeenCalled()
        expect(spies.withTiming).not.toHaveBeenCalled()
    })
})

describe('LoadingState', () => {
    it('announces its label once and hides the placeholder lines', async () => {
        const { getByLabelText, getAllByLabelText } = await render(<LoadingState label="Reading the manual" />)
        expect(getByLabelText('Reading the manual')).toHaveProp('accessibilityLiveRegion', 'polite')
        expect(getAllByLabelText('Reading the manual')).toHaveLength(1)
    })
})
