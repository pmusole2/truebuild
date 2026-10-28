import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { IconButton } from '../../ui/button'
import { Caption, Heading } from '../../ui/text'
import { space } from '../../theme/tokens'

/** What the More sheet is showing. `ask` opens straight on the question composer. */
export type MoreMode = 'details' | 'ask'

export type MoreControl = {
    readonly open: boolean
    readonly mode: MoreMode
    readonly show: (mode?: MoreMode) => void
    readonly hide: () => void
}

/** State for one screen's More sheet. Route files own it so the native header button can open the same sheet. */
export function useMoreState(): MoreControl {
    const [view, setView] = useState<{ open: boolean; mode: MoreMode }>({ open: false, mode: 'details' })
    const show = useCallback((mode: MoreMode = 'details'): void => setView({ open: true, mode }), [])
    const hide = useCallback((): void => setView((current) => ({ ...current, open: false })), [])
    return useMemo(() => ({ ...view, show, hide }), [view, show, hide])
}

export type ChromeProps = {
    // Production screens leave the header to the native Stack. Previews and tests render this inline header.
    readonly chrome?: 'native' | 'inline'
    readonly more?: MoreControl
}

/** The trailing header controls: one quiet Ask icon where asking makes sense, and More (the single details entry). */
export function HeaderButtons({ more, ask = false }: { more: MoreControl; ask?: boolean }): ReactElement {
    return (
        <View style={styles.buttons}>
            {ask ? (
                <IconButton label="Ask" icon="help" onPress={(): void => more.show('ask')} testID="header-ask" />
            ) : null}
            <IconButton label="More" icon="more" onPress={(): void => more.show()} testID="header-more" />
        </View>
    )
}

/** Two-line native header title: the screen name and where the person is. */
export function HeaderTitle({ title, subtitle }: { title: string; subtitle?: string }): ReactElement {
    return (
        <View
            accessible={true}
            accessibilityRole="header"
            accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        >
            <Heading numberOfLines={1}>{title}</Heading>
            {subtitle === undefined ? null : <Caption>{subtitle}</Caption>}
        </View>
    )
}

/** A stand-in for the native header in previews and tests, where no navigator exists. */
export function InlineHeader({
    title,
    subtitle,
    more,
    ask = false,
}: {
    title: string
    subtitle?: string
    more: MoreControl
    ask?: boolean
}): ReactElement {
    return (
        <View style={styles.inline} testID="inline-header">
            <View style={styles.titles}>
                <HeaderTitle title={title} subtitle={subtitle} />
            </View>
            <HeaderButtons more={more} ask={ask} />
        </View>
    )
}

const styles = StyleSheet.create({
    buttons: { flexDirection: 'row', alignItems: 'center' },
    inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md },
    titles: { flex: 1 },
})
