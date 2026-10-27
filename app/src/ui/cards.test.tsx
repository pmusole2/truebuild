import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { ManualCard, ThumbnailCard } from './cards'

describe('ThumbnailCard', () => {
    it('is a named button that reports selection and fires its press', async () => {
        const onPress = jest.fn()
        await render(<ThumbnailCard title="Side panel photo" caption="Step 1" selected={true} onPress={onPress} />)
        const card = screen.getByRole('button', { name: 'Side panel photo, Step 1' })
        expect(card.props.accessibilityState).toEqual({ selected: true })
        await fireEvent.press(card)
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('shows a labelled placeholder rather than a blank tile when there is no image', async () => {
        await render(<ThumbnailCard title="Unphotographed step" onPress={(): void => undefined} />)
        expect(screen.getByRole('button', { name: 'Unphotographed step' })).toBeTruthy()
    })
})

describe('ManualCard', () => {
    it('names the manual with its summary so the card reads without the thumbnail', async () => {
        const onPress = jest.fn()
        await render(<ManualCard title="Side divider" summary="6 pages · 2 steps" onPress={onPress} />)
        await fireEvent.press(screen.getByRole('button', { name: 'Side divider, 6 pages · 2 steps' }))
        expect(onPress).toHaveBeenCalledTimes(1)
    })
})
