import {
    createContext,
    useContext,
    useEffect,
    useRef,
    useState,
    type ComponentRef,
    type ReactElement,
    type ReactNode,
    type RefObject,
} from 'react'
import { Dimensions, Keyboard, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useIsFocused, usePathname } from 'expo-router'
import { screenOfPath } from '../screens/native-meter'
import { AppButton } from '../../ui/button'
import { MeterRootsContext, type MeterRoots } from '../../ui/meter-roots'
import { useSheetDismiss } from '../../ui/sheet'
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

const ScreenBodyScope = createContext(false)

/** Canvas fill for a screen body; the native header above and the fixed bar below belong to the screen, not to this. */
export function ScreenBody({
    children,
    testID,
    nativeID,
    insetTop = 0,
}: {
    children: ReactNode
    testID?: string
    nativeID?: string
    insetTop?: number
}): ReactElement {
    const { colors } = useTheme()
    // The host meter counts the whole document this screen sits in; it only needs a ref to reach it.
    const root = useRef<ComponentRef<typeof View>>(null)
    const meterRoots = useContext(MeterRootsContext)
    const nested = useContext(ScreenBodyScope)
    const sheet = useSheetDismiss()
    return (
        <ScreenBodyScope.Provider value={true}>
            <View
                ref={root}
                testID={testID}
                nativeID={nativeID}
                collapsable={false}
                style={[styles.body, { backgroundColor: colors.canvas, paddingTop: insetTop }]}
            >
                {children}
                {meterRoots === null || nested || sheet !== null ? null : (
                    <FocusedMeterRoot target={root} roots={meterRoots} />
                )}
            </View>
        </ScreenBodyScope.Provider>
    )
}

/** A meter-free native preview needs no router; the mounted production meter requires its real focus witness. */
function FocusedMeterRoot({
    target,
    roots,
}: {
    readonly target: RefObject<ComponentRef<typeof View> | null>
    readonly roots: MeterRoots
}): null {
    const focused = useIsFocused()
    const screen = screenOfPath(usePathname())
    useEffect(() => roots.registerRoot(target.current, 'app', { screen, focused }), [target, roots, screen, focused])
    return null
}

/** Only text that overflows scrolls. The hero above and the bar below stay put. */
export function TextRegion({
    children,
    testID,
    compact = false,
}: {
    children: ReactNode
    testID?: string
    // Less padding above and below, for a screen whose question and its supporting line must both show at once.
    compact?: boolean
}): ReactElement {
    return (
        <ScrollView
            testID={testID}
            style={styles.region}
            contentContainerStyle={[styles.regionContent, compact && styles.regionCompact]}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled={true}
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
    regionCompact: { paddingVertical: space.sm },
    notice: { gap: space.xs },
})
