import { lightColors } from '../theme/tokens'
import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { StyleSheet, View } from 'react-native'
import type { ReactElement, ReactNode } from 'react'
import { FixedBottomBar } from './bottom-bar'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const mockWindow = { width: 390, height: 844, fontScale: 1 }
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): typeof mockWindow & { scale: number } => ({ ...mockWindow, scale: 3 }),
}))
beforeEach(() => Object.assign(mockWindow, { width: 390, height: 844, fontScale: 1 }))

describe('FixedBottomBar', () => {
    it('renders one 56 point accent primary and at most one tonal secondary', async () => {
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
            backgroundColor: lightColors.surfaceSunken,
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
                reason="Opening your manuals"
            />,
        )
        expect(screen.getByText('Opening your manuals')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Add manual' }).props.accessibilityState.disabled).toBe(true)
    })

    it('can hold only a quiet control when there is no forward action', async () => {
        await render(<FixedBottomBar primary={null} secondary={{ label: 'Cancel', onPress: (): void => undefined }} />)
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(1)
    })
})

describe('FixedBottomBar at accessibility text sizes', () => {
    const actions = {
        primary: { label: 'Start building', compactLabel: 'Start', testID: 'start', onPress: jest.fn() },
        secondary: {
            label: 'Skip for now',
            icon: 'arrowRight' as const,
            testID: 'skip',
            onPress: jest.fn(),
        },
    }

    it('keeps the full visible words and a stacked secondary at normal sizes', async () => {
        await render(<FixedBottomBar {...actions} />)
        expect(screen.getByText('Start building')).toBeTruthy()
        expect(screen.getByText('Skip for now')).toBeTruthy()
        expect(screen.queryByText('Start')).toBeNull()
    })

    it.each([2, 3.12, 3.6])(
        'shows one short verb with the full accessible name and test ID at scale %s',
        async (fontScale) => {
            mockWindow.fontScale = fontScale
            await render(<FixedBottomBar {...actions} />)
            expect(screen.getByText('Start')).toBeTruthy()
            expect(screen.queryByText('Start building')).toBeNull()
            expect(screen.getByRole('button', { name: 'Start building' })).toBe(screen.getByTestId('start'))
        },
    )

    it('moves the quiet secondary into the primary row as a 48 point icon that keeps its name, test ID and action', async () => {
        mockWindow.fontScale = 3.12
        await render(<FixedBottomBar {...actions} />)
        const secondary = screen.getByRole('button', { name: 'Skip for now' })
        expect(secondary).toBe(screen.getByTestId('skip'))
        expect(screen.queryByText('Skip for now')).toBeNull()
        expect(StyleSheet.flatten(secondary.props.style)).toMatchObject({ width: 48, minHeight: 48 })
        const primary = screen.getByTestId('start')
        expect(StyleSheet.flatten(primary.props.style)).toMatchObject({ minHeight: 56 })
        // Same row: both controls sit in one horizontal container.
        expect(primary.parent?.parent).toBe(secondary.parent)
        await fireEvent.press(secondary)
        await fireEvent.press(primary)
        expect(actions.secondary.onPress).toHaveBeenCalledTimes(1)
        expect(actions.primary.onPress).toHaveBeenCalledTimes(1)
    })

    it('keeps a text secondary when it has no icon, so no action is lost', async () => {
        mockWindow.fontScale = 3.12
        await render(
            <FixedBottomBar
                primary={actions.primary}
                secondary={{ label: 'Add manual', compactLabel: 'Add', onPress: jest.fn() }}
            />,
        )
        expect(screen.getByText('Add')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Add manual' })).toBeTruthy()
    })

    it('keeps the words of a quiet secondary that stands alone, so Cancel is never a stray icon', async () => {
        mockWindow.fontScale = 3.12
        await render(
            <FixedBottomBar
                primary={null}
                secondary={{ label: 'Cancel', icon: 'close', testID: 'cancel', onPress: jest.fn() }}
            />,
        )
        expect(screen.getByText('Cancel')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBe(screen.getByTestId('cancel'))
    })

    it('can float over the bottom edge and report its height, so a screen can pad its content by it', async () => {
        const onHeight = jest.fn()
        await render(<FixedBottomBar {...actions} placement="overlay" onHeight={onHeight} />)
        expect(StyleSheet.flatten(screen.getByTestId('bottom-bar').props.style)).toMatchObject({
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
        })
        await fireEvent(screen.getByTestId('bottom-bar'), 'layout', { nativeEvent: { layout: { height: 150 } } })
        expect(onHeight).toHaveBeenCalledWith(150)
    })

    it('lets a long reason scroll inside a bounded region instead of pushing the bar up', async () => {
        mockWindow.fontScale = 3.12
        await render(<FixedBottomBar primary={actions.primary} reason={'Wait for the current request. '.repeat(20)} />)
        const reason = screen.getByText(/Wait for the current request/u)
        const region = reason.parent?.parent
        expect(StyleSheet.flatten(region?.props.style)).toMatchObject({ maxHeight: Math.round(844 * 0.2) })
    })
})

it('keeps a document secondary actionable when step navigation owns the primary row', async () => {
    const secondary = jest.fn()
    function Navigation({ primary, secondary: extra }: { primary?: ReactNode; secondary?: ReactNode }): ReactElement {
        return (
            <View testID="navigation-row">
                {primary}
                {extra}
            </View>
        )
    }
    await render(
        <FixedBottomBar
            primary={{ label: 'Take photo', onPress: (): void => undefined }}
            secondary={{ label: 'Step details', onPress: secondary }}
            navigation={<Navigation />}
        />,
    )
    const row = within(screen.getByTestId('navigation-row'))
    expect(row.getByRole('button', { name: 'Take photo' })).toBeTruthy()
    await fireEvent.press(row.getByRole('button', { name: 'Step details' }))
    expect(secondary).toHaveBeenCalledTimes(1)
})
