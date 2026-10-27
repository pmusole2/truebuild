import { useState, type ReactElement, type ReactNode } from 'react'
import type { NormalizedBox } from '@truebuild/contracts'
import { StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native'
import { containRect, type Size } from '../features/assembly/frame-geometry'
import { useTheme } from '../theme/theme'
import { radius, space } from '../theme/tokens'
import { regionOnFrame } from './comparison-geometry'
import { Caption } from './text'

export type ComparisonRegion = {
    readonly id: string
    readonly label: string
    readonly box: NormalizedBox
}

export type ComparisonPane = {
    readonly caption: string
    // Sized to the contained image rect, so it should fill its box (for example with resizeMode "stretch").
    readonly media: ReactNode
    // Intrinsic size of the image in its own pixels. Portrait and landscape both fit the same frame.
    readonly mediaSize: Size
    readonly regions?: readonly ComparisonRegion[]
}

export type ComparisonLayout = 'auto' | 'row' | 'column'

export const COMPARISON_FRAME_HEIGHT = 220
const GAP = space.sm
const MIN_PANE_WIDTH = 150
// Side-by-side needs two usable panes at phone width. Large system text stacks instead, so no pane gets squeezed.
export const SIDE_BY_SIDE_MIN_WIDTH = MIN_PANE_WIDTH * 2 + GAP
export const LARGE_TEXT_SCALE = 1.5

/**
 * Manual diagram and photo for one step. 'auto' places them side by side when two panes fit the phone width at normal
 * text size, and stacks them otherwise. Highlights are drawn only after each frame has been measured.
 */
export function ComparisonFrame({
    diagram,
    photo,
    layout = 'auto',
}: {
    readonly diagram: ComparisonPane
    readonly photo: ComparisonPane
    readonly layout?: ComparisonLayout
}): ReactElement {
    const [width, setWidth] = useState<number | null>(null)
    const { fontScale } = useWindowDimensions()
    const sideBySide =
        layout === 'row' ||
        (layout === 'auto' && width !== null && width >= SIDE_BY_SIDE_MIN_WIDTH && fontScale < LARGE_TEXT_SCALE)
    const onLayout = (event: LayoutChangeEvent): void => {
        setWidth(event.nativeEvent.layout.width)
    }
    return (
        <View testID="comparison-stack" onLayout={onLayout} style={[styles.stack, sideBySide && styles.stackRow]}>
            <MeasuredPane pane={diagram} testID="diagram" sideBySide={sideBySide} />
            <MeasuredPane pane={photo} testID="photo" sideBySide={sideBySide} />
        </View>
    )
}

/** One measured image pane: caption, a 220 point frame, the media contained inside it, and normalized highlights. */
export function MeasuredPane({
    pane,
    testID,
    sideBySide,
}: {
    readonly pane: ComparisonPane
    readonly testID: string
    readonly sideBySide: boolean
}): ReactElement {
    const { colors } = useTheme()
    const [frame, setFrame] = useState<Size | null>(null)
    const regions = pane.regions ?? []
    const mediaRect = frame === null ? null : containRect(frame, pane.mediaSize)
    const highlights =
        frame === null
            ? []
            : regions.flatMap((region) => {
                  const rect = regionOnFrame(region.box, frame, pane.mediaSize)
                  return rect === null ? [] : [{ region, rect }]
              })
    const onFrameLayout = (event: LayoutChangeEvent): void => {
        const { width } = event.nativeEvent.layout
        setFrame({ width, height: COMPARISON_FRAME_HEIGHT })
    }
    return (
        <View style={[styles.pane, sideBySide && styles.paneRow]} testID={testID}>
            <Caption>{pane.caption}</Caption>
            <View style={[styles.border, { borderColor: colors.borderStrong }]}>
                <View
                    testID={`${testID}-frame`}
                    onLayout={onFrameLayout}
                    style={[styles.frame, { backgroundColor: colors.surfaceSunken }]}
                >
                    {mediaRect === null ? null : (
                        <View
                            testID={`${testID}-media`}
                            style={[
                                styles.media,
                                {
                                    left: mediaRect.x,
                                    top: mediaRect.y,
                                    width: mediaRect.width,
                                    height: mediaRect.height,
                                },
                            ]}
                        >
                            {pane.media}
                        </View>
                    )}
                    {highlights.map(({ region, rect }) => (
                        <View
                            key={region.id}
                            testID={`${testID}-region-${region.id}`}
                            accessibilityElementsHidden={true}
                            importantForAccessibility="no"
                            style={[
                                styles.region,
                                {
                                    left: rect.x,
                                    top: rect.y,
                                    width: rect.width,
                                    height: rect.height,
                                    borderColor: colors.accent,
                                },
                            ]}
                        />
                    ))}
                </View>
            </View>
            {highlights.length === 0 ? null : (
                // The outline is also named in text, so the highlight never depends on colour or shape alone.
                <Caption>{`Highlighted: ${highlights.map(({ region }) => region.label).join(', ')}`}</Caption>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    stack: {
        gap: space.md,
    },
    stackRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: GAP,
    },
    pane: {
        gap: space.xs,
    },
    paneRow: {
        flex: 1,
        minWidth: MIN_PANE_WIDTH,
    },
    border: {
        borderWidth: 1,
        borderRadius: radius.md,
        overflow: 'hidden',
    },
    frame: {
        width: '100%',
        height: COMPARISON_FRAME_HEIGHT,
        overflow: 'hidden',
    },
    media: {
        position: 'absolute',
    },
    region: {
        position: 'absolute',
        borderWidth: 3,
        borderRadius: radius.sm,
    },
})
