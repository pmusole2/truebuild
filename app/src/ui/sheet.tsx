import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { Animated, Easing, Modal, Platform, StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { motion, radius, space } from '../theme/tokens'
import { useFeedback } from './feedback'
import { IconButton } from './button'
import { Body, Title } from './text'

// A bottom sheet slides up over the current screen. Under reduced motion it appears in place, with no movement.
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
    const { colors } = useTheme()
    const { reduceMotion } = useFeedback()
    const progress = useRef(new Animated.Value(0)).current
    useEffect(() => {
        if (!visible) {
            progress.setValue(0)
            return
        }
        if (reduceMotion) {
            progress.setValue(1)
            return
        }
        Animated.timing(progress, {
            toValue: 1,
            duration: motion.sheet,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
        }).start()
    }, [visible, reduceMotion, progress])

    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="none"
            onRequestClose={onClose}
            accessibilityViewIsModal={true}
        >
            <View style={styles.backdrop}>
                <Animated.View
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: colors.surface,
                            borderColor: colors.border,
                            opacity: progress,
                            transform: [
                                {
                                    translateY: progress.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [space.lg, 0],
                                    }),
                                },
                            ],
                        },
                    ]}
                >
                    <View style={styles.header}>
                        <View style={styles.titleWrap}>
                            <Title>{title}</Title>
                        </View>
                        <IconButton label="Close sheet" icon="close" onPress={onClose} />
                    </View>
                    {children}
                </Animated.View>
            </View>
        </Modal>
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
    backdrop: {
        flex: 1,
        justifyContent: 'flex-end',
        backgroundColor: 'rgba(0, 0, 0, 0.35)',
    },
    sheet: {
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        borderWidth: 1,
        padding: space.md,
        paddingBottom: space.xl,
        gap: space.md,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    titleWrap: {
        flex: 1,
    },
    steps: {
        gap: space.sm,
    },
})
