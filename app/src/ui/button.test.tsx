import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { lightColors, touchTarget } from '../theme/tokens'
import { AppButton, IconButton } from './button'

describe('AppButton', () => {
    it('exposes a named button with its hint and runs the action once per press', async () => {
        const onPress = jest.fn()
        await render(<AppButton label="Find part in photo" hint="Searches the frozen photo" onPress={onPress} />)
        const button = screen.getByRole('button', { name: 'Find part in photo' })
        expect(button.props.accessibilityHint).toBe('Searches the frozen photo')
        fireEvent.press(button)
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('a disabled button announces its state and ignores presses', async () => {
        const onPress = jest.fn()
        await render(<AppButton label="Confirm expected facts" disabled onPress={onPress} />)
        const button = screen.getByRole('button', { name: 'Confirm expected facts' })
        expect(button.props.accessibilityState).toMatchObject({ disabled: true })
        fireEvent.press(button)
        expect(onPress).not.toHaveBeenCalled()
    })

    it('a busy button keeps its label, reports busy and cannot be pressed again while in flight', async () => {
        const onPress = jest.fn()
        await render(<AppButton label="Reading photo" busy onPress={onPress} />)
        const button = screen.getByRole('button', { name: 'Reading photo' })
        expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: true })
        expect(screen.getByText('Reading photo')).toBeTruthy()
        fireEvent.press(button)
        expect(onPress).not.toHaveBeenCalled()
    })

    it('keeps the interactive target at least 44 points tall', async () => {
        await render(<AppButton label="Use sample manual" onPress={(): void => undefined} />)
        expect(screen.getByRole('button', { name: 'Use sample manual' })).toHaveStyle({ minHeight: touchTarget })
    })

    it('the accent variant carries the amber call to action and danger carries the refusal tone', async () => {
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

    it('scales its label to 200 percent of the system text size', async () => {
        await render(<AppButton label="Ask question" onPress={(): void => undefined} />)
        expect(screen.getByText('Ask question')).toHaveProp('maxFontSizeMultiplier', 2)
    })
})

describe('IconButton', () => {
    it('requires its label as the accessible name because it has no visible text', async () => {
        const onPress = jest.fn()
        await render(<IconButton label="Close answer" icon="close" onPress={onPress} />)
        fireEvent.press(screen.getByRole('button', { name: 'Close answer' }))
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('is a 44 by 44 point square and does not fire while disabled', async () => {
        const onPress = jest.fn()
        await render(<IconButton label="Previous step" icon="chevronLeft" disabled onPress={onPress} />)
        const button = screen.getByRole('button', { name: 'Previous step' })
        expect(button).toHaveStyle({ width: touchTarget, minHeight: touchTarget })
        fireEvent.press(button)
        expect(onPress).not.toHaveBeenCalled()
    })
})
