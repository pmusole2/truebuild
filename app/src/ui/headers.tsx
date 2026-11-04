import type { ReactElement, ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { layout, space } from '../theme/tokens'
import { useOriginNativeId } from './render-origin'
import { Icon } from './icons'
import { Callout, LargeTitle, Label, Title } from './text'

/**
 * The title of a screen. `display` sets it at the large size for a home or landing page. The subtitle is one muted
 * line, so the header never grows past a glance.
 */
export function PageHeader({
    title,
    subtitle,
    display = false,
    nativeID,
}: {
    readonly title: string
    readonly subtitle?: string
    readonly display?: boolean
    readonly nativeID?: string
}): ReactElement {
    const inheritedId = useOriginNativeId(nativeID)
    const Heading = display ? LargeTitle : Title
    return (
        <View nativeID={inheritedId} style={styles.page}>
            <Heading>{title}</Heading>
            {subtitle === undefined || subtitle === '' ? null : (
                <Callout tone="muted" numberOfLines={1}>
                    {subtitle}
                </Callout>
            )}
        </View>
    )
}

/** A section divider inside a screen: a muted heading on the left, an optional control on the right. */
export function SectionHeader({
    title,
    trailing,
    nativeID,
    onPress,
    expanded,
    disabled = false,
}: {
    readonly title: string
    readonly onPress?: () => void
    readonly expanded?: boolean
    readonly disabled?: boolean
    readonly trailing?: ReactNode
    readonly nativeID?: string
}): ReactElement {
    const inheritedId = useOriginNativeId(nativeID)
    return (
        <View nativeID={inheritedId} style={styles.section}>
            {onPress === undefined ? (
                <Label header={true} style={{ flexShrink: 1 }}>
                    {title}
                </Label>
            ) : (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={title}
                    accessibilityState={{ expanded, disabled }}
                    aria-expanded={expanded}
                    disabled={disabled}
                    onPress={onPress}
                    style={{
                        flex: 1,
                        minWidth: 0,
                        minHeight: 44,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: space.xs,
                    }}
                >
                    <Label header={true} style={{ flex: 1, flexShrink: 1 }}>
                        {title}
                    </Label>
                    {disabled ? null : (
                        <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>
                            <Icon name="chevronRight" size="sm" />
                        </View>
                    )}
                </Pressable>
            )}

            {trailing}
        </View>
    )
}

const styles = StyleSheet.create({
    page: {
        gap: space.xxs,
    },
    section: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
        marginTop: layout.sectionGap,
        marginBottom: layout.cardGap,
    },
})
