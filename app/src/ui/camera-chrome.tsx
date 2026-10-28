import type { ReactElement, ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ThemeProvider, useTheme } from '../theme/theme'
import { darkColors, radius, shutterSize, space } from '../theme/tokens'
import { useFeedback } from './feedback'
import { IconButton } from './button'
import { focusRingStyle, useFocusRing } from './focus'
import { MotionPressable, usePressMotion } from './press-motion'
import { Body } from './text'

// Camera controls are always dark, whatever the system appearance, so the viewfinder reads like a camera.
export function CameraChrome({
    hint,
    onClose,
    shutterLabel,
    onShutter,
    shutterDisabled = false,
    busy = false,
    children,
}: {
    readonly hint: string
    readonly onClose: () => void
    readonly shutterLabel: string
    readonly onShutter: () => void
    readonly shutterDisabled?: boolean
    readonly busy?: boolean
    readonly children: ReactNode
}): ReactElement {
    // Full-bleed: the camera does not sit under a header, so it clears the status bar and home indicator itself.
    const insets = useSafeAreaInsets()
    return (
        <ThemeProvider scheme="dark">
            <View
                style={[
                    styles.root,
                    {
                        backgroundColor: darkColors.canvas,
                        paddingTop: insets.top + space.md,
                        paddingBottom: insets.bottom + space.md,
                    },
                ]}
            >
                <View style={styles.topBar}>
                    <IconButton label="Close camera" icon="close" onPress={onClose} />
                </View>
                <View style={styles.viewfinder}>
                    {children}
                    <ViewfinderCorners />
                </View>
                <View style={styles.bottomBar}>
                    <Body>{hint}</Body>
                    <ShutterButton
                        label={shutterLabel}
                        onPress={onShutter}
                        disabled={shutterDisabled || busy}
                        busy={busy}
                    />
                </View>
            </View>
        </ThemeProvider>
    )
}

// Each corner is drawn twice: a wider contrast halo under the accent stroke, so the frame reads on bright scenes too.
const CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const

export function ViewfinderCorners(): ReactElement {
    const { colors } = useTheme()
    return (
        <View accessibilityElementsHidden={true} importantForAccessibility="no" style={StyleSheet.absoluteFill}>
            {CORNERS.map((corner) => (
                <View key={corner} style={StyleSheet.absoluteFill}>
                    <View
                        testID="viewfinder-halo"
                        style={[
                            styles.corner,
                            styles[corner],
                            styles[`${corner}Halo`],
                            { borderColor: colors.inkInverse },
                        ]}
                    />
                    <View style={[styles.corner, styles[corner], { borderColor: colors.accent }]} />
                </View>
            ))}
        </View>
    )
}

// A shutter that is only waiting for the camera dims; one that is working on a photo stays bright and shows progress.
const WAITING_OPACITY = 0.4
const BUSY_OPACITY = 0.9

export function ShutterButton({
    label,
    onPress,
    disabled,
    busy = false,
}: {
    readonly label: string
    readonly onPress: () => void
    readonly disabled: boolean
    // True while a photo is being prepared. The ring shows progress, so the wait is visible and not only inert.
    readonly busy?: boolean
}): ReactElement {
    const { colors } = useTheme()
    const { haptic } = useFeedback()
    const focus = useFocusRing()
    const press = usePressMotion(disabled, !disabled ? 1 : busy ? BUSY_OPACITY : WAITING_OPACITY)
    return (
        <MotionPressable
            testID="camera-shutter"
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled, busy }}
            aria-disabled={disabled}
            disabled={disabled}
            {...focus.focusHandlers}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            onPress={(): void => {
                haptic('selection')
                onPress()
            }}
            style={[
                focusRingStyle(focus.focused, colors),
                styles.shutterRing,
                { borderColor: colors.ink },
                press.style,
            ]}
        >
            <View style={[styles.shutterCore, { backgroundColor: colors.ink }]}>
                {busy ? <ActivityIndicator testID="shutter-busy" color={colors.inkInverse} size="large" /> : null}
            </View>
        </MotionPressable>
    )
}

const CORNER = 28

const styles = StyleSheet.create({
    root: {
        flex: 1,
        paddingHorizontal: space.md,
        gap: space.md,
    },
    topBar: {
        flexDirection: 'row',
        justifyContent: 'flex-start',
    },
    viewfinder: {
        flex: 1,
        borderRadius: radius.lg,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
    },
    corner: {
        position: 'absolute',
        width: CORNER,
        height: CORNER,
        borderColor: 'transparent',
    },
    topLeft: {
        top: space.sm,
        left: space.sm,
        borderTopWidth: 3,
        borderLeftWidth: 3,
    },
    topRight: {
        top: space.sm,
        right: space.sm,
        borderTopWidth: 3,
        borderRightWidth: 3,
    },
    bottomLeft: {
        bottom: space.sm,
        left: space.sm,
        borderBottomWidth: 3,
        borderLeftWidth: 3,
    },
    bottomRight: {
        bottom: space.sm,
        right: space.sm,
        borderBottomWidth: 3,
        borderRightWidth: 3,
    },
    // The halo is one point larger on every side, with a wider stroke, so the accent line sits on a contrast edge.
    topLeftHalo: {
        top: space.sm - 1,
        left: space.sm - 1,
        borderTopWidth: 5,
        borderLeftWidth: 5,
        width: CORNER + 2,
        height: CORNER + 2,
    },
    topRightHalo: {
        top: space.sm - 1,
        right: space.sm - 1,
        borderTopWidth: 5,
        borderRightWidth: 5,
        width: CORNER + 2,
        height: CORNER + 2,
    },
    bottomLeftHalo: {
        bottom: space.sm - 1,
        left: space.sm - 1,
        borderBottomWidth: 5,
        borderLeftWidth: 5,
        width: CORNER + 2,
        height: CORNER + 2,
    },
    bottomRightHalo: {
        bottom: space.sm - 1,
        right: space.sm - 1,
        borderBottomWidth: 5,
        borderRightWidth: 5,
        width: CORNER + 2,
        height: CORNER + 2,
    },
    bottomBar: {
        alignItems: 'center',
        gap: space.sm,
    },
    shutterRing: {
        width: shutterSize,
        height: shutterSize,
        borderRadius: radius.pill,
        borderWidth: 4,
        alignItems: 'center',
        justifyContent: 'center',
    },
    shutterCore: {
        width: shutterSize - 16,
        height: shutterSize - 16,
        borderRadius: radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
    },
})
