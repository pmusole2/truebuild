import {
    createContext,
    useContext,
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
    Keyboard,
    Modal,
    PanResponder,
    Pressable,
    ScrollView,
    StyleSheet,
    useWindowDimensions,
    View,
    type GestureResponderEvent,
    type LayoutChangeEvent,
    type PanResponderGestureState,
} from 'react-native'
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/theme'
import { motion, radius, space, touchTarget } from '../theme/tokens'
import { IconButton } from './button'
import { useMeterRoot } from './meter-roots'
import { useFeedback } from './feedback'
import { SPRING_GENTLE, timing } from './motion'
import { useLargeText } from './large-text'
import { Body, Heading } from './text'
import {
    DocumentOwnershipScope,
    useDocumentFrameOwner,
    useDocumentModalFrameBinding,
    type DocumentFrameOwner,
} from '../features/documents/ownership'
import { mergeNativeIds, originId, RenderOriginProvider, useRenderOrigin } from './render-origin'
const SheetDismissContext = createContext<(() => void) | null>(null)
let fixtureSheetSequence = 0

/** Fixture-only callback diagnostics: a native show receipt is not a physical paint witness. */
function traceFixtureSheet(
    instance: number | null,
    phase: 'mount' | 'unmount' | 'native-show' | 'visibility',
    frame?: DocumentFrameOwner | null,
    visible?: boolean,
): void {
    if (instance === null) return
    try {
        console.info(
            JSON.stringify({
                event: 'native_sheet_lifecycle',
                instance,
                phase,
                receivedAt: Date.now(),
                ...(visible === undefined ? {} : { visible }),
                ...(frame === undefined ? {} : { kind: frame?.document.kind ?? null, state: frame?.state ?? null }),
            }),
        )
    } catch {
        // Diagnostic delivery cannot change the sheet's native lifecycle.
    }
}
/** A document's own Back/Close action uses the same native dismissal motion and single-use latch as the grabber. */
export function useSheetDismiss(): (() => void) | null {
    return useContext(SheetDismissContext)
}

/** Resting heights as a share of the window: a peek, a tall default and a near-full sheet. */
export type SheetDetent = 'peek' | 'tall' | 'full'
export const DETENT_RATIO: Readonly<Record<SheetDetent, number>> = { peek: 0.45, tall: 0.78, full: 0.92 }
const ORDER: readonly SheetDetent[] = ['peek', 'tall', 'full']

// Long content scrolls inside the sheet; the sheet never grows past this share of the window, so the scrim stays visible.
export const SHEET_MAX_HEIGHT_RATIO = DETENT_RATIO.full

// Reduced motion skips the spring and sets the height directly.
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

/** Height of the on-screen keyboard, 0 while it is hidden. Follows the keyboard as it shows, hides and changes size. */
export function useKeyboardHeight(): number {
    const [height, setHeight] = useState(0)
    useEffect(() => {
        const show = (event: { endCoordinates?: { height?: number } }): void =>
            setHeight(Math.max(0, event.endCoordinates?.height ?? 0))
        const hide = (): void => setHeight(0)
        const subscriptions = [
            Keyboard.addListener('keyboardWillShow', show),
            Keyboard.addListener('keyboardDidShow', show),
            Keyboard.addListener('keyboardWillChangeFrame', show),
            Keyboard.addListener('keyboardWillHide', hide),
            Keyboard.addListener('keyboardDidHide', hide),
        ]
        return (): void => subscriptions.forEach((subscription) => subscription.remove())
    }, [])
    return height
}

/**
 * How much of the keyboard still covers the sheet's container. Where the platform already shrank the window for the
 * keyboard (Android resizing), the container is shorter than it was and that part is not counted again.
 */
export function keyboardOverlap(keyboard: number, baselineLayout: number, layout: number): number {
    const alreadyResized = Math.max(0, baselineLayout - layout)
    return Math.max(0, keyboard - alreadyResized)
}

/**
 * Resting heights for the sheet. Each detent is its share of the window, but never taller than the space left between
 * the status bar and the keyboard, so the handle, the title and Close stay on screen and the content scrolls inside.
 */
