import type { ReactElement, ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { ThemeProvider, useTheme } from '../theme/theme'
import { darkColors, radius, space } from '../theme/tokens'
import { IconButton } from './button'
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
    return (
        <ThemeProvider scheme="dark">
            <View style={[styles.root, { backgroundColor: darkColors.canvas }]}>
                <View style={styles.topBar}>
                    <IconButton label="Close camera" icon="close" onPress={onClose} />
                </View>
                <View style={styles.viewfinder}>
                    {children}
                    <ViewfinderCorners />
                </View>
                <View style={styles.bottomBar}>
                    <Body>{hint}</Body>
                    <Shutter label={shutterLabel} onPress={onShutter} disabled={shutterDisabled || busy} />
                </View>
            </View>
        </ThemeProvider>
    )
}

function ViewfinderCorners(): ReactElement {
    const { colors } = useTheme()
    return (
        <View accessibilityElementsHidden={true} importantForAccessibility="no" style={StyleSheet.absoluteFill}>
            <View style={[styles.corner, styles.topLeft, { borderColor: colors.accent }]} />
            <View style={[styles.corner, styles.topRight, { borderColor: colors.accent }]} />
            <View style={[styles.corner, styles.bottomLeft, { borderColor: colors.accent }]} />
            <View style={[styles.corner, styles.bottomRight, { borderColor: colors.accent }]} />
        </View>
    )
}

function Shutter({
    label,
    onPress,
    disabled,
}: {
    readonly label: string
    readonly onPress: () => void
    readonly disabled: boolean
}): ReactElement {
    const { colors } = useTheme()
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            aria-disabled={disabled}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [
                styles.shutterRing,
                { borderColor: colors.ink },
                pressed && !disabled && styles.pressed,
                disabled && styles.disabled,
            ]}
        >
            <View style={[styles.shutterCore, { backgroundColor: colors.ink }]} />
        </Pressable>
    )
}

const CORNER = 28

const styles = StyleSheet.create({
    root: {
        flex: 1,
        padding: space.md,
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
    bottomBar: {
        alignItems: 'center',
        gap: space.sm,
    },
    shutterRing: {
        width: 72,
        height: 72,
        borderRadius: radius.pill,
        borderWidth: 3,
        alignItems: 'center',
        justifyContent: 'center',
    },
    shutterCore: {
        width: 56,
        height: 56,
        borderRadius: radius.pill,
    },
    pressed: {
        opacity: 0.8,
    },
    disabled: {
        opacity: 0.4,
    },
})
