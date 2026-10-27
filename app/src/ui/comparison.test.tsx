import { describe, expect, it } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { ComparisonFrame } from './comparison'

describe('ComparisonFrame', () => {
    it('names the highlighted regions in text, so the outline is never the only signal', async () => {
        await render(
            <ComparisonFrame
                diagram={<Text>Diagram</Text>}
                photo={<Text>Photo</Text>}
                photoRegions={[{ id: 'side', label: 'Side panel', box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }]}
            />,
        )
        expect(screen.getByText('Highlighted: Side panel')).toBeTruthy()
    })

    it('draws only regions that are valid and inside the frame, and omits the highlight caption for none', async () => {
        await render(
            <ComparisonFrame
                diagram={<Text>Diagram</Text>}
                photo={<Text>Photo</Text>}
                photoRegions={[
                    { id: 'bad', label: 'Broken box', box: { x: Number.NaN, y: 0, width: 0.2, height: 0.2 } },
                    { id: 'clipped', label: 'Edge part', box: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 } },
                ]}
            />,
        )
        expect(screen.queryByText(/Broken box/u)).toBeNull()
        expect(screen.getByText('Highlighted: Edge part')).toBeTruthy()
    })

    it('shows both panes with their captions and does not add a highlight without regions', async () => {
        await render(<ComparisonFrame diagram={<Text>Diagram</Text>} photo={<Text>Photo</Text>} />)
        expect(screen.getByText('Manual diagram')).toBeTruthy()
        expect(screen.getByText('Your photo')).toBeTruthy()
        expect(screen.queryByText(/Highlighted/u)).toBeNull()
    })
})
