import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ComponentRef,
    type ReactElement,
    type ReactNode,
} from 'react'
import {
    AccessibilityInfo,
    KeyboardAvoidingView,
    Modal,
    PanResponder,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    useWindowDimensions,
    View,
    type GestureResponderEvent,
    type PanResponderGestureState,
} from 'react-native'
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/theme'
import { motion, radius, space, touchTarget } from '../theme/tokens'
import { IconButton } from './button'
import { useFeedback } from './feedback'
import { Body, Heading } from './text'

/** Resting heights as a share of the window: a peek, a tall default and a near-full sheet. */
export type SheetDetent = 'peek' | 'tall' | 'full'
export const DETENT_RATIO: Readonly<Record<SheetDetent, number>> = { peek: 0.45, tall: 0.78, full: 0.92 }
const ORDER: readonly SheetDetent[] = ['peek', 'tall', 'full']

// Long content scrolls inside the sheet; the sheet never grows past this share of the window, so the scrim stays visible.
export const SHEET_MAX_HEIGHT_RATIO = DETENT_RATIO.full

// Spring tuned to settle without a visible bounce; reduced motion skips it and sets the height directly.
const SPRING = { damping: 26, stiffness: 260, mass: 1 } as const
// A fling faster than this (points per millisecond) projects the sheet to the detent it points at.
const FLING_PROJECTION_MS = 160

/** The nearest resting height to `projected`, where 0 means closed. Exported for the drag rule's own test. */
export function snapHeight(projected: number, heights: readonly number[], closeBelow: number): number {
    if (projected < closeBelow) {
        return 0
    }
    return heights.reduce(
        (best, h) => (Math.abs(h - projected) < Math.abs(best - projected) ? h : best),
        heights[0] ?? 0,
    )
}

export function BottomSheet({
    visible,
    title,
    onClose,
    children,
    detents = ['peek', 'tall'],
    initialDetent,
    testID = 'bottom-sheet',
    scrollTestID = 'bottom-sheet-scroll',
}: {
    readonly visible: boolean
    readonly title: string
    readonly onClose: () => void
    readonly children: ReactNode
    // Two or three resting heights. The sheet opens at `initialDetent`, else at the second one (the tall default).
    readonly detents?: readonly SheetDetent[]
    readonly initialDetent?: SheetDetent
    readonly testID?: string
    readonly scrollTestID?: string
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
                <SheetFrame
                    title={title}
                    onClose={onClose}
                    detents={detents}
                    initialDetent={initialDetent}
                    testID={testID}
                    scrollTestID={scrollTestID}
                >
                    {children}
                </SheetFrame>
            </SafeAreaProvider>
        </Modal>
    )
}

/** The one More sheet: same grabber, detents and close control wherever a screen keeps its details. */
export function MoreSheet(props: {
    readonly visible: boolean
    readonly title?: string
    readonly onClose: () => void
    readonly children: ReactNode
    readonly detents?: readonly SheetDetent[]
    readonly initialDetent?: SheetDetent
}): ReactElement {
    const { title = 'More', ...rest } = props
    return <BottomSheet {...rest} title={title} testID="more-sheet" scrollTestID="more-sheet-scroll" />
}

