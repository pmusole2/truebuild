import { describe, expect, it, jest } from '@jest/globals'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Dimensions, StyleSheet, Text } from 'react-native'
import { BottomSheet, InstructionSheet, SHEET_MAX_HEIGHT_RATIO } from './sheet'
import { spies } from './test-support/reanimated-mock'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
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
    it('never grows past 90 percent of the window and scrolls long content inside it', async () => {
        await render(
            <BottomSheet visible={true} title="Long result" onClose={(): void => undefined}>
                <Text>{'Step text. '.repeat(200)}</Text>
            </BottomSheet>,
        )
        const sheet = screen.getByTestId('bottom-sheet')
        expect(StyleSheet.flatten(sheet.props.style).maxHeight).toBeCloseTo(
            Dimensions.get('window').height * SHEET_MAX_HEIGHT_RATIO,
            6,
        )
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
