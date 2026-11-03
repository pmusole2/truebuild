import { fireEvent, render, screen } from '@testing-library/react-native'
import { useState, type ReactElement } from 'react'
import { View } from 'react-native'
import { ReadingLanguagePicker } from './reading-language-picker'

function Picker(): ReactElement {
    const [value, setValue] = useState('en')
    return (
        <View style={{ width: 288 }}>
            <ReadingLanguagePicker label="Reading language" value={value} onChange={setValue} />
        </View>
    )
}

it('offers all five named languages as reachable radios and announces the selected choice', async () => {
    await render(<Picker />)
    for (const copy of ['Manual language', 'The language TrueBuild reads and writes in']) {
        expect(screen.queryByText(copy)).toBeNull()
        expect(screen.getByText(copy, { includeHiddenElements: true })).toBeTruthy()
    }
    for (const name of ['English', 'Spanish', 'French', 'German', 'Portuguese']) {
        expect(screen.getByRole('radio', { name })).toBeTruthy()
    }
    expect(screen.getByRole('radio', { name: 'English' }).props.accessibilityState.checked).toBe(true)
    await fireEvent.press(screen.getByRole('radio', { name: 'Portuguese' }))
    expect(screen.getByRole('radio', { name: 'Portuguese' }).props.accessibilityState.checked).toBe(true)
    expect(screen.getByRole('radio', { name: 'English' }).props.accessibilityState.checked).toBe(false)
})
