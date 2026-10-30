import type { ReactElement } from 'react'
import { Image, Platform, StyleSheet, View, type ImageStyle, type StyleProp } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { Stack } from '../../ui/surface'
import { Caption } from '../../ui/text'
import { Skeleton } from '../../ui/skeleton'
import { radius } from '../../theme/tokens'

const SVG_DATA_URI = /^data:image\/svg\+xml(?:;charset=utf-8)?,/iu
const MANUAL_PAGE_PIXELS = 'truebuild-capability-internals:ManualPage'

/** The XML of an inline SVG data URI, or null for any other source (stored pages are always PNG or JPEG bytes). */
export function inlineSvgXml(uri: string): string | null {
    if (!SVG_DATA_URI.test(uri)) {
        return null
    }
    try {
        return decodeURIComponent(uri.replace(SVG_DATA_URI, ''))
    } catch {
        return null
    }
}

/**
 * A manual image at the size its frame gives it. React Native's native Image cannot decode SVG, so a blank frame was
 * drawn for the synthetic fixture diagrams (SVG data URIs) on iOS and Android; the browser's Image renders them. Those
 * fixtures are drawn with react-native-svg instead. Real stored pages are raster photos and keep using Image.
 */
export function ManualImage({
    uri,
    label,
    style = StyleSheet.absoluteFill,
}: {
    uri: string
    label: string
    style?: StyleProp<ImageStyle>
}): ReactElement {
    const xml = Platform.OS === 'web' ? null : inlineSvgXml(uri)
    if (xml !== null) {
        return (
            <View accessible={true} accessibilityLabel={label} accessibilityRole="image" style={style}>
                <SvgXml nativeID={MANUAL_PAGE_PIXELS} xml={xml} width="100%" height="100%" preserveAspectRatio="none" />
            </View>
        )
    }
    // Only decoded manual pixels are intrinsic. The document's frame, controls and labels remain counted.
    return (
        <Image
            nativeID={MANUAL_PAGE_PIXELS}
            source={{ uri }}
            accessibilityLabel={label}
            resizeMode="stretch"
            style={style}
        />
    )
}

/** A local manual page at its own aspect ratio. Until the local file is read it shows a skeleton, not a blank box. */
export function PageImage({
    uri,
    label,
    aspectRatio,
}: {
    uri: string | undefined
    label: string
    aspectRatio: number
}): ReactElement {
    if (uri === undefined) {
        return (
            <Stack gap="xs">
                <Skeleton height={160} />
                <Caption>Loading local page…</Caption>
            </Stack>
        )
    }
    return (
        <View style={[styles.pageFrame, { aspectRatio }]}>
            <ManualImage uri={uri} label={label} />
        </View>
    )
}

const styles = StyleSheet.create({
    pageFrame: {
        width: '100%',
        borderRadius: radius.md,
        overflow: 'hidden',
    },
})
