import { useEffect, type ReactElement } from 'react'
import { StyleSheet, View, type DimensionValue } from 'react-native'
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated'
import { useTheme } from '../theme/theme'
import { motion, radius, space, touchTarget } from '../theme/tokens'
import { useFeedback } from './feedback'

// A placeholder block that pulses while content loads. Under reduced motion it stays still at full strength. The loop
// is cancelled on unmount, so no animation outlives the content it stood in for.
export function Skeleton({
    width = '100%',
    height = space.md,
}: {
    readonly width?: DimensionValue
    readonly height?: number
}): ReactElement {
    const { colors } = useTheme()
    const { reduceMotion } = useFeedback()
    const opacity = useSharedValue(1)
    useEffect(() => {
        if (reduceMotion) {
            cancelAnimation(opacity)
            opacity.value = 1
            return undefined
        }
        const half = motion.pulse / 2
        const ease = Easing.inOut(Easing.ease)
        opacity.value = withRepeat(
            withSequence(
                withTiming(0.45, { duration: half, easing: ease }),
                withTiming(1, { duration: half, easing: ease }),
            ),
            -1,
            false,
        )
        return (): void => {
            cancelAnimation(opacity)
        }
    }, [opacity, reduceMotion])
    const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }))
    return (
        <Animated.View
            testID="skeleton-block"
            accessibilityElementsHidden={true}
            importantForAccessibility="no"
            style={[styles.block, { width, height, backgroundColor: colors.surfaceSunken }, pulse]}
        />
    )
}

/** Placeholder lines that stand in for a paragraph. The owning state announces "loading" once, not per line. */
export function SkeletonLines({ lines = 3 }: { readonly lines?: number }): ReactElement {
    const widths: readonly DimensionValue[] = ['100%', '86%', '60%']
    return (
        <View style={styles.lines}>
            {Array.from({ length: lines }, (_, index) => (
                <Skeleton key={index} width={widths[index % widths.length] ?? '100%'} />
            ))}
        </View>
    )
}

/** Placeholder silhouette of a result card: a title line, a short paragraph and an action bar. */
export function SkeletonCard(): ReactElement {
    return (
        <View style={styles.card}>
            <Skeleton width="55%" height={space.lg} />
            <SkeletonLines />
            <Skeleton width="40%" height={touchTarget} />
        </View>
    )
}

const styles = StyleSheet.create({
    card: {
        gap: space.sm,
    },
    block: {
        borderRadius: radius.sm,
    },
    lines: {
        gap: space.xs,
    },
})