export function fitDetents(
    ratios: readonly number[],
    windowHeight: number,
    viewport: number,
    topClearance: number,
): readonly number[] {
    const ceiling = Math.max(0, viewport - topClearance)
    return ratios.map((ratio) => Math.min(Math.round(windowHeight * ratio), ceiling))
}

export function BottomSheet({
    visible,
    title,
    compactTitle,
    onClose,
    children,
    detents = ['peek', 'tall'],
    initialDetent,
    testID = 'bottom-sheet',
    scrollTestID = 'bottom-sheet-scroll',
    documentFrame = false,
}: {
    readonly visible: boolean
    readonly title: string
    // A shorter visible title for accessibility text sizes. The full `title` stays as the accessible name.
    readonly compactTitle?: string
    readonly onClose: () => void
    readonly children: ReactNode
    // Two or three resting heights. The sheet opens at `initialDetent`, else at the second one (the tall default).
    readonly detents?: readonly SheetDetent[]
    readonly initialDetent?: SheetDetent
    readonly testID?: string
    readonly scrollTestID?: string
    /** A complete document owns header, content scrolling and bar; keep only native sheet mechanics. */
    readonly documentFrame?: boolean
}): ReactElement {
    const [fixtureInstance] = useState(() =>
        process.env.EXPO_PUBLIC_RELEASE_FIXTURE === '1' ? ++fixtureSheetSequence : null,
    )
    useEffect(() => {
        traceFixtureSheet(fixtureInstance, 'mount')
        return (): void => traceFixtureSheet(fixtureInstance, 'unmount')
    }, [fixtureInstance])
    useEffect(() => {
        traceFixtureSheet(fixtureInstance, 'visibility', undefined, visible)
    }, [fixtureInstance, visible])
    const parent = useDocumentFrameOwner()
    const inherited = useRenderOrigin()
    return (
        <DocumentOwnershipScope visible={visible}>
            {(published) => {
                // Document sheets publish their own frame. A citation disclosure belongs to its actual model-authored node.
                const owner = !visible
                    ? null
                    : (published ??
                      (!documentFrame && inherited !== null && parent?.origin === inherited ? parent : null))
                const marker =
                    owner === null
                        ? undefined
                        : mergeNativeIds(
                              `truebuild-document-content-boundary:${owner.documentId}`,
                              originId(owner.origin),
                          )
                return (
                    <Modal
                        nativeID={
                            owner === null
                                ? undefined
                                : mergeNativeIds(`truebuild-document-root:${owner.documentId}`, originId(owner.origin))
                        }
                        visible={visible}
                        transparent={true}
                        animationType="none"
                        onRequestClose={onClose}
                        onShow={
                            fixtureInstance === null
                                ? undefined
                                : (): void => traceFixtureSheet(fixtureInstance, 'native-show', owner, visible)
                        }
                        accessibilityViewIsModal={true}
                    >
                        {/* Modal is its own native root, so it gets its own safe-area measurement for the bottom inset. */}
                        <RenderOriginProvider origin={owner?.origin ?? 'shell'}>
                            <SafeAreaProvider nativeID={marker}>
                                <SheetFrame
                                    owner={owner}
                                    visible={visible}
                                    title={title}
                                    compactTitle={compactTitle}
                                    onClose={onClose}
                                    detents={detents}
                                    initialDetent={initialDetent}
                                    testID={testID}
                                    scrollTestID={scrollTestID}
                                    documentFrame={documentFrame}
                                >
                                    {children}
                                </SheetFrame>
                            </SafeAreaProvider>
                        </RenderOriginProvider>
                    </Modal>
                )
            }}
        </DocumentOwnershipScope>
    )
}

/** The one More sheet: same grabber, detents and close control wherever a screen keeps its details. */
export function MoreSheet(props: {
    readonly visible: boolean
    readonly title?: string
    readonly compactTitle?: string
    readonly onClose: () => void
    readonly children: ReactNode
    readonly detents?: readonly SheetDetent[]
    readonly initialDetent?: SheetDetent
    readonly documentFrame?: boolean
}): ReactElement {
    const { title = 'More', ...rest } = props
    return <BottomSheet {...rest} title={title} testID="more-sheet" scrollTestID="more-sheet-scroll" />
}

