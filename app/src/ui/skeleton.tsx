import type { ReactElement } from 'react'
import { StyleSheet, View, type DimensionValue } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space, touchTarget } from '../theme/tokens'

// A static placeholder block. Skeletons never animate: the only looping motion in the app is the Reading indicator.
export function Skeleton({
    width = '100%',
    height = space.md,
    nativeID,
}: {
    readonly width?: DimensionValue
    readonly height?: number
    readonly nativeID?: string
}): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            nativeID={nativeID}
            testID="skeleton-block"
            accessibilityElementsHidden={true}
            importantForAccessibility="no"
            style={[styles.block, { width, height, backgroundColor: colors.surfaceSunken }]}
        />
    )
}

/** Placeholder lines that stand in for a paragraph. The owning state announces "loading" once, not per line. */
export function SkeletonLines({
    lines = 3,
    nativeID,
}: {
    readonly lines?: number
    readonly nativeID?: string
}): ReactElement {
    const widths: readonly DimensionValue[] = ['100%', '86%', '60%']
    return (
        <View nativeID={nativeID} style={styles.lines}>
            {Array.from({ length: lines }, (_, index) => (
                <Skeleton key={index} width={widths[index % widths.length] ?? '100%'} />
            ))}
        </View>
    )
}

/** Placeholder silhouette of a result card: a title line, a short paragraph and an action bar. */
export function SkeletonCard({ nativeID }: { readonly nativeID?: string } = {}): ReactElement {
    return (
        <View nativeID={nativeID} style={styles.card}>
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
