import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { StyleSheet, Text } from 'react-native'
import { Rect as SvgRect } from 'react-native-svg'
import type { Rect } from '../features/assembly/frame-geometry'
import { ComparisonFrame, frameHeightFor, MeasuredPane, type ComparisonPane } from './comparison'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

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

describe('ComparisonFrame point selection after a refusal', () => {
    it('maps a tap on the photo pane through the same letterbox geometry as the highlights', async () => {
        mockWindow.fontScale = 1
        const onTapPoint = jest.fn()
        await render(
            <ComparisonFrame diagram={pane({ caption: 'Manual diagram', regions: [] })} photo={pane({ onTapPoint })} />,
        )
        await measure('photo-frame', 300, 220)
        // Portrait 3000x4000 sits at x 67.5 with width 165: a tap at the centre of the photo is (0.5, 0.5).
        await fireEvent.press(screen.getByTestId('photo-tap'), {
            nativeEvent: { locationX: 150, locationY: 110 },
        })
        expect(onTapPoint).toHaveBeenCalledTimes(1)
        expect(onTapPoint.mock.calls[0]?.[0]).toEqual({ x: expect.any(Number), y: expect.any(Number) })
        const point = onTapPoint.mock.calls[0]?.[0] as { x: number; y: number }
        expect(point.x).toBeCloseTo(0.5, 6)
        expect(point.y).toBeCloseTo(0.5, 6)
    })
})

describe('ComparisonFrame overlay and notes', () => {
    const overlayOn = (overlay: ComparisonPane['overlay'], notes?: readonly string[]): ComparisonPane =>
        pane({ regions: [], overlay, notes })

    it('places the overlay on the letterboxed photo rect, not on the pane, and only after measuring', async () => {
        mockWindow.fontScale = 1
        const overlay = jest.fn((_displayed: Rect) => <SvgRect testID="probe" x={1} y={2} width={3} height={4} />)
        await render(<ComparisonFrame diagram={pane({ regions: [] })} photo={overlayOn(overlay)} />)
        expect(overlay).not.toHaveBeenCalled()
        await measure('photo-frame', 300, 220)
        // Portrait 3000x4000 in a 300x220 frame sits at x 67.5 with width 165, exactly as the highlights do.
        const rect = overlay.mock.calls.at(-1)![0]
        expect(rect.x).toBeCloseTo(67.5, 6)
        expect(rect.y).toBeCloseTo(0, 6)
        expect(rect.width).toBeCloseTo(165, 6)
        expect(rect.height).toBeCloseTo(220, 6)
        expect(screen.getByTestId('photo-overlay', { includeHiddenElements: true })).toBeTruthy()
        expect(screen.getByTestId('probe', { includeHiddenElements: true })).toBeTruthy()
    })

    it('uses the landscape letterbox for a landscape photo', async () => {
        const overlay = jest.fn((_displayed: Rect) => null)
        await render(
            <ComparisonFrame
                diagram={pane({ regions: [] })}
                photo={{ ...overlayOn(overlay), mediaSize: { width: 4000, height: 3000 } }}
            />,
        )
        await measure('photo-frame', 300, 220)
        const rect = overlay.mock.calls.at(-1)![0]
        expect(rect.x).toBeCloseTo(3.333_333, 5)
        expect(rect.width).toBeCloseTo(293.333_333, 5)
        expect(rect.height).toBeCloseTo(220, 6)
    })

    it('hides the decorative overlay from assistive tech and keeps the photo tappable beneath it', async () => {
        const onTapPoint = jest.fn()
        await render(
            <ComparisonFrame
                diagram={pane({ regions: [] })}
                photo={{ ...overlayOn(() => <SvgRect x={0} y={0} width={4} height={4} />), onTapPoint }}
            />,
        )
        await measure('photo-frame', 300, 220)
        const overlay = screen.getByTestId('photo-overlay', { includeHiddenElements: true })
        expect(overlay.props.accessibilityElementsHidden).toBe(true)
        expect(overlay.props.importantForAccessibility).toBe('no-hide-descendants')
        expect(overlay.props.pointerEvents).toBe('none')
        // The Svg is a DOM element on web, so it must not receive the native-only hiding props (React rejects them).
        const svg = within(overlay).getByTestId('photo-overlay-svg', { includeHiddenElements: true })
        expect(svg.props.accessibilityElementsHidden).toBeUndefined()
        expect(svg.props.importantForAccessibility).toBeUndefined()
        expect(svg.props.pointerEvents).toBe('none')
        await fireEvent.press(screen.getByTestId('photo-tap'), { nativeEvent: { locationX: 150, locationY: 110 } })
        expect(onTapPoint).toHaveBeenCalledTimes(1)
    })

    it('draws no overlay element when the pane supplies none', async () => {
        await render(<ComparisonFrame diagram={pane({ regions: [] })} photo={pane()} />)
        await measure('photo-frame', 300, 220)
        expect(screen.queryByTestId('photo-overlay', { includeHiddenElements: true })).toBeNull()
    })

    it('names the guidance in text beneath the pane, and shows no note when there is none', async () => {
        await render(
            <ComparisonFrame
                diagram={pane({ regions: [] })}
                photo={overlayOn(undefined, ['Next part: Divider', 'Target for Divider'])}
            />,
        )
        expect(screen.getByText('Next part: Divider')).toBeTruthy()
        expect(screen.getByText('Target for Divider')).toBeTruthy()
    })

    it('leaves the frame, border and highlight geometry exactly as before when an overlay is added', async () => {
        const bare = await render(<ComparisonFrame diagram={pane({ regions: [] })} photo={pane()} />)
        await measure('photo-frame', 300, 220)
        const before = numbers('photo-region-side')
        const frameBefore = StyleSheet.flatten(screen.getByTestId('photo-frame').props.style)
        await bare.unmount()
        await render(
            <ComparisonFrame
                diagram={pane({ regions: [] })}
                photo={pane({ overlay: () => <SvgRect x={0} y={0} width={4} height={4} /> })}
            />,
        )
        await measure('photo-frame', 300, 220)
        expect(numbers('photo-region-side')).toEqual(before)
        expect(StyleSheet.flatten(screen.getByTestId('photo-frame').props.style)).toEqual(frameBefore)
    })
})

