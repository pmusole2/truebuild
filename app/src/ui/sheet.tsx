import { useEffect, type ReactElement, type ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
    cancelAnimation,
    Easing,
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/theme'
import { motion, radius, space } from '../theme/tokens'
import { IconButton } from './button'
import { useFeedback } from './feedback'
import { Body, Heading } from './text'

// Long content scrolls inside the sheet; the sheet never grows past this share of the window, so the scrim stays visible.
export const SHEET_MAX_HEIGHT_RATIO = 0.9

export function BottomSheet({
    visible,
    title,
    onClose,
    children,
}: {
    readonly visible: boolean
    readonly title: string
    readonly onClose: () => void
    readonly children: ReactNode
}): ReactElement {
    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="none"
            onRequestClose={onClose}
            accessibilityViewIsModal={true}
        >
            {/* Modal is its own native root, so it gets its own safe-area measurement for the bottom inset. */}
            <SafeAreaProvider>
                <SheetFrame title={title} onClose={onClose}>
                    {children}
                </SheetFrame>
            </SafeAreaProvider>
        </Modal>
    )
}

function SheetFrame({
    title,
    onClose,
    children,
}: {
    readonly title: string
    readonly onClose: () => void
    readonly children: ReactNode
}): ReactElement {
    const { colors, scheme } = useTheme()
    const { reduceMotion } = useFeedback()
    const { height } = useWindowDimensions()
    const insets = useSafeAreaInsets()
    const progress = useSharedValue(0)

    useEffect(() => {
        if (reduceMotion) {
            cancelAnimation(progress)
            progress.value = 1
            return undefined
        }
        progress.value = withTiming(1, { duration: motion.sheet, easing: Easing.out(Easing.cubic) })
        return (): void => {
            cancelAnimation(progress)
        }
    }, [progress, reduceMotion])

    const entrance = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: interpolate(progress.value, [0, 1], [space.lg, 0]) }],
    }))

    return (
        <KeyboardAvoidingView
            testID="sheet-scrim"
            style={[
                styles.scrim,
                { backgroundColor: scheme === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.35)' },
            ]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <Animated.View
                testID="bottom-sheet"
                style={[
                    styles.sheet,
                    {
                        maxHeight: height * SHEET_MAX_HEIGHT_RATIO,
                        paddingBottom: space.lg + insets.bottom,
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                    },
                    entrance,
                ]}
            >
                <View
                    testID="sheet-handle"
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no"
                    style={[styles.handle, { backgroundColor: colors.borderStrong }]}
                />
                <View style={styles.header}>
                    <View style={styles.titleWrap}>
                        <Heading>{title}</Heading>
                    </View>
                    <IconButton label="Close sheet" icon="close" onPress={onClose} />
                </View>
                <ScrollView
                    testID="bottom-sheet-scroll"
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    {children}
                </ScrollView>
            </Animated.View>
        </KeyboardAvoidingView>
    )
}

/** Numbered instructions for the current step, read from the manual. Each step is announced with its number. */
export function InstructionSheet({
    visible,
    title,
    steps,
    onClose,
}: {
    readonly visible: boolean
    readonly title: string
    readonly steps: readonly string[]
    readonly onClose: () => void
}): ReactElement {
    return (
        <BottomSheet visible={visible} title={title} onClose={onClose}>
            <View style={styles.steps}>
                {steps.map((step, index) => (
                    <View key={`${index}-${step}`} accessible={true} accessibilityLabel={`Step ${index + 1}: ${step}`}>
                        <Body>{`${index + 1}. ${step}`}</Body>
                    </View>
                ))}
            </View>
        </BottomSheet>
    )
}

const styles = StyleSheet.create({
    scrim: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: radius.sheet,
        borderTopRightRadius: radius.sheet,
        borderWidth: 1,
        padding: space.md,
        gap: space.md,
    },
    handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: radius.pill },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    titleWrap: {
        flex: 1,
    },
    scroll: {
        flexGrow: 0,
        flexShrink: 1,
    },
    scrollContent: {
        gap: space.md,
        paddingBottom: space.xs,
    },
    steps: {
        gap: space.sm,
    },
})
