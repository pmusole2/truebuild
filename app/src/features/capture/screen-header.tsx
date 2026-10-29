import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { IconButton } from '../../ui/button'
import { Caption, Heading } from '../../ui/text'
import { CoachTarget, type CoachContextValue } from '../onboarding/coach-provider'
import type { OnboardingScreen } from '../onboarding/coach-types'
import { space } from '../../theme/tokens'

/** What the More sheet is showing. `ask` opens on the question composer, `fix` on the one-fact editor. */
export type MoreMode = 'details' | 'ask' | 'fix'

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

/** The one trailing header control: More, the single entry to details, asking and every other secondary action. */
export function HeaderButtons({
    more,
    coach,
    registry,
    trailing,
}: {
    more: MoreControl
    coach?: OnboardingScreen
    registry?: Pick<CoachContextValue, 'registerTarget'> | null
    // The control as a composed screen worded it. It is still More; only its origin and availability come from the document.
    trailing?: { readonly nativeID: string; readonly enabled: boolean; readonly run: () => void } | null
}): ReactElement {
    const open = (): void => (trailing?.enabled === true ? trailing.run() : more.show())
    return (
        <View style={styles.buttons}>
            {/* The native header sits outside the screen's own subtree, so the route names the screen it belongs to. */}
            <CoachTarget registry={registry} id="header-more" screen={coach ?? null} label="More" onPress={open}>
                <IconButton
                    label="More"
                    icon="more"
                    onPress={open}
                    testID="header-more"
                    nativeID={trailing?.nativeID}
                />
            </CoachTarget>
        </View>
    )
}

/** Two-line native header title: the screen name and where the person is. */
export function HeaderTitle({
    title,
    subtitle,
    nativeID,
}: {
    title: string
    subtitle?: string
    nativeID?: string
}): ReactElement {
    return (
        <View
            nativeID={nativeID}
            accessible={true}
            accessibilityRole="header"
            accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        >
            {/* Titles wrap at the largest native fonts; height is content-driven so nothing clips or overlaps. */}
            <Heading>{title}</Heading>
            {subtitle === undefined ? null : <Caption>{subtitle}</Caption>}
        </View>
    )
}

/** A stand-in for the native header in previews and tests, where no navigator exists. */
export function InlineHeader({
    title,
    subtitle,
    more,
}: {
    title: string
    subtitle?: string
    more: MoreControl
}): ReactElement {
    return (
        <View style={styles.inline} testID="inline-header">
            <View style={styles.titles}>
                <HeaderTitle title={title} subtitle={subtitle} />
            </View>
            <HeaderButtons more={more} />
        </View>
    )
}

const styles = StyleSheet.create({
    buttons: { flexDirection: 'row', alignItems: 'center' },
    inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md },
    titles: { flex: 1 },
})
