import type { ReactElement } from 'react'
import { Image, Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { radius, space, touchTarget } from '../theme/tokens'
import { focusRingStyle, useFocusRing } from './focus'
import { Icon } from './icons'
import { Callout, Label } from './text'
import { useOriginNativeId } from './render-origin'

const THUMB = 40

// Display text is sentence case; the stored name is never changed, so assistive tech still hears the part's own name.
export function partDisplayName(name: string): string {
    const trimmed = name.trim()
    if (trimmed.length === 0) return trimmed
    // Preserve source brands and acronyms; only uniform casing needs sentence-case presentation.
    if (trimmed !== trimmed.toLocaleUpperCase() && trimmed !== trimmed.toLocaleLowerCase()) return trimmed
    const phrase =
        /\s/u.test(trimmed) && trimmed === trimmed.toLocaleUpperCase() ? trimmed.toLocaleLowerCase() : trimmed
    return phrase.charAt(0).toLocaleUpperCase() + phrase.slice(1)
}

/**
 * A part on a step, with a 40 point thumbnail: its 2D image when there is one, else its colour, else the part glyph.
 * A known count sits in an accent pill. An unknown count (null or omitted) shows no pill and is never guessed.
 * The whole row is one button of at least 44 points.
 */
export function PartChip({
    name,
    count,
    onPress,
    imageUri,
    color,
    testID,
    quantityTestID,
    nativeID,
    accessibilityLabel,
}: {
    readonly name: string
    // A known count of this part on the step. Null or omitted means unknown: no pill, and nothing is invented.
    readonly count?: number | null
    // Optional so a static preview can show the chip without an action.
    readonly onPress?: () => void
    readonly imageUri?: string
    readonly color?: string
    readonly testID?: string
    readonly quantityTestID?: string
    readonly nativeID?: string
    readonly accessibilityLabel?: string
}): ReactElement {
    const inheritedId = useOriginNativeId(nativeID)
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Pressable
            accessibilityRole={onPress === undefined ? undefined : 'button'}
            accessibilityLabel={
                accessibilityLabel ?? (count === undefined || count === null ? name : `${name}, ${count}`)
            }
            accessibilityValue={count === undefined || count === null ? undefined : { text: `×${count}` }}
            {...focus.focusHandlers}
            onPress={onPress}
            testID={testID}
            nativeID={inheritedId}
            style={({ pressed }) => [
                styles.chip,
                { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
                focusRingStyle(focus.focused, colors),
                pressed && styles.pressed,
            ]}
        >
            <View
                style={[
                    styles.thumb,
                    {
                        backgroundColor:
                            imageUri === undefined ? (color ?? colors.surfaceSunken) : colors.surfaceSunken,
                    },
                ]}
            >
                {imageUri === undefined ? (
                    color === undefined ? (
                        <Icon name="part" color={colors.inkMuted} />
                    ) : null
                ) : (
                    <Image accessibilityIgnoresInvertColors={true} source={{ uri: imageUri }} style={styles.image} />
                )}
            </View>
            <Callout numberOfLines={2} style={styles.name}>
                {partDisplayName(name)}
            </Callout>
            {count === undefined || count === null ? null : (
                <View testID={quantityTestID} style={[styles.pill, { backgroundColor: colors.accent }]}>
                    <Label tone="onAccent">{`×${count}`}</Label>
                </View>
            )}
        </Pressable>
    )
}

const styles = StyleSheet.create({
    chip: {
        minHeight: touchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        padding: space.xs,
        paddingRight: space.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.sm,
        borderCurve: 'continuous',
        maxWidth: '100%',
    },
    pressed: { opacity: 0.8 },
    thumb: {
        width: THUMB,
        height: THUMB,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    image: { width: '100%', height: '100%' },
    name: { flexShrink: 1 },
    pill: {
        minWidth: space.lg,
        paddingHorizontal: space.xs,
        paddingVertical: space.xxs,
        borderRadius: radius.pill,
        alignItems: 'center',
    },
})
