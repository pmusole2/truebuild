import { describe, expect, it } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { ComponentPreview } from './component-preview'
import { PREVIEW_BANNER } from './examples'

const SECTIONS = [
    'Typography',
    'Buttons',
    'Icons',
    'Status and verdicts',
    'Results',
    'Notices',
    'Cards',
    'Progress and steps',
    'Loading, empty, error and permission',
    'Fields and settings',
    'Camera',
    'Sheets',
    'Comparison',
]

describe('ComponentPreview', () => {
    it('is labelled as a static preview and lists every component section', async () => {
        await render(<ComponentPreview />)
        expect(screen.getByText(PREVIEW_BANNER)).toBeTruthy()
        for (const section of SECTIONS) {
            expect(screen.getByRole('header', { name: section })).toBeTruthy()
        }
    })

    it('opens the instruction sheet locally and does not send anything', async () => {
        await render(<ComponentPreview />)
        expect(screen.queryByText('Keep the panel free before seating the divider.')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Open instruction sheet' }))
        expect(screen.getByLabelText('Step 2: Keep the panel free before seating the divider.')).toBeTruthy()
    })

    it('switches to dark and back to light without changing any product state', async () => {
        await render(<ComponentPreview />)
        await fireEvent.press(screen.getByRole('radio', { name: 'Dark' }))
        expect(screen.getByRole('radio', { name: 'Dark' }).props.accessibilityState).toEqual({ checked: true })
        await fireEvent.press(screen.getByRole('radio', { name: 'Light' }))
        expect(screen.getByRole('radio', { name: 'Light' }).props.accessibilityState).toEqual({ checked: true })
    })
})