function SheetFrame({
    title,
    onClose,
    children,
    detents,
    initialDetent,
    testID,
    scrollTestID,
}: {
    readonly title: string
    readonly onClose: () => void
    readonly children: ReactNode
    readonly detents: readonly SheetDetent[]
    readonly initialDetent: SheetDetent | undefined
    readonly testID: string
    readonly scrollTestID: string
}): ReactElement {
    const { colors, scheme } = useTheme()
    const { reduceMotion } = useFeedback()
    const { height } = useWindowDimensions()
    const insets = useSafeAreaInsets()
    const heights = useMemo(
        () =>
            [...new Set(detents)]
                .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
                .map((detent) => Math.round(height * DETENT_RATIO[detent])),
        [detents, height],
    )
    const startIndex = useMemo(() => {
        const chosen =
            initialDetent === undefined
                ? -1
                : [...new Set(detents)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).indexOf(initialDetent)
        return chosen >= 0 ? chosen : Math.min(1, heights.length - 1)
    }, [detents, heights.length, initialDetent])
    const [index, setIndex] = useState(startIndex)
    const sheetHeight = useSharedValue(heights[startIndex] ?? 0)
    const entrance = useSharedValue(0)
    const current = useRef(heights[startIndex] ?? 0)
    const dragStart = useRef(0)
    const closing = useRef(false)
    const titleRef = useRef<ComponentRef<typeof View>>(null)

    const settle = useCallback(
        (to: number): void => {
            current.current = to
            if (reduceMotion) {
                cancelAnimation(sheetHeight)
                sheetHeight.value = to
                return
            }
            sheetHeight.value = withSpring(to, SPRING)
        },
        [reduceMotion, sheetHeight],
    )

    const close = useCallback((): void => {
        if (closing.current) {
            return
        }
        closing.current = true
        if (reduceMotion) {
            onClose()
            return
        }
        entrance.value = withTiming(0, { duration: motion.quick, easing: Easing.out(Easing.cubic) })
        setTimeout(onClose, motion.quick)
    }, [entrance, onClose, reduceMotion])

    useEffect(() => {
        if (reduceMotion) {
            cancelAnimation(entrance)
            entrance.value = 1
        } else {
            entrance.value = withSpring(1, SPRING)
        }
        // Screen readers land on the sheet title, the first thing the sheet says.
        const focusTimer = setTimeout(() => {
            // Not every platform can move screen reader focus (the web cannot): focus is best-effort.
            if (titleRef.current !== null && typeof AccessibilityInfo.sendAccessibilityEvent === 'function') {
                try {
                    AccessibilityInfo.sendAccessibilityEvent(titleRef.current, 'focus')
                } catch {
                    return
                }
            }
        }, 0)
        return (): void => {
            clearTimeout(focusTimer)
            cancelAnimation(entrance)
            cancelAnimation(sheetHeight)
        }
    }, [entrance, reduceMotion, sheetHeight])

    const moveTo = useCallback(
        (next: number): void => {
            const bounded = Math.max(0, Math.min(heights.length - 1, next))
            setIndex(bounded)
            settle(heights[bounded] ?? 0)
        },
        [heights, settle],
    )

    const pan = useMemo(
        () =>
            PanResponder.create({
                onStartShouldSetPanResponder: () => true,
                onMoveShouldSetPanResponder: () => true,
                onPanResponderGrant: () => {
                    dragStart.current = current.current
                },
                onPanResponderMove: (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
                    const top = heights[heights.length - 1] ?? 0
                    const next = Math.max(0, Math.min(top, dragStart.current - gesture.dy))
                    current.current = next
                    cancelAnimation(sheetHeight)
                    sheetHeight.value = next
                },
                onPanResponderRelease: (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
                    const projected = current.current - gesture.vy * FLING_PROJECTION_MS
                    const target = snapHeight(projected, heights, (heights[0] ?? 0) * 0.6)
                    if (target === 0) {
                        close()
                        return
                    }
                    setIndex(Math.max(0, heights.indexOf(target)))
                    settle(target)
                },
                onPanResponderTerminate: () => settle(heights[index] ?? 0),
            }),
        [close, heights, index, settle, sheetHeight],
    )

    const boxStyle = useAnimatedStyle(() => ({ height: sheetHeight.value, opacity: entrance.value }))
    const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - entrance.value) * space.xl * 2 }] }))

    return (
        <KeyboardAvoidingView
            testID="sheet-scrim"
            style={[
                styles.scrim,
                { backgroundColor: scheme === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.35)' },
            ]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <Pressable
                testID="sheet-dismiss"
                accessibilityElementsHidden={true}
                importantForAccessibility="no"
                style={styles.dismiss}
                onPress={close}
            />
            <Animated.View
                testID={testID}
                style={[
                    styles.sheet,
                    { backgroundColor: colors.surface, paddingBottom: space.md + insets.bottom },
                    boxStyle,
                    slideStyle,
                ]}
            >
                <View
                    testID="sheet-handle"
                    accessible={true}
                    accessibilityRole="adjustable"
                    accessibilityLabel="Sheet size"
                    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                    onAccessibilityAction={(event): void => {
                        if (event.nativeEvent.actionName === 'increment') {
                            moveTo(index + 1)
                        } else if (index === 0) {
                            close()
                        } else {
                            moveTo(index - 1)
                        }
                    }}
                    {...pan.panHandlers}
                    style={styles.grabZone}
                >
                    <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />
                </View>
                <View style={styles.header}>
                    <View ref={titleRef} accessible={true} style={styles.titleWrap}>
                        <Heading>{title}</Heading>
                    </View>
                    <IconButton label="Close sheet" icon="close" onPress={close} />
                </View>
                <ScrollView
                    testID={scrollTestID}
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled={true}
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
    dismiss: { ...StyleSheet.absoluteFill },
    sheet: {
        borderTopLeftRadius: radius.sheet,
        borderTopRightRadius: radius.sheet,
        borderCurve: 'continuous',
        paddingHorizontal: space.md,
        overflow: 'hidden',
    },
    // The grab zone is the only drag region, so dragging never fights the content's own scroll.
    grabZone: { height: touchTarget, alignItems: 'center', justifyContent: 'center' },
    grabber: { width: 40, height: 5, borderRadius: radius.pill },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingBottom: space.xs,
    },
    titleWrap: {
        flex: 1,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        gap: space.md,
        paddingBottom: space.md,
    },
    steps: {
        gap: space.sm,
    },
})