describe('ComparisonFrame highlight contrast', () => {
    it('doubles each highlight with a wider contrast halo around the unchanged accent outline', async () => {
        mockWindow.fontScale = 1
        await render(<ComparisonFrame diagram={pane({ caption: 'Manual diagram', regions: [] })} photo={pane()} />)
        await measure('photo-frame', 300, 220)
        const accent = numbers('photo-region-side')
        const halo = numbers('photo-region-halo-side')
        // The halo extends two points past the outline on every side, so it shows on both edges of the stroke.
        expect(halo.left).toBeCloseTo(accent.left! - 2, 6)
        expect(halo.top).toBeCloseTo(accent.top! - 2, 6)
        expect(halo.width).toBeCloseTo(accent.width! + 4, 6)
        expect(halo.height).toBeCloseTo(accent.height! + 4, 6)
        expect(halo.borderWidth).toBeGreaterThan(accent.borderWidth!)
        expect(halo.borderColor).not.toBe(accent.borderColor)
        expect(accent.borderWidth).toBe(3)
    })

    it('names each pane with an eyebrow label and still names the highlight in text', async () => {
        await render(<ComparisonFrame diagram={pane({ caption: 'Manual diagram', regions: [] })} photo={pane()} />)
        await measure('photo-frame', 300, 220)
        expect(screen.getByText('Manual diagram')).toBeTruthy()
        expect(screen.getByText('Your photo')).toBeTruthy()
        expect(screen.getByText('Highlighted: Side panel')).toBeTruthy()
    })
})

describe('MeasuredPane media fit', () => {
    it('uses the full page proportions without the compact frame cap when opened in a sheet', () => {
        expect(frameHeightFor('page', 354, { width: 400, height: 600 })).toBe(531)
        expect(frameHeightFor('page', 354, { width: 600, height: 400 })).toBe(236)
    })

    it('follows the image proportions up to the fixed frame, and falls back to it for unusable sizes', () => {
        expect(frameHeightFor('media', 175, { width: 600, height: 400 })).toBeCloseTo(116.666_666, 5)
        // A portrait image would need 233 points at this width, so it is capped at the fixed 220 point frame.
        expect(frameHeightFor('media', 175, { width: 3000, height: 4000 })).toBe(220)
        expect(frameHeightFor('frame', 175, { width: 600, height: 400 })).toBe(220)
        for (const width of [0, Number.NaN]) {
            expect(frameHeightFor('media', width, { width: 600, height: 400 })).toBe(220)
        }
        expect(frameHeightFor('media', 175, { width: 0, height: 400 })).toBe(220)
    })

    it('contains the image exactly in the shortened frame, so highlights land with no letterbox band', async () => {
        const overlay = jest.fn((_displayed: Rect) => null)
        await render(
            <MeasuredPane
                pane={pane({ regions: [], overlay, mediaSize: { width: 600, height: 400 } })}
                testID="photo"
                sideBySide={true}
                fit="media"
            />,
        )
        await measure('photo-frame', 175, 220)
        const rect = overlay.mock.calls.at(-1)![0]
        expect(rect.x).toBeCloseTo(0, 6)
        expect(rect.y).toBeCloseTo(0, 6)
        expect(rect.width).toBeCloseTo(175, 6)
        expect(rect.height).toBeCloseTo(116.666_666, 5)
    })
})
