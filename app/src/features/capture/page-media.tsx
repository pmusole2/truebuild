import type { ReactElement } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Stack } from '../../ui/surface'
import { Caption } from '../../ui/text'
import { Skeleton } from '../../ui/skeleton'
import { radius } from '../../theme/tokens'

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
            <Image source={{ uri }} accessibilityLabel={label} resizeMode="stretch" style={StyleSheet.absoluteFill} />
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
