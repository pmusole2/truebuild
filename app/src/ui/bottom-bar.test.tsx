import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { FixedBottomBar } from './bottom-bar'

jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

describe('FixedBottomBar', () => {
    it('renders one 56 point accent primary and at most one quiet secondary', async () => {
        const primary = jest.fn()
        const secondary = jest.fn()
        await render(
            <FixedBottomBar
                primary={{ label: 'Take photo', onPress: primary, testID: 'p' }}
                secondary={{ label: 'Add manual', onPress: secondary }}
            />,
        )
        const buttons = within(screen.getByTestId('bottom-bar')).getAllByRole('button')
        expect(buttons).toHaveLength(2)
        expect(StyleSheet.flatten(screen.getByTestId('p').props.style)).toMatchObject({ minHeight: 56 })
        expect(StyleSheet.flatten(screen.getByRole('button', { name: 'Add manual' }).props.style)).toMatchObject({
            backgroundColor: 'transparent',
        })
        await fireEvent.press(screen.getByTestId('p'))
        await fireEvent.press(screen.getByRole('button', { name: 'Add manual' }))
        expect(primary).toHaveBeenCalledTimes(1)
        expect(secondary).toHaveBeenCalledTimes(1)
    })

    it('says why a primary is disabled, in one line above it, and keeps the primary in place', async () => {
        await render(
            <FixedBottomBar
                primary={{ label: 'Add manual', onPress: (): void => undefined, disabled: true }}
                reason="Your builds are opening."
            />,
        )
        expect(screen.getByText('Your builds are opening.')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Add manual' }).props.accessibilityState.disabled).toBe(true)
    })

    it('can hold only a quiet control when there is no forward action', async () => {
        await render(<FixedBottomBar primary={null} secondary={{ label: 'Cancel', onPress: (): void => undefined }} />)
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(1)
    })
})
