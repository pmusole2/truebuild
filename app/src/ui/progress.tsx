import { useEffect, type ReactElement } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import { useTheme } from '../theme/theme'
import { typeProps } from '../theme/typography'
import { motion, radius, space, touchTarget } from '../theme/tokens'
import { useCoachAttention, useCoachScope } from '../features/onboarding/coach-provider'
import { useFeedback } from './feedback'
import { timing } from './motion'
import { Icon, type IconName } from './icons'
import { useOriginNativeId } from './render-origin'

// Whole steps only, clamped to the range. Every progress control reports this pair, never a raw or fractional value.
function progressValues(value: number, total: number): { safeValue: number; safeTotal: number; fraction: number } {
    const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 1
    const safeValue = Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), safeTotal) : 0
    return { safeValue, safeTotal, fraction: safeValue / safeTotal }
}

/**
 * The fill is the only part that moves: it eases to a new value on the UI thread and starts at its true value on
 * mount, so a bar never claims work that just happened. The accessible value is always the target, never an
 * intermediate. `slim` is a thin decorative cue that a screen's own text already explains.
 */
export function ProgressBar({
    label,
    value,
    total,
    slim = false,
    height,
    animate = true,
    nativeID,
}: {
    readonly label: string
    readonly value: number
    readonly total: number
    readonly slim?: boolean
    readonly height?: number
    readonly animate?: boolean
    readonly nativeID?: string
}): ReactElement {
    const inheritedId = useOriginNativeId(nativeID)
    const { colors } = useTheme()
    const { reduceMotion } = useFeedback()
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const mayAnimate = animate && scope.active && !attention
    const { safeValue, safeTotal, fraction } = progressValues(value, total)
    const fill = useSharedValue(fraction)
    useEffect(() => {
        if (fill.value === fraction) {
            // Already at the true value (first mount, or a re-render): nothing to animate.
            return undefined
        }
        cancelAnimation(fill)
        if (reduceMotion || !mayAnimate) {
            fill.value = fraction
        } else {
            fill.value = withTiming(fraction, timing(motion.standard))
        }
        return (): void => cancelAnimation(fill)
    }, [fill, fraction, reduceMotion, mayAnimate])
    const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }))
    return (
        <View
            nativeID={inheritedId}
            testID="progress-track"
            accessible={slim ? false : true}
            accessibilityElementsHidden={slim}
            importantForAccessibility={slim ? 'no-hide-descendants' : 'auto'}
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            accessibilityValue={{ min: 0, max: safeTotal, now: safeValue, text: `${safeValue} of ${safeTotal}` }}
            // At zero the track gets the stronger rule, so a step not started never looks like a missing bar.
            style={[
                styles.track,
                slim && styles.slim,
                height === undefined ? undefined : { height },
                {
                    backgroundColor: colors.surfaceSunken,
                    borderColor: safeValue === 0 ? colors.borderStrong : colors.border,
                },
            ]}
        >
            <Animated.View
                testID="progress-fill"
                style={[styles.fill, { backgroundColor: colors.accent }, fillStyle]}
            />
        </View>
    )
}

const RING_STROKE = 4
const RING_MIN = 36
const RING_MAX = 44

/**
 * A compact ring for a count of finished steps beside a title. The accessible value is the whole-step count, and the
 * ring is sized between 36 and 44 points so it always stays a readable target-sized mark.
 */
export function ProgressRing({
    label,
    value,
    total,
    size = 40,
}: {
    readonly label: string
    readonly value: number
    readonly total: number
    readonly size?: number
}): ReactElement {
    const { colors } = useTheme()
    const { safeValue, safeTotal, fraction } = progressValues(value, total)
    const diameter = Math.min(Math.max(Math.round(Number.isFinite(size) ? size : RING_MAX), RING_MIN), RING_MAX)
    const radius = (diameter - RING_STROKE) / 2
    const circumference = 2 * Math.PI * radius
    const center = diameter / 2
    return (
        <View
            accessible={true}
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            accessibilityValue={{ min: 0, max: safeTotal, now: safeValue, text: `${safeValue} of ${safeTotal}` }}
            style={{ width: diameter, height: diameter }}
        >
            <Svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`}>
                <Circle
                    cx={center}
                    cy={center}
                    r={radius}
                    stroke={colors.surfaceSunken}
                    strokeWidth={RING_STROKE}
                    fill="none"
                />
                <Circle
                    cx={center}
                    cy={center}
                    r={radius}
                    stroke={colors.accent}
                    strokeWidth={RING_STROKE}
                    strokeLinecap="round"
                    strokeDasharray={`${circumference} ${circumference}`}
                    strokeDashoffset={circumference * (1 - fraction)}
                    fill="none"
                    transform={`rotate(-90 ${center} ${center})`}
                />
            </Svg>
        </View>
    )
}

export type StepState = 'done' | 'current' | 'upcoming' | 'blocked'

const STEP: Readonly<Record<StepState, { word: string; icon: IconName | null }>> = {
    done: { word: 'Done', icon: 'check' },
    current: { word: 'Current', icon: null },
    upcoming: { word: 'Not started', icon: null },
    blocked: { word: 'Blocked', icon: 'alert' },
}

export type StepListItem = {
    readonly id: string
    readonly title: string
    readonly state: StepState
}

/** One row per step. The state word is part of the accessible label, so state is never conveyed by marker alone. */
export function StepList({ steps }: { readonly steps: readonly StepListItem[] }): ReactElement {
    const { colors } = useTheme()
    const type = typeProps('body')
    const { fontScale } = useWindowDimensions()
    const textScale = Math.max(fontScale, 1)
    const markerScale = type.maxFontSizeMultiplier === 0 ? textScale : Math.min(textScale, type.maxFontSizeMultiplier)
    const markerSize = 28 * markerScale
    return (
        <View style={styles.list}>
            {steps.map((step, index) => {
                const presentation = STEP[step.state]
                const current = step.state === 'current'
                return (
                    <View
                        key={step.id}
                        accessible={true}
                        accessibilityLabel={`Step ${index + 1}, ${presentation.word}: ${step.title}`}
                        accessibilityState={{ selected: current }}
                        style={[styles.row, current && { backgroundColor: colors.surfaceRaised }]}
                    >
                        <View
                            testID={`step-marker-${step.id}`}
                            style={[
                                styles.marker,
                                { borderColor: colors.borderStrong, width: markerSize, height: markerSize },
                            ]}
                        >
                            {presentation.icon === null ? (
                                <Text
                                    maxFontSizeMultiplier={type.maxFontSizeMultiplier}
                                    style={[type.style, { color: colors.ink }]}
                                >
                                    {index + 1}
                                </Text>
                            ) : (
                                <Icon name={presentation.icon} size="sm" color={colors.ink} />
                            )}
                        </View>
                        <Text
                            maxFontSizeMultiplier={type.maxFontSizeMultiplier}
                            style={[type.style, styles.title, { color: colors.ink }]}
                        >
                            {step.title}
                        </Text>
                    </View>
                )
            })}
        </View>
    )
}

const styles = StyleSheet.create({
    track: {
        height: space.xs,
        borderRadius: radius.pill,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
    },
    slim: { height: space.xxs },
    fill: {
        height: '100%',
        borderRadius: radius.pill,
    },
    list: {
        gap: space.xs,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingLeft: space.xs,
        minHeight: touchTarget,
        borderRadius: radius.sm,
        overflow: 'hidden',
    },
    marker: {
        width: 28,
        height: 28,
        borderWidth: 1,
        borderRadius: radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        flex: 1,
    },
})
