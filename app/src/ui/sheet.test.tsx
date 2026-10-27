import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { BottomSheet, InstructionSheet } from './sheet'

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
