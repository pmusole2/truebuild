import { useEffect, useRef, type ReactElement } from 'react'
import Animated, {
    cancelAnimation,
    Easing,
    interpolate,
    useAnimatedProps,
    useSharedValue,
    withSequence,
    withTiming,
} from 'react-native-reanimated'
import { Rect, type RectProps } from 'react-native-svg'
import { useTheme } from '../../theme/theme'
import { motion, radius } from '../../theme/tokens'
import { useFeedback } from '../../ui/feedback'
import type { Rect as DisplayRect } from './frame-geometry'

// A light halo under the accent line keeps the region readable on bright, dark and busy photos alike.
export const OUTLINE_LINE_WIDTH = 4
export const OUTLINE_HALO_WIDTH = 8
const PULSE_EXTRA_WIDTH = 8
const PULSE_PEAK_OPACITY = 0.85

const AnimatedRect = Animated.createAnimatedComponent(Rect)

type GroundedRegionOutlineProps = {
    // The region exactly as returned, already placed on the displayed photo. Nothing is moved, grown or defaulted here.
    readonly rect: DisplayRect | null
    // Changes when a new result's region should pulse once. Absent or null draws the static outline only.
    readonly pulseKey?: string | null
}

/**
 * The grounded region on the frozen photo, drawn as SVG children (FrozenPhoto places its overlay inside an Svg).
 * The outline is always static. A pulse ring is added only for a pulse key, only while motion is allowed, once per
 * key: re-rendering the same result, a moved rect or a flipped preference never replays it. Reduced motion, and a
 * system preference that is still unknown, leave the static outline alone.
 */
export function GroundedRegionOutline({ rect, pulseKey = null }: GroundedRegionOutlineProps): ReactElement {
    const { colors } = useTheme()
    const { reduceMotion } = useFeedback()
    const pulsed = useRef<string | null>(null)
    const progress = useSharedValue(0)
    useEffect(() => {
        cancelAnimation(progress)
        progress.value = 0
        if (pulseKey !== null && !reduceMotion && pulsed.current !== pulseKey) {
            pulsed.current = pulseKey
            progress.value = withSequence(
                withTiming(1, { duration: motion.quick, easing: Easing.out(Easing.cubic) }),
                withTiming(0, { duration: motion.pulse, easing: Easing.out(Easing.cubic) }),
            )
        }
        return (): void => cancelAnimation(progress)
    }, [pulseKey, reduceMotion, progress])
    const ringProps = useAnimatedProps<RectProps>(() => ({
        strokeOpacity: interpolate(progress.value, [0, 1], [0, PULSE_PEAK_OPACITY]),
        strokeWidth: interpolate(progress.value, [0, 1], [OUTLINE_LINE_WIDTH, OUTLINE_LINE_WIDTH + PULSE_EXTRA_WIDTH]),
    }))
    // Keep this component mounted while an answer temporarily hides the check's region, preserving pulse history.
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
            {pulseKey === null || reduceMotion ? null : (
                <AnimatedRect
                    testID="grounded-outline-pulse"
                    {...geometry}
                    stroke={colors.pass}
                    animatedProps={ringProps}
                />
            )}
        </>
    )
}
