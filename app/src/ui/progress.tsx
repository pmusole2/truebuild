import type { ReactElement } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { typeProps } from '../theme/typography'
import { radius, space, touchTarget } from '../theme/tokens'
import { Icon, type IconName } from './icons'

export function ProgressBar({
    label,
    value,
    total,
}: {
    readonly label: string
    readonly value: number
    readonly total: number
}): ReactElement {
    const { colors } = useTheme()
    const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 1
    const safeValue = Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), safeTotal) : 0
    const fraction = safeValue / safeTotal
    return (
        <View
            accessible={true}
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            accessibilityValue={{ min: 0, max: safeTotal, now: safeValue, text: `${safeValue} of ${safeTotal}` }}
            style={[styles.track, { backgroundColor: colors.surfaceSunken, borderColor: colors.border }]}
        >
            <View style={[styles.fill, { width: `${fraction * 100}%`, backgroundColor: colors.accent }]} />
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
                        <View style={[styles.marker, { borderColor: colors.borderStrong }]}>
                            {presentation.icon === null ? (
                                <Text style={[type.style, { color: colors.ink }]}>{index + 1}</Text>
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
        minHeight: touchTarget,
        borderRadius: radius.sm,
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
