import type { ReactElement, ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space } from '../theme/tokens'
import { percentBox, type NormalizedBox } from './comparison-geometry'
import { Caption } from './text'

export type ComparisonRegion = {
    readonly id: string
    readonly label: string
    readonly box: NormalizedBox
}

// Photo and manual diagram stack on a phone so each keeps a usable size. The 4:3 frame is shared by both panes.
const FRAME_ASPECT = 4 / 3

function Pane({
    caption,
    regions,
    children,
}: {
    readonly caption: string
    readonly regions: readonly ComparisonRegion[]
    readonly children: ReactNode
}): ReactElement {
    const { colors } = useTheme()
    const highlighted = regions.filter((region) => percentBox(region.box) !== null)
    return (
        <View style={styles.pane}>
            <Caption>{caption}</Caption>
            <View style={[styles.frame, { backgroundColor: colors.surfaceSunken, borderColor: colors.borderStrong }]}>
                {children}
                {highlighted.map((region) => {
                    const box = percentBox(region.box)
                    return box === null ? null : (
                        <View
                            key={region.id}
                            accessibilityElementsHidden={true}
                            importantForAccessibility="no"
                            style={[styles.region, box, { borderColor: colors.accent }]}
                        />
                    )
                })}
            </View>
            {highlighted.length === 0 ? null : (
                // The outline is also named in text, so the highlight never depends on colour or shape alone.
                <Caption>Highlighted: {highlighted.map((region) => region.label).join(', ')}</Caption>
            )}
        </View>
    )
}

export function ComparisonFrame({
    diagram,
    photo,
    diagramRegions = [],
    photoRegions = [],
}: {
    readonly diagram: ReactNode
    readonly photo: ReactNode
    readonly diagramRegions?: readonly ComparisonRegion[]
    readonly photoRegions?: readonly ComparisonRegion[]
}): ReactElement {
    return (
        <View style={styles.stack}>
            <Pane caption="Manual diagram" regions={diagramRegions}>
                {diagram}
            </Pane>
            <Pane caption="Your photo" regions={photoRegions}>
                {photo}
            </Pane>
        </View>
    )
}

const styles = StyleSheet.create({
    stack: {
        gap: space.md,
    },
    pane: {
        gap: space.xs,
    },
    frame: {
        width: '100%',
        aspectRatio: FRAME_ASPECT,
        borderWidth: 1,
        borderRadius: radius.md,
        overflow: 'hidden',
    },
    region: {
        position: 'absolute',
        borderWidth: 3,
        borderRadius: radius.sm,
    },
})
