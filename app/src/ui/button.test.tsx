import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { Platform, StyleSheet } from 'react-native'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { controlHeight, lightColors, primaryHeight, touchTarget } from '../theme/tokens'
import { AppButton, IconButton } from './button'
import { FeedbackProvider } from './feedback'
import { SPRING_GENTLE } from './motion'
import { PRESS_SCALE } from './press-motion'
import { spies } from './test-support/reanimated-mock'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

describe('AppButton', () => {
    it('exposes a named button with its hint and runs the action once per press', async () => {
        const onPress = jest.fn()
        await render(
            <AppButton label="Find part in photo" icon="search" hint="Searches the frozen photo" onPress={onPress} />,
        )
        const button = screen.getByRole('button', { name: 'Find part in photo' })
        expect(screen.getAllByRole('button')).toHaveLength(1)
        expect(button.props.accessibilityHint).toBe('Searches the frozen photo')
        await fireEvent.press(button)
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('a disabled button announces its state and ignores presses', async () => {
        const onPress = jest.fn()
        await render(<AppButton label="Confirm expected facts" disabled onPress={onPress} />)
        const button = screen.getByRole('button', { name: 'Confirm expected facts' })
        expect(button.props.accessibilityState).toMatchObject({ disabled: true })
        await fireEvent.press(button)
        expect(onPress).not.toHaveBeenCalled()
    })

    it('a busy button keeps its label, reports busy and cannot be pressed again while in flight', async () => {
        const onPress = jest.fn()
        await render(<AppButton label="Reading photo" busy onPress={onPress} />)
        const button = screen.getByRole('button', { name: 'Reading photo' })
        expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: true })
        expect(screen.getByText('Reading photo')).toBeTruthy()
        await fireEvent.press(button)
        expect(onPress).not.toHaveBeenCalled()
    })

    it('keeps the interactive target at least 44 points tall', async () => {
        await render(<AppButton label="Use sample manual" variant="quiet" onPress={(): void => undefined} />)
        expect(screen.getByRole('button', { name: 'Use sample manual' })).toHaveStyle({ minHeight: touchTarget })
    })

    it('a tonal secondary button sits on the sunken fill at 48 points', async () => {
        await render(<AppButton label="Use sample manual" onPress={(): void => undefined} />)
        expect(screen.getByRole('button', { name: 'Use sample manual' })).toHaveStyle({
            backgroundColor: lightColors.surfaceSunken,
            minHeight: controlHeight,
        })
    })

    it('the primary action is a solid saturated accent, 56 points tall, with 16 point corners', async () => {
        await render(<AppButton label="Take photo" variant="accent" size="primary" onPress={(): void => undefined} />)
        expect(screen.getByRole('button', { name: 'Take photo' })).toHaveStyle({
            backgroundColor: lightColors.accent,
            minHeight: primaryHeight,
            borderRadius: 16,
        })
    })

    it('the accent variant carries the primary action colour and danger carries the refusal tone', async () => {
        await render(
            <>
                <AppButton label="Take photo" variant="accent" onPress={(): void => undefined} />
                <AppButton label="Discard plan" variant="danger" onPress={(): void => undefined} />
            </>,
        )
        expect(screen.getByRole('button', { name: 'Take photo' })).toHaveStyle({
            backgroundColor: lightColors.accent,
        })
        expect(screen.getByRole('button', { name: 'Discard plan' })).toHaveStyle({
            backgroundColor: lightColors.refuseSurface,
        })
    })

    it('honours the complete accessibility text-size range without a cap', async () => {
        await render(<AppButton label="Ask question" onPress={(): void => undefined} />)
        expect(screen.getByText('Ask question')).toHaveProp('maxFontSizeMultiplier', 0)
    })
})

describe('web keyboard focus', () => {
    it('shows a visible ring while a control holds keyboard focus on web, and removes it on blur', async () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'web')
        try {
            await render(<AppButton label="Ask question" onPress={(): void => undefined} />)
            const button = screen.getByRole('button', { name: 'Ask question' })
            const shadowOf = (): string | undefined =>
                (StyleSheet.flatten(button.props.style) as { boxShadow?: string }).boxShadow
            expect(shadowOf()).toBeUndefined()
            await fireEvent(button, 'focus')
            expect(shadowOf()).toContain(lightColors.focus)
            await fireEvent(button, 'blur')
            expect(shadowOf()).toBeUndefined()
        } finally {
            platform.restore()
        }
    })
})

describe('IconButton', () => {
    it('requires its label as the accessible name because it has no visible text', async () => {
        const onPress = jest.fn()
        await render(<IconButton label="Close answer" icon="close" onPress={onPress} />)
        await fireEvent.press(screen.getByRole('button', { name: 'Close answer' }))
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('is a round tonal 48 point control and does not fire while disabled', async () => {
        const onPress = jest.fn()
        await render(<IconButton label="Previous step" icon="chevronLeft" disabled onPress={onPress} />)
        const button = screen.getByRole('button', { name: 'Previous step' })
        expect(button).toHaveStyle({
            width: controlHeight,
            height: controlHeight,
            borderRadius: 999,
            backgroundColor: lightColors.surfaceSunken,
        })
        await fireEvent.press(button)
        expect(onPress).not.toHaveBeenCalled()
    })
})

describe('press motion', () => {
    beforeEach(() => {
        spies.withSpring.mockClear()
    })

    it('springs an action to 0.97 on press in and back to rest on press out', async () => {
        await render(<AppButton label="Take photo" onPress={(): void => undefined} />)
        const button = screen.getByRole('button', { name: 'Take photo' })
        await fireEvent(button, 'pressIn')
        expect(spies.withSpring).toHaveBeenLastCalledWith(1, SPRING_GENTLE)
        await fireEvent(button, 'pressOut')
        expect(spies.withSpring).toHaveBeenLastCalledWith(0, expect.any(Object))
        expect(PRESS_SCALE).toBe(0.97)
    })

    it('gives icon buttons the same press feel', async () => {
        await render(<IconButton label="Close answer" icon="close" onPress={(): void => undefined} />)
        await fireEvent(screen.getByRole('button', { name: 'Close answer' }), 'pressIn')
        expect(spies.withSpring).toHaveBeenCalledWith(1, expect.any(Object))
    })

    it('does not move a disabled or busy control', async () => {
        await render(
            <>
                <AppButton label="Off" disabled onPress={(): void => undefined} />
                <AppButton label="Working" busy onPress={(): void => undefined} />
            </>,
        )
        await fireEvent(screen.getByRole('button', { name: 'Off' }), 'pressIn')
        await fireEvent(screen.getByRole('button', { name: 'Working' }), 'pressIn')
        expect(spies.withSpring).not.toHaveBeenCalledWith(1, expect.any(Object))
    })

    it('uses no spring under reduced motion', async () => {
        await render(
            <FeedbackProvider reduceMotion={true}>
                <AppButton label="Take photo" onPress={(): void => undefined} />
            </FeedbackProvider>,
        )
        await fireEvent(screen.getByRole('button', { name: 'Take photo' }), 'pressIn')
        await fireEvent(screen.getByRole('button', { name: 'Take photo' }), 'pressOut')
        expect(spies.withSpring).not.toHaveBeenCalled()
    })
})

it('keeps a primary-size button at 56 points when the default tonal variant is used', async () => {
    await render(<AppButton label="Continue" size="primary" onPress={(): void => undefined} />)
    expect(StyleSheet.flatten(screen.getByRole('button', { name: 'Continue' }).props.style).minHeight).toBe(56)
})
