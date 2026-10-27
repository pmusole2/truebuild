import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import { Animated, AccessibilityInfo, type EventSubscription } from 'react-native'
import { FeedbackProvider } from './feedback'
import { LoadingState } from './states'
import { Skeleton } from './skeleton'

const loopSpy = jest.spyOn(Animated, 'loop')

beforeEach(() => {
    loopSpy.mockClear()
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(
        () => ({ remove: (): void => undefined }) as unknown as EventSubscription,
    )
})

describe('Skeleton', () => {
    it('pulses while motion is allowed', async () => {
        await render(
            <FeedbackProvider reduceMotion={false}>
                <Skeleton />
            </FeedbackProvider>,
        )
        expect(loopSpy).toHaveBeenCalled()
    })

    it('does not start a loop under reduced motion', async () => {
        await render(
            <FeedbackProvider reduceMotion={true}>
                <Skeleton />
            </FeedbackProvider>,
        )
        expect(loopSpy).not.toHaveBeenCalled()
    })
})

describe('LoadingState', () => {
    it('announces its label once and hides the placeholder lines', async () => {
        await render(<LoadingState label="Reading the manual" />)
        expect(screen.getByLabelText('Reading the manual')).toHaveProp('accessibilityLiveRegion', 'polite')
        expect(screen.getAllByLabelText('Reading the manual')).toHaveLength(1)
    })
})
