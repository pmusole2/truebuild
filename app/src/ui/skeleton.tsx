import type { ReactElement } from 'react'
import { StyleSheet, View, type DimensionValue } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space, touchTarget } from '../theme/tokens'

// A static placeholder block. Skeletons never animate: the only looping motion in the app is the Reading indicator.
export function Skeleton({
    width = '100%',
    height = space.md,
}: {
    readonly width?: DimensionValue
    readonly height?: number
}): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            testID="skeleton-block"
            accessibilityElementsHidden={true}
            importantForAccessibility="no"
            style={[styles.block, { width, height, backgroundColor: colors.surfaceSunken }]}
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
