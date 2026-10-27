import type { ReactElement, ReactNode } from 'react'
import { Image, Pressable, StyleSheet, View, type ImageSourcePropType } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space, touchTarget } from '../theme/tokens'
import { focusRingStyle, useFocusRing } from './focus'
import { Icon } from './icons'
import { Body, Caption, Heading } from './text'

// Thumbnail of a manual page or assembly photo. With no image it shows a neutral placeholder rather than a blank tile.
export function ThumbnailCard({
    title,
    caption,
    image,
    status,
    selected = false,
    onPress,
    testID,
}: {
    readonly title: string
    readonly caption?: string
    readonly image?: ImageSourcePropType
    readonly status?: ReactNode
    readonly selected?: boolean
    readonly onPress: () => void
    readonly testID?: string
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={caption === undefined ? title : `${title}, ${caption}`}
            accessibilityState={{ selected }}
            {...focus.focusHandlers}
            onPress={onPress}
            testID={testID}
            style={({ pressed }) => [
                focusRingStyle(focus.focused, colors),
                styles.card,
                { backgroundColor: colors.surface, borderColor: selected ? colors.focus : colors.border },
                pressed && styles.pressed,
            ]}
        >
            <View style={[styles.thumb, { backgroundColor: colors.surfaceSunken }]}>
                {image === undefined ? (
                    <Icon name="image" color={colors.inkMuted} />
                ) : (
                    <Image
                        accessibilityIgnoresInvertColors={true}
                        source={image}
                        style={styles.image}
                        resizeMode="cover"
                    />
                )}
            </View>
            <View style={styles.text}>
                <Body>{title}</Body>
                {caption === undefined ? null : <Caption>{caption}</Caption>}
                {status}
            </View>
        </Pressable>
    )
}

// A manual in the library-style list: its title, a short summary and its state, all readable without the thumbnail.
export function ManualCard({
    title,
    summary,
    status,
    selected = false,
    onPress,
}: {
    readonly title: string
    readonly summary: string
    readonly status?: ReactNode
    readonly selected?: boolean
    readonly onPress: () => void
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${summary}`}
            accessibilityState={{ selected }}
            {...focus.focusHandlers}
            onPress={onPress}
            style={({ pressed }) => [
                focusRingStyle(focus.focused, colors),
                styles.manual,
                { backgroundColor: colors.surface, borderColor: selected ? colors.focus : colors.border },
                pressed && styles.pressed,
            ]}
        >
            <View style={styles.manualHeader}>
                <Heading>{title}</Heading>
                <Icon name="chevronRight" color={colors.inkMuted} />
            </View>
            <Caption>{summary}</Caption>
            {status}
        </Pressable>
    )
}

const styles = StyleSheet.create({
    card: {
        flexDirection: 'row',
        minHeight: touchTarget,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: space.sm,
        gap: space.md,
        alignItems: 'center',
    },
    thumb: {
        width: 72,
        height: 72,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    image: {
        width: '100%',
        height: '100%',
    },
    text: {
        flex: 1,
        gap: space.xs,
        alignItems: 'flex-start',
    },
    manual: {
        minHeight: touchTarget,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: space.md,
        gap: space.xs,
    },
    manualHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
    },
    pressed: {
        opacity: 0.8,
    },
})
