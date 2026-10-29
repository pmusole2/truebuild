import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { processColor } from 'react-native'
import Svg from 'react-native-svg'
import { FeedbackProvider } from '../../ui/feedback'
import { spies } from '../../ui/test-support/reanimated-mock'
import { ThemeProvider } from '../../theme/theme'
import { lightColors } from '../../theme/tokens'
import {
    GroundedRegionOutline,
    OUTLINE_HALO_WIDTH,
    OUTLINE_LINE_WIDTH,
    PartRegionOverlays,
    PART_DASH,
} from './grounded-overlays'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

// Synthetic geometry only: no recorded or live model output backs these rects.
const RECT = { x: 20, y: 30, width: 100, height: 80 }

function outline(props: { rect?: typeof RECT }, reduceMotion: boolean | null): ReactElement {
    return (
        <FeedbackProvider reduceMotion={reduceMotion}>
            <Svg width={300} height={200}>
                <GroundedRegionOutline rect={props.rect ?? RECT} />
            </Svg>
        </FeedbackProvider>
    )
}

beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mockClear()
})

describe('static outline', () => {
    it('draws a contrast halo under a thicker accent line on exactly the given rect', async () => {
        await render(outline({}, true))
        const halo = screen.getByTestId('grounded-outline-halo')
        const line = screen.getByTestId('grounded-outline-line')
        for (const node of [halo, line]) {
            expect(node.props).toMatchObject({ x: 20, y: 30, width: 100, height: 80 })
        }
        expect(OUTLINE_HALO_WIDTH).toBeGreaterThan(OUTLINE_LINE_WIDTH)
        expect(OUTLINE_LINE_WIDTH).toBeGreaterThan(3)
        expect(halo.props.strokeWidth).toBe(OUTLINE_HALO_WIDTH)
        expect(line.props.strokeWidth).toBe(OUTLINE_LINE_WIDTH)
        expect(halo.props.stroke).not.toBe(line.props.stroke)
    })
})

describe('no pulse', () => {
    it.each([false, true, null])('never animates the outline whatever the motion preference (%s)', async (reduced) => {
        const { rerender } = await render(outline({}, reduced))
        await rerender(outline({ rect: { ...RECT, x: 40 } }, reduced))
        for (const spy of [spies.withTiming, spies.withSequence, spies.withRepeat, spies.withSpring]) {
            expect(spy).not.toHaveBeenCalled()
        }
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
    })
})

