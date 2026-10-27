import { describe, expect, it } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import { lightColors } from '../theme/tokens'
import { Body, Caption, Heading, Label, Title } from './text'

describe('typography primitives', () => {
    it('marks titles and headings as headers so screen readers can navigate by them', async () => {
        await render(
            <>
                <Title>Manual</Title>
                <Heading>Step 2</Heading>
                <Body>Seat the divider</Body>
            </>,
        )
        expect(screen.getByRole('header', { name: 'Manual' })).toBeTruthy()
        expect(screen.getByRole('header', { name: 'Step 2' })).toBeTruthy()
        expect(screen.queryByRole('header', { name: 'Seat the divider' })).toBeNull()
    })

    it('reading text and labels scale to 200 percent of the system size', async () => {
        await render(
            <>
                <Body>Groove faces inward</Body>
                <Label>Part 1 of 2</Label>
            </>,
        )
        expect(screen.getByText('Groove faces inward')).toHaveProp('maxFontSizeMultiplier', 2)
        expect(screen.getByText('Part 1 of 2')).toHaveProp('maxFontSizeMultiplier', 2)
    })

    it('captions and labels are muted, and labels stay uppercase in the mono stamp style', async () => {
        await render(
            <>
                <Caption>Simulated photo</Caption>
                <Label>Stamp</Label>
            </>,
        )
        expect(screen.getByText('Simulated photo')).toHaveStyle({ color: lightColors.inkMuted })
        expect(screen.getByText('Stamp')).toHaveStyle({ textTransform: 'uppercase' })
    })

    it('a tone override replaces the default colour instead of being ignored', async () => {
        await render(<Body tone="refuse">Refused: reversed panel</Body>)
        expect(screen.getByText('Refused: reversed panel')).toHaveStyle({ color: lightColors.refuse })
    })
})
