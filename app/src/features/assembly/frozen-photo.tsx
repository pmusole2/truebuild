import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import {
    Image,
    Pressable,
    StyleSheet,
    Text,
    View,
    type GestureResponderEvent,
    type LayoutChangeEvent,
} from 'react-native'
import Svg from 'react-native-svg'
import { palette, radius, space } from '../../components/theme'
import { bytesToDataUri } from '../manuals/image-source'
import { containRect, normalizedPointFromTap, type Point, type Rect } from './frame-geometry'
import type { Observation } from './observation'

export const MAX_PHOTO_HEIGHT = 360

export type TapCoordinates = { readonly x: number; readonly y: number }

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function fieldOf(source: unknown, key: string): unknown {
    if (typeof source !== 'object' || source === null) {
        return undefined
    }
    const value: unknown = Reflect.get(source, key)
    return value
}

/** Element bounds from a DOM-shaped target. Any missing or non-finite edge means the bounds are unknown. */
function boundsOf(target: unknown): { readonly left: number; readonly top: number } | null {
    const getRect = fieldOf(target, 'getBoundingClientRect')
    if (typeof getRect !== 'function') {
        return null
    }
    const rect: unknown = getRect.call(target)
    const left = finiteNumber(fieldOf(rect, 'left'))
    const top = finiteNumber(fieldOf(rect, 'top'))
    return left === null || top === null ? null : { left, top }
}

/**
 * Tap position inside the photo's own box, in pixels. Native gives element-relative `locationX/Y`, used only as a
 * complete finite pair. Web gives viewport-relative `clientX/Y`, converted with the element's bounding rect, again only
 * as a complete finite pair. Mixing one platform's axis with the other's is never done. Missing or non-finite values
 * return null: no centre or other position is invented.
 */
export function extractTapCoordinates(event: unknown): TapCoordinates | null {
    const nativeEvent = fieldOf(event, 'nativeEvent')

    const locationX = finiteNumber(fieldOf(nativeEvent, 'locationX'))
    const locationY = finiteNumber(fieldOf(nativeEvent, 'locationY'))
    if (locationX !== null && locationY !== null) {
        return { x: locationX, y: locationY }
    }

    const clientX = finiteNumber(fieldOf(nativeEvent, 'clientX'))
    const clientY = finiteNumber(fieldOf(nativeEvent, 'clientY'))
    if (clientX === null || clientY === null) {
        return null
    }
    const bounds = boundsOf(fieldOf(event, 'currentTarget'))
    if (bounds === null) {
        return null
    }
    return { x: clientX - bounds.left, y: clientY - bounds.top }
}

type FrozenPhotoProps = {
    readonly observation: Observation
    readonly caption: string
    // When present, taps on the photo (not on letterbox bands) report a normalized point to pick a question target.
    readonly onTapPoint?: (point: Point) => void
    // Overlays are drawn on the displayed photo rect, so normalized boxes always land on the visible image.
    readonly overlay?: (displayed: Rect) => ReactNode
}

/** The one frozen photo of this capture. Nothing here is live; the image does not update after it is taken. */
export function FrozenPhoto({ observation, caption, onTapPoint, overlay }: FrozenPhotoProps): ReactElement {
    const [width, setWidth] = useState(0)
    const dataUri = useMemo(() => bytesToDataUri(observation.bytes, observation.mimeType), [observation])
    const imageSize = { width: observation.width, height: observation.height }
    const boxHeight = width === 0 ? 0 : Math.min((width * imageSize.height) / imageSize.width, MAX_PHOTO_HEIGHT)
    const box = { width, height: boxHeight }
    const displayed = containRect(box, imageSize)

    function onLayout(event: LayoutChangeEvent): void {
        setWidth(event.nativeEvent.layout.width)
    }

    function onPress(event: GestureResponderEvent): void {
        const coords = extractTapCoordinates(event)
        if (coords === null) {
            return
        }

        const point = normalizedPointFromTap(coords, box, imageSize)
        if (point !== null) {
            onTapPoint?.(point)
        }
    }

    const photo = (
        <Image
            accessibilityIgnoresInvertColors
            source={{ uri: dataUri }}
            resizeMode="contain"
            style={[styles.image, { width: box.width, height: box.height }]}
        />
    )

    return (
        <View style={styles.wrap}>
            <View onLayout={onLayout} style={[styles.frame, { height: boxHeight }]}>
                {width === 0 ? null : (
                    <>
                        {onTapPoint === undefined ? (
                            photo
                        ) : (
                            <Pressable
                                accessibilityRole="imagebutton"
                                accessibilityLabel="Frozen photo of your assembly. Tap a spot to ask about it."
                                onPress={(event) => onPress(event)}
                            >
                                {photo}
                            </Pressable>
                        )}
                        {overlay === undefined || boxHeight === 0 ? null : (
                            <Svg width={box.width} height={box.height} style={styles.overlay} pointerEvents="none">
                                {overlay(displayed)}
                            </Svg>
                        )}
                    </>
                )}
            </View>
            <Text style={styles.caption}>{caption}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    wrap: {
        gap: space.xs,
    },
    frame: {
        width: '100%',
        position: 'relative',
        backgroundColor: palette.paperDeep,
        borderRadius: radius,
        overflow: 'hidden',
    },
    image: {
        alignSelf: 'center',
    },
    overlay: {
        position: 'absolute',
        left: 0,
        top: 0,
    },
    caption: {
        color: palette.graphite,
        fontSize: 13,
    },
})
