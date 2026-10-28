import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Dimensions, Keyboard, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { AppButton } from '../../ui/button'
import { Notice } from '../../ui/status'
import { useTheme } from '../../theme/theme'
import { space } from '../../theme/tokens'
import { isProblemNotice, plainNotice } from './plain-copy'
import type { WorkflowScreenProps } from './workflow-types'

/** The hero takes at least this share of the full window height on Guide and Quick check. */
export const HERO_RATIO = 0.55

export function useKeyboardVisible(): boolean {
    const [visible, setVisible] = useState(false)
    useEffect(() => {
        const show = (): void => setVisible(true)
        const hide = (): void => setVisible(false)
        const subscriptions = [
            Keyboard.addListener('keyboardWillShow', show),
            Keyboard.addListener('keyboardDidShow', show),
            Keyboard.addListener('keyboardWillHide', hide),
            Keyboard.addListener('keyboardDidHide', hide),
        ]
        return (): void => subscriptions.forEach((subscription) => subscription.remove())
    }, [])
    return visible
}

/** The picture stays pinned at 55%; overflowing text has its own scroll region. Editors can make room for a keyboard. */
export function heroHeightFor(windowHeight: number, _fontScale: number, keyboard: boolean): number {
    if (keyboard) {
        return Math.round(windowHeight * 0.22)
    }
    return Math.round(windowHeight * HERO_RATIO)
}

export function useHeroHeight(keyboard = false): number {
    const { height, fontScale } = useWindowDimensions()
    // Android's app window excludes system bars; native screenshots measure the full screen. Keep the same 55% share
    // on both platforms. The window subscription above still refreshes this measurement after a rotation/resize.
    const viewport = Platform.OS === 'android' ? Dimensions.get('screen').height : height
    return heroHeightFor(viewport, fontScale, keyboard)
}

/** Canvas fill for a screen body; the native header above and the fixed bar below belong to the screen, not to this. */
export function ScreenBody({ children, testID }: { children: ReactNode; testID?: string }): ReactElement {
    const { colors } = useTheme()
    return (
        <View testID={testID} style={[styles.body, { backgroundColor: colors.canvas }]}>
            {children}
        </View>
    )
}

/** Only text that overflows scrolls. The hero above and the bar below stay put. */
export function TextRegion({ children, testID }: { children: ReactNode; testID?: string }): ReactElement {
    return (
        <ScrollView
            testID={testID}
            style={styles.region}
            contentContainerStyle={styles.regionContent}
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="never"
        >
            {children}
        </ScrollView>
    )
}

/** A controller notice in plain words, with the one recovery that keeps working: retry reading saved builds. */
export function PlainNotice({ state, controller }: WorkflowScreenProps): ReactElement | null {
    if (state.notice === null && !state.storageReadOnly) {
        return null
    }
    return (
        <View accessibilityLiveRegion="polite" style={styles.notice}>
            {state.notice === null ? null : (
                <Notice tone={isProblemNotice(state.notice) ? 'error' : 'info'} text={plainNotice(state.notice)} />
            )}
            {state.storageReadOnly ? (
                <AppButton
                    label="Try again"
                    testID="retry-library"
                    busy={state.loading}
                    disabled={state.loading || state.pending !== null}
                    onPress={(): void => {
                        void controller.restore()
                    }}
                />
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    body: { flex: 1 },
    region: { flex: 1, minHeight: 0 },
    regionContent: { padding: space.md, gap: space.sm },
    notice: { gap: space.xs },
})