function SheetFrame({
    owner,
    visible,
    title,
    compactTitle,
    onClose,
    children,
    detents,
    initialDetent,
    testID,
    scrollTestID,
    documentFrame,
}: {
    readonly owner: DocumentFrameOwner | null
    readonly visible: boolean
    readonly title: string
    readonly compactTitle: string | undefined
    readonly onClose: () => void
    readonly children: ReactNode
    readonly detents: readonly SheetDetent[]
    readonly initialDetent: SheetDetent | undefined
    readonly testID: string
    readonly scrollTestID: string
    readonly documentFrame: boolean
}): ReactElement {
    const { colors, scheme } = useTheme()
    const frame = owner
    const documentId = frame?.documentId ?? null
    const frameRoot = useRef<ComponentRef<typeof View>>(null)
    useDocumentModalFrameBinding(frameRoot, owner, visible)
    const frameId =
        frame === null
            ? undefined
            : mergeNativeIds(`truebuild-document-content-boundary:${frame.documentId}`, originId(frame.origin))
    // Each mechanics host owns itself. Unmarked arbitrary content does not inherit frame credit.
    const chromeId = frameId
    const { reduceMotion } = useFeedback()
    const { height } = useWindowDimensions()
    const insets = useSafeAreaInsets()
    const large = useLargeText()
    const keyboard = useKeyboardHeight()
    // The tallest container height seen for this window: the reference for a window the platform already resized.
    const [measured, setMeasured] = useState<{ window: number; tallest: number; layout: number }>({
        window: height,
        tallest: height,
        layout: 0,
    })
    const layout = measured.window === height && measured.layout > 0 ? measured.layout : height
    const baseline = measured.window === height && measured.tallest > 0 ? measured.tallest : height
    const overlap = keyboardOverlap(keyboard, baseline, layout)
    const onContainerLayout = (event: LayoutChangeEvent): void => {
        const next = Math.round(event.nativeEvent.layout.height)
        setMeasured((now) => {
            // A newly sized window may first report an already keyboard-resized layout. Seed its unoccluded baseline
            // from the new window bounds, rather than treating that shortened layout as the full viewport.
            const fresh = now.window === height ? now : { window: height, tallest: height, layout: 0 }
            return fresh.layout === next && fresh.tallest >= next
                ? fresh
                : { window: height, tallest: Math.max(fresh.tallest, next), layout: next }
        })
    }
    const sorted = useMemo(() => [...new Set(detents)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)), [detents])
    const heights = useMemo(
        () =>
            fitDetents(
                sorted.map((detent) => DETENT_RATIO[detent]),
                height,
                layout - overlap,
                insets.top + space.xs,
            ),
        [height, insets.top, layout, overlap, sorted],
    )
    const startIndex = useMemo(() => {
        const chosen = initialDetent === undefined ? -1 : sorted.indexOf(initialDetent)
        return chosen >= 0 ? chosen : Math.min(1, sorted.length - 1)
    }, [initialDetent, sorted])
    const [index, setIndex] = useState(startIndex)
    const sheetHeight = useSharedValue(heights[startIndex] ?? 0)
    const entrance = useSharedValue(0)
    const current = useRef(heights[startIndex] ?? 0)
    const dragStart = useRef(0)
    const dragging = useRef(false)
    const closing = useRef(false)
    const titleRef = useRef<ComponentRef<typeof View>>(null)
    // The sheet is its own native window; its content is a root the host meter must be able to reach while it is open.
    const attachMeterRoot = useMeterRoot(titleRef, 'sheet', { visible })

    const settle = useCallback(
        (to: number): void => {
            current.current = to
            if (reduceMotion) {
                cancelAnimation(sheetHeight)
                sheetHeight.value = to
                return
            }
            sheetHeight.value = withSpring(to, SPRING_GENTLE)
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
        entrance.value = withTiming(0, timing(motion.fast))
        setTimeout(onClose, motion.fast)
    }, [entrance, onClose, reduceMotion])

    useEffect(() => {
        if (reduceMotion) {
            cancelAnimation(entrance)
            entrance.value = 1
        } else {
            entrance.value = withSpring(1, SPRING_GENTLE)
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

    // The keyboard (or a new window size) changes what fits. The chosen resting detent stays chosen: the sheet follows
    // its fitted height now and returns to the full one when the keyboard goes away. Reduced motion is respected by settle.
    const fitted = heights[index] ?? 0
    useEffect(() => {
        // A motion-preference change cancels an in-flight spring even when its recorded target already matches.
        if ((reduceMotion || current.current !== fitted) && !dragging.current) {
            settle(fitted)
        }
    }, [fitted, reduceMotion, settle])

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
                    dragging.current = true
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
                    dragging.current = false
                    const projected = current.current - gesture.vy * FLING_PROJECTION_MS
                    const target = snapHeight(projected, heights, (heights[0] ?? 0) * 0.6)
                    if (target === 0) {
                        close()
                        return
                    }
                    setIndex(Math.max(0, heights.indexOf(target)))
                    settle(target)
                },
                onPanResponderTerminate: () => {
                    dragging.current = false
                    settle(heights[index] ?? 0)
                },
            }),
        [close, heights, index, settle, sheetHeight],
    )

    const boxStyle = useAnimatedStyle(() => ({ height: sheetHeight.value, opacity: entrance.value }))
    const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - entrance.value) * space.xl * 2 }] }))

    return (
        <View
            ref={frameRoot}
            collapsable={false}
            nativeID={frameId}
            testID="sheet-scrim"
            onLayout={onContainerLayout}
            style={[
                styles.scrim,
                { backgroundColor: scheme === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.35)' },
                // The sheet rides above the keyboard; the keyboard already covers the home indicator area.
                { paddingBottom: overlap },
            ]}
        >
            <Pressable
                nativeID={chromeId}
                testID="sheet-dismiss"
                accessibilityElementsHidden={true}
                importantForAccessibility="no"
                style={styles.dismiss}
                onPress={close}
            />
            <Animated.View
                nativeID={chromeId}
                testID={testID}
                style={[
                    styles.sheet,
                    {
                        backgroundColor: colors.surface,
                        paddingBottom: documentFrame ? 0 : space.md + (overlap > 0 ? 0 : insets.bottom),
                    },
                    boxStyle,
                    slideStyle,
                ]}
            >
                <View
                    nativeID={chromeId}
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
                    <View nativeID={chromeId} style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />
                </View>
                {documentFrame ? (
                    <View
                        ref={attachMeterRoot}
                        collapsable={false}
                        nativeID={mergeNativeIds(
                            `truebuild-document-content-boundary:${documentId ?? 'unowned'}`,
                            originId(frame?.origin ?? 'shell'),
                        )}
                        style={{ flex: 1, minHeight: 0 }}
                    >
                        <SheetDismissContext.Provider value={close}>{children}</SheetDismissContext.Provider>
                    </View>
                ) : (
                    <>
                        <View nativeID={chromeId} style={styles.header}>
                            <View
                                nativeID={chromeId}
                                ref={attachMeterRoot}
                                accessible={true}
                                accessibilityRole={large && compactTitle !== undefined ? 'header' : undefined}
                                accessibilityLabel={large && compactTitle !== undefined ? title : undefined}
                                style={styles.titleWrap}
                            >
                                <Heading>{large && compactTitle !== undefined ? compactTitle : title}</Heading>
                            </View>
                            <IconButton label="Close sheet" icon="close" onPress={close} />
                        </View>
                        <ScrollView
                            nativeID={chromeId}
                            testID={scrollTestID}
                            style={styles.scroll}
                            contentContainerStyle={styles.scrollContent}
                            keyboardShouldPersistTaps="handled"
                            nestedScrollEnabled={true}
                        >
                            {children}
                        </ScrollView>
                    </>
                )}
            </Animated.View>
        </View>
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
