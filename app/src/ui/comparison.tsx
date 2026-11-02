import { Fragment, useState, type ReactElement, type ReactNode } from 'react'
import type { NormalizedBox } from '@truebuild/contracts'
import type { GestureResponderEvent } from 'react-native'
import { Pressable, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native'
import Svg from 'react-native-svg'
import {
    containRect,
    normalizedPointFromTap,
    type Point,
    type Rect,
    type Size,
} from '../features/assembly/frame-geometry'
import { extractTapCoordinates } from '../features/assembly/frozen-photo'
import { useTheme } from '../theme/theme'
import { radius, space } from '../theme/tokens'
import { regionOnFrame } from './comparison-geometry'
import { AppButton } from './button'
import { PaneNotes, type PaneNote } from './pane-notes'
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
    // Optional point selection on the photo, mapped with the same containRect geometry as the highlights.
    readonly onTapPoint?: (point: Point) => void
    // Optional SVG drawn over the media, given the contained image rect in frame coordinates (the same rect the
    // highlights are placed on). It sits inside the frame, so no border or padding geometry changes.
    readonly overlay?: (displayed: Rect) => ReactNode
    // Plain-text names for anything drawn by the overlay, shown beneath the pane.
    readonly notes?: readonly PaneNote[]
}

export type ComparisonLayout = 'auto' | 'row' | 'column'
export type ComparisonFit = 'frame' | 'media' | 'page'

export const COMPARISON_FRAME_HEIGHT = 220
const GAP = space.sm
const HALO_OUTSET = 2
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
    onViewDiagram,
}: {
    readonly diagram: ComparisonPane
    readonly photo: ComparisonPane
    readonly layout?: ComparisonLayout
    // Where a half-width diagram is too small to read, this opens it full width. Offered only while side by side.
    readonly onViewDiagram?: () => void
}): ReactElement {
    const [width, setWidth] = useState<number | null>(null)
    const { fontScale } = useWindowDimensions()
    const sideBySide =
        layout === 'row' ||
        (layout === 'auto' && width !== null && width >= SIDE_BY_SIDE_MIN_WIDTH && fontScale < LARGE_TEXT_SCALE)
    const onLayout = (event: LayoutChangeEvent): void => {
        setWidth(event.nativeEvent.layout.width)
    }
    // Beside each other, a pane is about 171 points wide, too narrow for the guidance lines. They are then drawn once,
    // full width, beneath the pair; stacked, they stay under their own pane.
    const hoistNotes = sideBySide && photo.notes !== undefined && photo.notes.length > 0
    const stack = (
        <View testID="comparison-stack" onLayout={onLayout} style={[styles.stack, sideBySide && styles.stackRow]}>
            <MeasuredPane pane={diagram} testID="diagram" sideBySide={sideBySide} />
            <MeasuredPane
                pane={hoistNotes ? { ...photo, notes: undefined } : photo}
                testID="photo"
                sideBySide={sideBySide}
            />
        </View>
    )
    if (onViewDiagram === undefined && photo.notes === undefined) {
        return stack
    }
    return (
        <View style={styles.stack}>
            {stack}
            {hoistNotes ? <PaneNotes notes={photo.notes} /> : null}
            {sideBySide && onViewDiagram !== undefined ? <ViewDiagramAction onPress={onViewDiagram} /> : null}
        </View>
    )
}

export const VIEW_DIAGRAM_LABEL = 'View diagram full width'

/** The 44 point action under a half-width diagram. The photo's own tap is untouched; this only opens the diagram. */
export function ViewDiagramAction({ onPress }: { readonly onPress: () => void }): ReactElement {
    return <AppButton label={VIEW_DIAGRAM_LABEL} icon="image" variant="quiet" onPress={onPress} />
}

/** Compact media is capped; a full-width page keeps its proportions inside the sheet's existing scroll. */
export function frameHeightFor(fit: ComparisonFit, width: number, media: Size): number {
    if (fit === 'frame' || !(width > 0) || !(media.width > 0) || !(media.height > 0)) {
        return COMPARISON_FRAME_HEIGHT
    }
    const height = (width * media.height) / media.width
    return fit === 'page' ? height : Math.min(height, COMPARISON_FRAME_HEIGHT)
}

