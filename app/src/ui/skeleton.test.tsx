import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { act, render } from '@testing-library/react-native'
import { AccessibilityInfo, type EventSubscription } from 'react-native'
import { spies } from './test-support/reanimated-mock'
import { FeedbackProvider } from './feedback'
import { LoadingState } from './states'
import { Skeleton } from './skeleton'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

beforeEach(() => {
    spies.withRepeat.mockClear()
    spies.cancelAnimation.mockClear()
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(
        () => ({ remove: (): void => undefined }) as unknown as EventSubscription,
    )
})

describe('Skeleton', () => {
    it('pulses with a repeating animation while motion is allowed', async () => {
        await render(
            <FeedbackProvider reduceMotion={false}>
                <Skeleton />
            </FeedbackProvider>,
        )
        expect(spies.withRepeat).toHaveBeenCalledWith(expect.anything(), -1, false)
    })

    it('starts no loop under reduced motion', async () => {
        await render(
            <FeedbackProvider reduceMotion={true}>
                <Skeleton />
            </FeedbackProvider>,
        )
        expect(spies.withRepeat).not.toHaveBeenCalled()
    })

    it('cancels its loop when it unmounts', async () => {
        const screen = await render(
            <FeedbackProvider reduceMotion={false}>
                <Skeleton />
            </FeedbackProvider>,
        )
        await act(() => screen.unmount())
        expect(spies.cancelAnimation).toHaveBeenCalled()
    })
})

describe('LoadingState', () => {
    it('announces its label once and hides the placeholder lines', async () => {
        const { getByLabelText, getAllByLabelText } = await render(<LoadingState label="Reading the manual" />)
        expect(getByLabelText('Reading the manual')).toHaveProp('accessibilityLiveRegion', 'polite')
        expect(getAllByLabelText('Reading the manual')).toHaveLength(1)
    })
})
