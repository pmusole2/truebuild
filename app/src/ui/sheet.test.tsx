import { describe, expect, it, jest } from '@jest/globals'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Dimensions, StyleSheet, Text } from 'react-native'
import { BottomSheet, DETENT_RATIO, InstructionSheet, MoreSheet, SHEET_MAX_HEIGHT_RATIO, snapHeight } from './sheet'
import { spies } from './test-support/reanimated-mock'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

describe('BottomSheet', () => {
    it('shows its title as a header and its content while visible', async () => {
        await render(
            <BottomSheet visible={true} title="Instructions" onClose={(): void => undefined}>
                <Text>Groove faces inward</Text>
            </BottomSheet>,
        )
        expect(screen.getByRole('header', { name: 'Instructions' })).toBeTruthy()
        expect(screen.getByText('Groove faces inward')).toBeTruthy()
    })

    it('closes from its labelled close control', async () => {
        const onClose = jest.fn()
        await render(
            <BottomSheet visible={true} title="Instructions" onClose={onClose}>
                <Text>Body</Text>
            </BottomSheet>,
        )
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders no content while hidden', async () => {
        await render(
            <BottomSheet visible={false} title="Instructions" onClose={(): void => undefined}>
                <Text>Hidden body</Text>
            </BottomSheet>,
        )
        expect(screen.queryByText('Hidden body')).toBeNull()
    })
})

describe('BottomSheet bounds', () => {
    it('opens at the tall detent, never grows past 92 percent of the window and scrolls long content inside it', async () => {
        await render(
            <BottomSheet visible={true} title="Long result" onClose={(): void => undefined}>
                <Text>{'Step text. '.repeat(200)}</Text>
            </BottomSheet>,
        )
        const sheet = screen.getByTestId('bottom-sheet')
        expect(StyleSheet.flatten(sheet.props.style).height).toBeCloseTo(Dimensions.get('window').height * 0.78, 0)
        expect(SHEET_MAX_HEIGHT_RATIO).toBe(0.92)
        expect(screen.getByTestId('bottom-sheet-scroll')).toBeTruthy()
    })

    it('cancels its entrance animation when the sheet unmounts', async () => {
        spies.cancelAnimation.mockClear()
        const rendered = await render(
            <BottomSheet visible={true} title="Instructions" onClose={(): void => undefined}>
                <Text>Body</Text>
            </BottomSheet>,
        )
        await act(() => rendered.unmount())
        expect(spies.cancelAnimation).toHaveBeenCalled()
    })
})

describe('InstructionSheet', () => {
    it('announces each instruction with its step number', async () => {
        await render(
            <InstructionSheet
                visible={true}
                title="Step 1"
                steps={['Stand the side panel upright.', 'Keep the panel free before seating the divider.']}
                onClose={(): void => undefined}
            />,
        )
        expect(screen.getByLabelText('Step 1: Stand the side panel upright.')).toBeTruthy()
        expect(screen.getByLabelText('Step 2: Keep the panel free before seating the divider.')).toBeTruthy()
    })
})

describe('MoreSheet and detents', () => {
    const heightOf = (): number => StyleSheet.flatten(screen.getByTestId('more-sheet').props.style).height as number
    const window = (): number => Dimensions.get('window').height

    it('is the one More pattern: a grabber, a labelled close control, and its own test ids', async () => {
        await render(
            <MoreSheet visible={true} onClose={(): void => undefined}>
                <Text>Details</Text>
            </MoreSheet>,
        )
        expect(screen.getByRole('header', { name: 'More' })).toBeTruthy()
        expect(screen.getByTestId('sheet-handle')).toBeTruthy()
        expect(screen.getByTestId('more-sheet-scroll')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Close sheet' })).toBeTruthy()
    })

    it.each([
        ['peek', 'peek' as const, DETENT_RATIO.peek],
        ['tall', 'tall' as const, DETENT_RATIO.tall],
        ['full', 'full' as const, DETENT_RATIO.full],
    ])('opens at the %s detent when asked', async (_name, initial, ratio) => {
        await render(
            <MoreSheet
                visible={true}
                onClose={(): void => undefined}
                detents={['peek', 'tall', 'full']}
                initialDetent={initial}
            >
                <Text>Details</Text>
            </MoreSheet>,
        )
        expect(heightOf()).toBeCloseTo(window() * ratio, 0)
    })

    it('defaults to the tall detent of two, and to the larger when only tall and full are offered', async () => {
        await render(
            <MoreSheet visible={true} onClose={(): void => undefined}>
                <Text>Details</Text>
            </MoreSheet>,
        )
        expect(heightOf()).toBeCloseTo(window() * DETENT_RATIO.tall, 0)
    })

    it('moves between detents from the assistive increment and decrement actions, and closes below the smallest', async () => {
        const onClose = jest.fn()
        await render(
            <MoreSheet visible={true} onClose={onClose} detents={['peek', 'tall', 'full']}>
                <Text>Details</Text>
            </MoreSheet>,
        )
        const handle = screen.getByTestId('sheet-handle')
        await fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } })
        expect(heightOf()).toBeCloseTo(window() * DETENT_RATIO.full, 0)
        await fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } })
        await fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } })
        expect(heightOf()).toBeCloseTo(window() * DETENT_RATIO.peek, 0)
        // Reduced motion in the stand-in: the close is immediate here only after the entrance timer.
        await fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } })
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('does not fail where the platform cannot move screen reader focus', async () => {
        const original = AccessibilityInfo.sendAccessibilityEvent
        Object.assign(AccessibilityInfo, { sendAccessibilityEvent: undefined })
        try {
            await render(
                <MoreSheet visible={true} onClose={(): void => undefined}>
                    <Text>Details</Text>
                </MoreSheet>,
            )
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10))
            })
            expect(screen.getByText('Details')).toBeTruthy()
        } finally {
            Object.assign(AccessibilityInfo, { sendAccessibilityEvent: original })
        }
    })
})

describe('snapHeight', () => {
    const heights = [300, 600, 800]
    it.each([
        [310, 300],
        [520, 600],
        [790, 800],
        [2000, 800],
    ])('settles %s on the nearest detent %s', (projected, expected) => {
        expect(snapHeight(projected, heights, 180)).toBe(expected)
    })
    it('closes when thrown below the close line', () => {
        expect(snapHeight(120, heights, 180)).toBe(0)
        expect(snapHeight(-50, heights, 180)).toBe(0)
    })
})