/** One measured image pane: caption, a 220 point frame, the media contained inside it, and normalized highlights. */
export function MeasuredPane({
    pane,
    testID,
    sideBySide,
    fit = 'frame',
}: {
    readonly pane: ComparisonPane
    readonly testID: string
    readonly sideBySide: boolean
    // 'frame' (default) keeps the fixed 220 point frame, with the image contained and letterboxed inside it. 'media'
    // shrinks the frame to the image's own proportions, up to that same 220 points, so a narrow pane wastes no height.
    readonly fit?: ComparisonFit
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
        const height = frameHeightFor(fit, width, pane.mediaSize)
        setFrame((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }))
    }
    return (
        <View style={[styles.pane, sideBySide && styles.paneRow]} testID={testID}>
            <Caption>{pane.caption}</Caption>
            <View style={[styles.border, { borderColor: colors.borderStrong }]}>
                <View
                    testID={`${testID}-frame`}
                    onLayout={onFrameLayout}
                    style={[
                        styles.frame,
                        { backgroundColor: colors.surfaceSunken },
                        frame !== null && frame.height !== COMPARISON_FRAME_HEIGHT && { height: frame.height },
                    ]}
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
                        <Fragment key={region.id}>
                            <View
                                testID={`${testID}-region-halo-${region.id}`}
                                accessibilityElementsHidden={true}
                                importantForAccessibility="no"
                                style={[
                                    styles.region,
                                    styles.halo,
                                    {
                                        left: rect.x - HALO_OUTSET,
                                        top: rect.y - HALO_OUTSET,
                                        width: rect.width + HALO_OUTSET * 2,
                                        height: rect.height + HALO_OUTSET * 2,
                                        borderColor: colors.inkInverse,
                                    },
                                ]}
                            />
                            <View
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
                        </Fragment>
                    ))}
                    {pane.overlay === undefined ||
                    frame === null ||
                    mediaRect === null ||
                    mediaRect.width <= 0 ? null : (
                        // The hiding props sit on a View, which every platform understands. On web the Svg is a DOM
                        // element and would reject the native-only props as unknown attributes.
                        <View
                            testID={`${testID}-overlay`}
                            style={styles.overlay}
                            pointerEvents="none"
                            accessibilityElementsHidden={true}
                            importantForAccessibility="no-hide-descendants"
                        >
                            <Svg
                                testID={`${testID}-overlay-svg`}
                                width={frame.width}
                                height={frame.height}
                                pointerEvents="none"
                            >
                                {pane.overlay(mediaRect)}
                            </Svg>
                        </View>
                    )}
                    {pane.onTapPoint === undefined ? null : (
                        <Pressable
                            testID={`${testID}-tap`}
                            accessibilityRole="button"
                            accessibilityLabel={`${pane.caption}: tap a point to ask about it`}
                            onPress={(event: GestureResponderEvent): void => {
                                const tap = extractTapCoordinates(event)
                                if (pane.onTapPoint === undefined || frame === null || tap === null) {
                                    return
                                }
                                const point = normalizedPointFromTap(tap, frame, pane.mediaSize)
                                if (point !== null) {
                                    pane.onTapPoint(point)
                                }
                            }}
                            style={StyleSheet.absoluteFill}
                        />
                    )}
                </View>
            </View>
            {highlights.length === 0 ? null : (
                // The outline is also named in text, so the highlight never depends on colour or shape alone.
                <Caption>{`Highlighted: ${highlights.map(({ region }) => region.label).join(', ')}`}</Caption>
            )}
            <PaneNotes notes={pane.notes} />
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
    overlay: {
        position: 'absolute',
        left: 0,
        top: 0,
    },
    region: {
        position: 'absolute',
        borderWidth: 3,
        borderRadius: radius.sm,
    },
    // Seven points wide and two points proud of the accent line, so a light edge shows on both of its sides.
    halo: { borderWidth: 7 },
})
