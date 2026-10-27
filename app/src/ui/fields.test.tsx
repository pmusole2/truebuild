import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { useState, type ReactElement } from 'react'
import { SegmentedControl, SettingRow, TextField } from './fields'

describe('TextField', () => {
    it('is labelled and exposes its error as the description, not only as red text', async () => {
        await render(
            <TextField
                label="Question about this step"
                value=""
                onChangeText={(): void => undefined}
                error="Enter a question first."
            />,
        )
        const input = screen.getByLabelText('Question about this step')
        expect(input.props.accessibilityHint).toBe('Enter a question first.')
        expect(screen.getByText('Enter a question first.')).toBeTruthy()
    })

    it('a secret field is masked and never autocorrected or capitalised', async () => {
        await render(<TextField label="Shared key" value="" onChangeText={(): void => undefined} secure={true} />)
        const input = screen.getByLabelText('Shared key')
        expect(input.props.secureTextEntry).toBe(true)
        expect(input.props.autoCapitalize).toBe('none')
        expect(input.props.autoCorrect).toBe(false)
    })

    it('reports typed text to the caller', async () => {
        const onChangeText = jest.fn()
        await render(<TextField label="Part to find in the photo" value="" onChangeText={onChangeText} />)
        await fireEvent.changeText(screen.getByLabelText('Part to find in the photo'), 'side panel')
        expect(onChangeText).toHaveBeenCalledWith('side panel')
    })
})

type Option = 'left' | 'right'

function ChoiceHarness(): ReactElement {
    const [value, setValue] = useState<Option>('left')
    return (
        <SegmentedControl<Option>
            label="Panel side"
            value={value}
            onChange={setValue}
            options={[
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
            ]}
        />
    )
}

describe('SegmentedControl', () => {
    it('is a radio group whose selection is announced and changes on press', async () => {
        await render(<ChoiceHarness />)
        // The group itself is not an accessible element, so its role is checked on the labelled node.
        expect(screen.getByLabelText('Panel side').props.accessibilityRole).toBe('radiogroup')
        expect(screen.getByRole('radio', { name: 'Left' }).props.accessibilityState).toEqual({ checked: true })
        await fireEvent.press(screen.getByRole('radio', { name: 'Right' }))
        expect(screen.getByRole('radio', { name: 'Right' }).props.accessibilityState).toEqual({ checked: true })
        expect(screen.getByRole('radio', { name: 'Left' }).props.accessibilityState).toEqual({ checked: false })
    })
})

describe('SettingRow', () => {
    it('is a switch that states its value in words and toggles on press', async () => {
        const onValueChange = jest.fn()
        await render(<SettingRow label="Keep photos on this device" value={false} onValueChange={onValueChange} />)
        const row = screen.getByRole('switch', { name: 'Keep photos on this device' })
        expect(row.props.accessibilityState).toEqual({ checked: false })
        expect(screen.getByText('Off')).toBeTruthy()
        await fireEvent.press(row)
        expect(onValueChange).toHaveBeenCalledWith(true)
    })
})
