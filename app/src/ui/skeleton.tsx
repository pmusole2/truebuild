import { useEffect, useRef, type ReactElement } from 'react'
import { Animated, Easing, Platform, StyleSheet, View, type DimensionValue } from 'react-native'
import { useTheme } from '../theme/theme'
import { motion, radius, space } from '../theme/tokens'
import { useFeedback } from './feedback'

// A placeholder block that pulses while content loads. Under reduced motion it stays still at full strength.
export function Skeleton({
    width = '100%',
    height = space.md,
}: {
    readonly width?: DimensionValue
    readonly height?: number
}): ReactElement {
    const { colors } = useTheme()
    const { reduceMotion } = useFeedback()
    const opacity = useRef(new Animated.Value(1)).current
    useEffect(() => {
        if (reduceMotion) {
            opacity.setValue(1)
            return undefined
        }
        const half = motion.pulse / 2
        const pulse = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, {
                    toValue: 0.45,
                    duration: half,
                    easing: Easing.inOut(Easing.ease),
                    useNativeDriver: Platform.OS !== 'web',
                }),
                Animated.timing(opacity, {
                    toValue: 1,
                    duration: half,
                    easing: Easing.inOut(Easing.ease),
                    useNativeDriver: Platform.OS !== 'web',
                }),
            ]),
        )
        pulse.start()
        return (): void => {
            pulse.stop()
        }
    }, [opacity, reduceMotion])
    return (
        <Animated.View
            accessibilityElementsHidden={true}
            importantForAccessibility="no"
            style={[styles.block, { width, height, backgroundColor: colors.surfaceSunken, opacity }]}
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

const styles = StyleSheet.create({
    block: {
        borderRadius: radius.sm,
    },
    lines: {
        gap: space.xs,
    },
})