describe('next part and target overlays', () => {
    // Synthetic display rects only: no recorded or live model output backs these.
    const NEXT = { x: 20, y: 30, width: 60, height: 50 }
    const TARGET = { x: 200, y: 120, width: 70, height: 50 }
    const part = (
        props: Partial<Parameters<typeof PartRegionOverlays>[0]>,
        scheme: 'light' | 'dark' = 'light',
    ): ReactElement => (
        <FeedbackProvider reduceMotion={false}>
            <ThemeProvider scheme={scheme}>
                <Svg width={300} height={200}>
                    <PartRegionOverlays next={null} target={null} arrow={false} {...props} />
                </Svg>
            </ThemeProvider>
        </FeedbackProvider>
    )

    it('draws nothing at all without a returned region', async () => {
        await render(part({}))
        for (const id of ['next', 'target']) {
            expect(screen.queryByTestId(`part-${id}-line`)).toBeNull()
            expect(screen.queryByTestId(`part-${id}-halo`)).toBeNull()
        }
        expect(screen.queryByTestId('part-arrow-line')).toBeNull()
    })

    it('draws the next part dashed on exactly its rect, with a solid halo beneath', async () => {
        await render(part({ next: NEXT }))
        const line = screen.getByTestId('part-next-line')
        expect(line.props).toMatchObject({ ...NEXT, strokeDasharray: PART_DASH })
        expect(line.props.strokeWidth).toBe(OUTLINE_LINE_WIDTH)
        const halo = screen.getByTestId('part-next-halo')
        expect(halo.props).toMatchObject(NEXT)
        expect(halo.props.strokeDasharray).toBeUndefined()
        expect(halo.props.strokeWidth).toBe(OUTLINE_HALO_WIDTH)
        expect(screen.queryByTestId('part-target-line')).toBeNull()
        expect(screen.queryByTestId('part-arrow-line')).toBeNull()
    })

    it('draws the target solid, so next and target differ by stroke style and not by colour alone', async () => {
        await render(part({ next: NEXT, target: TARGET }))
        const target = screen.getByTestId('part-target-line')
        expect(target.props).toMatchObject(TARGET)
        expect(target.props.strokeDasharray).toBeUndefined()
        expect(screen.getByTestId('part-next-line').props.strokeDasharray).toEqual(PART_DASH)
        expect(target.props.stroke).not.toBe(screen.getByTestId('part-next-line').props.stroke)
    })

    it('draws a target alone with no arrow and no invented source', async () => {
        await render(part({ target: TARGET, arrow: true }))
        expect(screen.getByTestId('part-target-line')).toBeTruthy()
        expect(screen.queryByTestId('part-next-line')).toBeNull()
        expect(screen.queryByTestId('part-arrow-line')).toBeNull()
    })

    it('draws one arrow from the next part edge to the target edge only when both rects and the pairing exist', async () => {
        await render(part({ next: NEXT, target: TARGET, arrow: true }))
        const line = screen.getByTestId('part-arrow-line')
        expect(line.props.x1).toBeGreaterThanOrEqual(NEXT.x)
        expect(line.props.x1).toBeLessThanOrEqual(NEXT.x + NEXT.width)
        // The shaft stops at the head's base; the head's tip is the point that lands on the target's edge.
        // react-native-svg turns the points into a path whose first move is the tip.
        const tip = /^M(\S+) (\S+)/u
            .exec(String(screen.getByTestId('part-arrow-head').props.d))!
            .slice(1)
            .map(Number)
        expect(tip[0]).toBeCloseTo(TARGET.x, 6)
        expect(tip[1]).toBeGreaterThanOrEqual(TARGET.y)
        expect(tip[1]).toBeLessThanOrEqual(TARGET.y + TARGET.height)
        expect(line.props.x2).toBeLessThan(tip[0]!)
        expect(screen.getByTestId('part-arrow-halo')).toBeTruthy()
    })

    it('draws no arrow when the guidance says the parts do not pair, even with both rects', async () => {
        await render(part({ next: NEXT, target: TARGET, arrow: false }))
        expect(screen.getByTestId('part-next-line')).toBeTruthy()
        expect(screen.getByTestId('part-target-line')).toBeTruthy()
        expect(screen.queryByTestId('part-arrow-line')).toBeNull()
    })

    const tipOf = (): number[] =>
        /^M(\S+) (\S+)/u
            .exec(String(screen.getByTestId('part-arrow-head').props.d))!
            .slice(1)
            .map(Number)

    it('draws a scaled, correctly directed arrow between the centres when the boxes touch, leaving both boxes as returned', async () => {
        const touching = { ...NEXT, x: NEXT.x + NEXT.width }
        await render(part({ next: NEXT, target: touching, arrow: true }))
        const line = screen.getByTestId('part-arrow-line')
        // Centre to centre: (50, 55) to (110, 55). The tip is the target centre; the shaft stops at the head's base.
        const tip = tipOf()
        expect(tip[0]).toBeCloseTo(110, 6)
        expect(tip[1]).toBeCloseTo(55, 6)
        expect(line.props.x1).toBeCloseTo(50, 6)
        expect(line.props.y1).toBeCloseTo(55, 6)
        expect(line.props.x2).toBeGreaterThan(line.props.x1)
        expect(line.props.x2).toBeLessThan(tip[0]!)
        for (const value of [line.props.x1, line.props.y1, line.props.x2, line.props.y2, ...tip]) {
            expect(Number.isFinite(value)).toBe(true)
        }
        // Neither returned box moved or grew.
        expect(screen.getByTestId('part-next-line').props).toMatchObject(NEXT)
        expect(screen.getByTestId('part-target-line').props).toMatchObject(touching)
    })

    it('scales the head and strokes down for a very short centre line instead of drawing a blob or nothing', async () => {
        await render(part({ next: NEXT, target: { ...NEXT, x: NEXT.x + 3 }, arrow: true }))
        const line = screen.getByTestId('part-arrow-line')
        const tip = tipOf()
        // A 3 point line: the shaft is shorter than the line, the head fits inside it, the stroke is thinner than full.
        expect(tip[0]).toBeCloseTo(53, 6)
        expect(line.props.x2 - line.props.x1).toBeGreaterThan(0)
        expect(line.props.x2 - line.props.x1).toBeLessThan(3)
        expect(line.props.strokeWidth).toBeLessThan(3)
        expect(line.props.strokeWidth).toBeGreaterThan(0)
    })

    it('draws no arrow when both returned boxes share one centre, since that has no direction', async () => {
        await render(part({ next: NEXT, target: NEXT, arrow: true }))
        expect(screen.queryByTestId('part-arrow-line')).toBeNull()
        expect(screen.getByTestId('part-next-line')).toBeTruthy()
        expect(screen.getByTestId('part-target-line')).toBeTruthy()
    })

    it.each(['light', 'dark'] as const)('keeps the same daylight halo and ink in the %s scheme', async (scheme) => {
        await render(part({ next: NEXT, target: TARGET, arrow: true }, scheme))
        // react-native-svg resolves colour strings to native colour payloads before they reach the node.
        const stroke = (testID: string): unknown => screen.getByTestId(testID).props.stroke
        const native = (color: string): unknown => ({ type: 0, payload: processColor(color) })
        expect(stroke('part-next-halo')).toEqual(native(lightColors.inkInverse))
        expect(stroke('part-target-halo')).toEqual(native(lightColors.inkInverse))
        expect(stroke('part-arrow-halo')).toEqual(native(lightColors.inkInverse))
        expect(stroke('part-arrow-line')).toEqual(native(lightColors.ink))
    })

    it('starts no animation whatever the motion preference, so the guidance is static', async () => {
        await render(part({ next: NEXT, target: TARGET, arrow: true }))
        expect(spies.withTiming).not.toHaveBeenCalled()
        expect(spies.withSequence).not.toHaveBeenCalled()
        expect(spies.withRepeat).not.toHaveBeenCalled()
    })

    it('draws the static observed outline together with guidance and animates neither', async () => {
        await render(
            <FeedbackProvider reduceMotion={false}>
                <Svg width={300} height={200}>
                    <GroundedRegionOutline rect={RECT} />
                    <PartRegionOverlays next={NEXT} target={TARGET} arrow={true} />
                </Svg>
            </FeedbackProvider>,
        )
        expect(spies.withSequence).not.toHaveBeenCalled()
        expect(spies.withTiming).not.toHaveBeenCalled()
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
    })
})
