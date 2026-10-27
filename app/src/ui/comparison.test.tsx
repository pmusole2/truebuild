import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet, Text } from 'react-native'
import { ComparisonFrame, type ComparisonPane } from './comparison'

// Font scale and window width are controlled per test; the frame reads them through the window-dimensions hook.
const mockWindow = { width: 390, fontScale: 1 }
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): { width: number; height: number; scale: number; fontScale: number } => ({
        width: mockWindow.width,
        height: 844,
        scale: 2,
        fontScale: mockWindow.fontScale,
    }),
}))

const PHOTO_REGION = { id: 'side', label: 'Side panel', box: { x: 0, y: 0, width: 0.5, height: 0.5 } }

function pane(overrides: Partial<ComparisonPane> = {}): ComparisonPane {
    return {
        caption: 'Your photo',
        media: <Text>Photo</Text>,
        mediaSize: { width: 3000, height: 4000 },
        regions: [PHOTO_REGION],
        ...overrides,
    }
}

async function measure(testID: string, width: number, height: number): Promise<void> {
    await fireEvent(screen.getByTestId(testID), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height } } })
}

function numbers(testID: string): Record<string, number> {
    // Highlights are hidden from accessibility on purpose, so the probe opts in to query them by geometry.
    const style = StyleSheet.flatten(screen.getByTestId(testID, { includeHiddenElements: true }).props.style) as Record<
        string,
        number
    >
    return style
}

describe('ComparisonFrame portrait-vs-landscape fit', () => {
    it('places a highlight on a portrait photo inside its letterboxed image rect', async () => {
        mockWindow.width = 390
        mockWindow.fontScale = 1
        await render(<ComparisonFrame diagram={pane({ caption: 'Manual diagram', regions: [] })} photo={pane()} />)
        await measure('photo-frame', 300, 220)
        expect(numbers('photo-media')).toMatchObject({ width: expect.any(Number), height: 220 })
        expect(numbers('photo-media').left).toBeCloseTo(67.5, 6)
        expect(numbers('photo-region-side').left).toBeCloseTo(67.5, 6)
        expect(numbers('photo-region-side').width).toBeCloseTo(82.5, 6)
        expect(numbers('photo-region-side').height).toBeCloseTo(110, 6)
    })

    it('places the same highlight on a landscape photo with its own letterbox offsets', async () => {
        await render(
            <ComparisonFrame
                diagram={pane({ caption: 'Manual diagram', regions: [] })}
                photo={pane({ mediaSize: { width: 4000, height: 3000 } })}
            />,
        )
        await measure('photo-frame', 300, 220)
        expect(numbers('photo-region-side').left).toBeCloseTo(3.333_333, 5)
        expect(numbers('photo-region-side').top).toBeCloseTo(0, 6)
        expect(numbers('photo-region-side').width).toBeCloseTo(146.666_667, 5)
        expect(numbers('photo-region-side').height).toBeCloseTo(110, 6)
    })

    it('draws no highlight before the frame is measured, and names the drawn ones in text', async () => {
        await render(<ComparisonFrame diagram={pane({ caption: 'Manual diagram', regions: [] })} photo={pane()} />)
        expect(screen.queryByTestId('photo-region-side', { includeHiddenElements: true })).toBeNull()
        await measure('photo-frame', 300, 220)
        expect(screen.getByText('Highlighted: Side panel')).toBeTruthy()
    })
})

describe('ComparisonFrame layout', () => {
    it('places the manual and photo side by side at phone width', async () => {
        mockWindow.fontScale = 1
        await render(<ComparisonFrame diagram={pane({ caption: 'Manual diagram', regions: [] })} photo={pane()} />)
        await measure('comparison-stack', 326, 400)
        expect(screen.getByTestId('comparison-stack')).toHaveStyle({ flexDirection: 'row' })
    })

    it('stacks under large system text even when the width would fit side by side', async () => {
        mockWindow.fontScale = 2
        await render(<ComparisonFrame diagram={pane({ caption: 'Manual diagram', regions: [] })} photo={pane()} />)
        await measure('comparison-stack', 326, 400)
        expect(screen.getByTestId('comparison-stack')).not.toHaveStyle({ flexDirection: 'row' })
        mockWindow.fontScale = 1
    })

    it('stacks when the width is too narrow for two usable panes', async () => {
        mockWindow.fontScale = 1
        await render(<ComparisonFrame diagram={pane({ caption: 'Manual diagram', regions: [] })} photo={pane()} />)
        await measure('comparison-stack', 260, 400)
        expect(screen.getByTestId('comparison-stack')).not.toHaveStyle({ flexDirection: 'row' })
    })
})
