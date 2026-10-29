import type { ReactElement } from 'react'
import { Line, Polygon, Rect, type RectProps } from 'react-native-svg'
import { useTheme } from '../../theme/theme'
import { lightColors, radius } from '../../theme/tokens'
import { arrowSegment } from '../capture/part-regions'
import type { Rect as DisplayRect } from './frame-geometry'

// A light halo under the accent line keeps the region readable on bright, dark and busy photos alike.
export const OUTLINE_LINE_WIDTH = 4
export const OUTLINE_HALO_WIDTH = 8

type GroundedRegionOutlineProps = {
    // The region exactly as returned, already placed on the displayed photo. Nothing is moved, grown or defaulted here.
    readonly rect: DisplayRect | null
}

/**
 * The grounded region on the frozen photo, drawn as SVG children (FrozenPhoto places its overlay inside an Svg).
 * The outline is always static: it never pulses, so a returned region reads as evidence, not decoration.
 */
export function GroundedRegionOutline({ rect }: GroundedRegionOutlineProps): ReactElement {
    const { colors } = useTheme()
    if (rect === null) return <></>
    const geometry = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rx: radius.sm, fill: 'none' }
    return (
        <>
            <Rect
                testID="grounded-outline-halo"
                {...geometry}
                stroke={colors.inkInverse}
                strokeWidth={OUTLINE_HALO_WIDTH}
            />
            <Rect
                testID="grounded-outline-line"
                {...geometry}
                stroke={colors.accent}
                strokeWidth={OUTLINE_LINE_WIDTH}
            />
        </>
    )
}

// Part guidance sits on a photograph, not on the app surface, so it keeps one daylight pairing in both schemes: a
// white halo (the light inkInverse token) under a dark line. The dark scheme's inkInverse would be dark on a photo.
export const PART_DASH: readonly number[] = [6, 4]
const ARROW_HALO_WIDTH = 6
const ARROW_LINE_WIDTH = 3
// A very short arrow keeps at least this share of its stroke widths so it stays a line, not a dot.
const ARROW_MIN_STROKE_SCALE = 1 / 3
const ARROW_HEAD_LENGTH = 12
const ARROW_HEAD_HALF_WIDTH = 6
// An arrow this long or longer is drawn at full size; a shorter gap scales the head down so shaft and head fit it.
const ARROW_FULL_SIZE_LENGTH = 20

type PartRegionOverlaysProps = {
    // Each rect is a returned region already placed on the displayed photo. Absent means nothing is drawn for it.
    readonly next: DisplayRect | null
    readonly target: DisplayRect | null
    // True only when the response located the same step part twice. Without it no arrow exists, whatever the rects.
    readonly arrow: boolean
}

/**
 * Where the next part is (dashed), where it should go (solid) and, only when both are real and paired, one arrow from
 * the first to the second. Static by design: no animation, so Reduce Motion needs no special case here.
 */
export function PartRegionOverlays({ next, target, arrow }: PartRegionOverlaysProps): ReactElement {
    const geometry = (rect: DisplayRect): RectProps => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rx: radius.sm,
        fill: 'none',
    })
    const segment = arrow && next !== null && target !== null ? arrowSegment(next, target) : null
    return (
        <>
            {next === null ? null : (
                <>
                    <Rect
                        testID="part-next-halo"
                        {...geometry(next)}
                        stroke={lightColors.inkInverse}
                        strokeWidth={OUTLINE_HALO_WIDTH}
                    />
                    <Rect
                        testID="part-next-line"
                        {...geometry(next)}
                        stroke={lightColors.accent}
                        strokeWidth={OUTLINE_LINE_WIDTH}
                        strokeDasharray={PART_DASH}
                    />
                </>
            )}
            {target === null ? null : (
                <>
                    <Rect
                        testID="part-target-halo"
                        {...geometry(target)}
                        stroke={lightColors.inkInverse}
                        strokeWidth={OUTLINE_HALO_WIDTH}
                    />
                    <Rect
                        testID="part-target-line"
                        {...geometry(target)}
                        stroke={lightColors.pass}
                        strokeWidth={OUTLINE_LINE_WIDTH}
                    />
                </>
            )}
            {segment === null ? null : <PartArrow {...segment} />}
        </>
    )
}

function PartArrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }): ReactElement {
    const length = Math.hypot(x2 - x1, y2 - y1)
    const ux = (x2 - x1) / length
    const uy = (y2 - y1) / length
    const scale = Math.min(1, length / ARROW_FULL_SIZE_LENGTH)
    const strokeScale = Math.max(scale, ARROW_MIN_STROKE_SCALE)
    const haloWidth = ARROW_HALO_WIDTH * strokeScale
    const lineWidth = ARROW_LINE_WIDTH * strokeScale
    const headLength = ARROW_HEAD_LENGTH * scale
    const halfWidth = ARROW_HEAD_HALF_WIDTH * scale
    const baseX = x2 - ux * headLength
    const baseY = y2 - uy * headLength
    const points = [
        `${x2},${y2}`,
        `${baseX - uy * halfWidth},${baseY + ux * halfWidth}`,
        `${baseX + uy * halfWidth},${baseY - ux * halfWidth}`,
    ].join(' ')
    const shaft = { x1, y1, x2: baseX, y2: baseY, strokeLinecap: 'round' as const }
    return (
        <>
            <Line testID="part-arrow-halo" {...shaft} stroke={lightColors.inkInverse} strokeWidth={haloWidth} />
            <Polygon
                points={points}
                fill={lightColors.inkInverse}
                stroke={lightColors.inkInverse}
                strokeWidth={haloWidth - lineWidth}
                strokeLinejoin="round"
            />
            <Line testID="part-arrow-line" {...shaft} stroke={lightColors.ink} strokeWidth={lineWidth} />
            <Polygon
                testID="part-arrow-head"
                points={points}
                fill={lightColors.ink}
                stroke={lightColors.ink}
                strokeWidth={Math.min(1, strokeScale)}
                strokeLinejoin="round"
            />
        </>
    )
}
