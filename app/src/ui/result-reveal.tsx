import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import Animated, {
    cancelAnimation,
    Easing,
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated'
import { motion, space } from '../theme/tokens'
import { useFeedback, type HapticKind } from './feedback'

/** A brief entrance and one best-effort notification for a new result. Metadata and preference changes stay quiet. */
export function ResultReveal({
    identity,
    feedback,
    children,
}: {
    readonly identity: string
    readonly feedback: HapticKind
    readonly children: ReactNode
}): ReactElement {
    const { reduceMotion, haptic } = useFeedback()
    const seen = useRef<string | null>(null)
    const progress = useSharedValue(1)
    useEffect(() => {
        if (seen.current === identity) return
        seen.current = identity
        haptic(feedback)
    }, [identity, feedback, haptic])
    // Animation setup also runs after effect replay or visibility changes; notification identity stays separate.
    useEffect(() => {
        cancelAnimation(progress)
        progress.value = reduceMotion ? 1 : 0
        if (!reduceMotion) {
            progress.value = withTiming(1, { duration: motion.quick, easing: Easing.out(Easing.cubic) })
        }
        return (): void => cancelAnimation(progress)
    }, [identity, reduceMotion, progress])
    const entrance = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: interpolate(progress.value, [0, 1], [space.xxs, 0]) }],
    }))
    return <Animated.View style={entrance}>{children}</Animated.View>
}
