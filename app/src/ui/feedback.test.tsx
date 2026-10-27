import { beforeEach, describe, expect, it } from '@jest/globals'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Text, type EventSubscription } from 'react-native'
import type { ReactElement } from 'react'
import { AppButton } from './button'
import { FeedbackProvider, useFeedback, type HapticPort } from './feedback'

function MotionProbe(): ReactElement {
    const { reduceMotion } = useFeedback()
    return <Text>{reduceMotion ? 'reduced' : 'full'}</Text>
}

const isReduceMotionEnabled = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
const addEventListener = jest.spyOn(AccessibilityInfo, 'addEventListener')

beforeEach(() => {
    isReduceMotionEnabled.mockReset()
    isReduceMotionEnabled.mockResolvedValue(false)
    addEventListener.mockReset()
    addEventListener.mockImplementation(() => ({ remove: (): void => undefined }) as unknown as EventSubscription)
})

// The most recent subscription is the one the probe under test registered.
function latestSystemListener(): (value: boolean) => void {
    const calls = addEventListener.mock.calls.filter(([eventName]) => eventName === 'reduceMotionChanged')
    const latest = calls.at(-1)
    if (latest === undefined) {
        throw new Error('reduceMotionChanged listener was not registered')
    }
    return latest[1] as (value: boolean) => void
}

describe('reduced motion', () => {
    it('treats motion as reduced until the system has answered', async () => {
        isReduceMotionEnabled.mockReturnValue(new Promise<boolean>(() => undefined))
        await render(<MotionProbe />)
        expect(screen.getByText('reduced')).toBeTruthy()
    })

    it('follows the system setting and reacts when the user changes it', async () => {
        isReduceMotionEnabled.mockResolvedValue(false)
        await render(<MotionProbe />)
        expect(await screen.findByText('full')).toBeTruthy()

        await act(() => latestSystemListener()(true))
        expect(await screen.findByText('reduced')).toBeTruthy()
    })

    it('an explicit override wins over the system setting', async () => {
        isReduceMotionEnabled.mockResolvedValue(false)
        await render(
            <FeedbackProvider reduceMotion={true}>
                <MotionProbe />
            </FeedbackProvider>,
        )
        expect(screen.getByText('reduced')).toBeTruthy()
    })
})

describe('haptic feedback', () => {
    it('the default adapter is silent and a press still reaches the action', async () => {
        const onPress = jest.fn()
        await render(<AppButton label="Take photo" onPress={onPress} variant="accent" />)
        fireEvent.press(screen.getByRole('button', { name: 'Take photo' }))
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('an injected adapter receives one selection intent per press', async () => {
        const trigger = jest.fn()
        const haptics: HapticPort = { trigger }
        const onPress = jest.fn()
        await render(
            <FeedbackProvider haptics={haptics}>
                <AppButton label="Confirm facts" onPress={onPress} variant="primary" />
            </FeedbackProvider>,
        )
        fireEvent.press(screen.getByRole('button', { name: 'Confirm facts' }))
        expect(trigger).toHaveBeenCalledWith('selection')
        expect(trigger).toHaveBeenCalledTimes(1)
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('a failing device adapter never blocks the action it accompanies', async () => {
        const haptics: HapticPort = {
            trigger: (): void => {
                throw new Error('haptic engine unavailable')
            },
        }
        const onPress = jest.fn()
        await render(
            <FeedbackProvider haptics={haptics}>
                <AppButton label="Send question" onPress={onPress} variant="secondary" />
            </FeedbackProvider>,
        )
        fireEvent.press(screen.getByRole('button', { name: 'Send question' }))
        expect(onPress).toHaveBeenCalledTimes(1)
    })
})
