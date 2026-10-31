import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentRef,
    type ReactElement,
    type RefObject,
} from 'react'
import {
    AccessibilityInfo,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    View,
    type LayoutChangeEvent,
} from 'react-native'
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated'
import { FullWindowOverlay } from 'react-native-screens'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useCoachWindow } from './coach-window'
import { useTheme } from '../../theme/theme'
import { motion, radius, space, touchTarget } from '../../theme/tokens'
import { AppButton } from '../../ui/button'
import { useFeedback } from '../../ui/feedback'
import { useMeterRoot } from '../../ui/meter-roots'
import { usePressMotion } from '../../ui/press-motion'
import { useLargeText } from '../../ui/large-text'
import { SPRING_GENTLE, timing } from '../../ui/motion'
import { Body, Heading } from '../../ui/text'
import { TARGET_HINT } from './coach-inventory'
import { bubbleMaxHeight, bubbleWidth, cutoutOf, placeBubble, type Placement } from './coach-placement'
import { useCoach } from './coach-provider'
import type { ActiveStep, Rect } from './coach-types'
import { mergeNativeIds, originId } from '../screens/render-origin'
import { coachFrameOwner, useDocumentFrameOwner, useDocumentModalFrameBinding } from '../documents/ownership'

type Controls = {
    readonly next: () => void
    readonly skip: () => void
    readonly activate: () => void
    readonly defer: () => void
}

const ARROW_SIZE = 12

/** Window coordinates on both platforms: iOS overlays its header, Android uses one transparent native window. */
export function CoachRootOverlay({
    active,
    controls,
    evidenceScene,
}: {
    active: ActiveStep
    controls: Controls
    evidenceScene?: string
}): ReactElement {
    const owner = coachFrameOwner(useDocumentFrameOwner(), active.candidate)
    const frame = useRef<ComponentRef<typeof View>>(null)
    const android = Platform.OS === 'android'
    useDocumentModalFrameBinding(frame, android ? owner : null, android && owner !== null)
    const view = (
        <CoachOverlayView
            step={active}
            controls={controls}
            evidenceScene={evidenceScene}
            frameRoot={android ? frame : undefined}
        />
    )
    const marker =
        owner === null
            ? originId('shell')
            : mergeNativeIds(`truebuild-document-root:${owner.documentId}`, originId(owner.origin))
    return Platform.OS === 'ios' ? (
        // FullWindowOverlay does not forward nativeID. This frame contains only this CoachMark's portal.
        <View nativeID={marker} collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            <FullWindowOverlay unstable_accessibilityContainerViewIsModal={true}>{view}</FullWindowOverlay>
        </View>
    ) : Platform.OS === 'android' ? (
        <Modal
            nativeID={marker}
            testID="coach-root-modal"
            transparent
            animationType="none"
            statusBarTranslucent
            navigationBarTranslucent
            hardwareAccelerated
            onRequestClose={controls.skip}
        >
            {view}
        </Modal>
    ) : (
        view
    )
}

/** The camera's own overlay, drawn inside the full-screen modal so no second modal ever stacks over it. */
export function CoachLocalOverlay({ screen }: { screen: ActiveStep['screen'] }): ReactElement | null {
    const coach = useCoach()
    const active = coach?.active
    if (
        coach === null ||
        active === null ||
        active === undefined ||
        active.host !== 'local' ||
        active.screen !== screen
    ) {
        return null
    }
    return <CoachOverlayView step={active} controls={coach} evidenceScene={coach.evidenceScene} />
}

/**
 * One tip: a dim that swallows touches around a cutout, a ring on the real target, a proxy that runs the target's own
 * action, and a bubble with Skip and Next. Everything inside is one accessibility subtree, so a screen reader keeps the
 * taught action and Skip while the covered controls stay out of reach.
 */
export function CoachOverlayView({
    step,
    controls,
    evidenceScene,
    frameRoot,
}: {
    step: ActiveStep
    controls: Controls
    evidenceScene?: string
    frameRoot?: RefObject<ComponentRef<typeof View> | null>
}): ReactElement {
    const owner = coachFrameOwner(useDocumentFrameOwner(), step.candidate)
    const origin = owner?.origin ?? 'shell'
    const { colors, scheme } = useTheme()
    const { reduceMotion } = useFeedback()
    const window = useCoachWindow()
    const insets = useSafeAreaInsets()
    const large = useLargeText()
    const [size, setSize] = useState<{ width: number; height: number } | null>(null)
    const headingRef = useRef<ComponentRef<typeof View>>(null)
    // The tip is drawn in its own overlay window while it is active; the host meter reaches it through this ref.
    const attachMeterRoot = useMeterRoot(headingRef, 'coach')
    const fade = useSharedValue(reduceMotion ? 1 : 0)
    const lift = useSharedValue(reduceMotion ? 1 : 0)
    const [travelling, setTravelling] = useState(false)
    const hole = cutoutOf(step.rect)
    const from = useSharedValue<Rect>(hole)
    const to = useSharedValue<Rect>(hole)
    const travel = useSharedValue(1)
    const priorToken = useRef(step.token)
    useLayoutEffect(() => {
        cancelAnimation(travel)
        const changed = priorToken.current !== step.token
        priorToken.current = step.token
        const p = travel.value
        from.value = rectBetween(from.value, to.value, p)
        to.value = hole
        if (!changed || reduceMotion) {
            travel.value = 1
            setTravelling(false)
            return undefined
        }
        travel.value = 0
        travel.value = withTiming(1, timing(motion.standard))
        setTravelling(true)
        const timer = setTimeout(() => setTravelling(false), motion.standard)
        return (): void => {
            clearTimeout(timer)
            cancelAnimation(travel)
        }
    }, [step.token, hole.x, hole.y, hole.width, hole.height, reduceMotion, from, to, travel])
    const ringStyle = useAnimatedStyle(() => {
        const r = rectBetween(from.value, to.value, travel.value)
        return { left: r.x, top: r.y, width: r.width, height: r.height }
    })
    const topStyle = useAnimatedStyle(() => ({
        left: 0,
        top: 0,
        width: window.width,
        height: Math.max(0, rectBetween(from.value, to.value, travel.value).y),
    }))
    const bottomStyle = useAnimatedStyle(() => {
        const r = rectBetween(from.value, to.value, travel.value)
        return {
            left: 0,
            top: r.y + r.height,
            width: window.width,
            height: Math.max(0, window.height - r.y - r.height),
        }
    })
    const leftStyle = useAnimatedStyle(() => {
        const r = rectBetween(from.value, to.value, travel.value)
        return { left: 0, top: r.y, width: Math.max(0, r.x), height: r.height }
    })
    const rightStyle = useAnimatedStyle(() => {
        const r = rectBetween(from.value, to.value, travel.value)
        return { left: r.x + r.width, top: r.y, width: Math.max(0, window.width - r.x - r.width), height: r.height }
    })
    const last = step.position >= step.total
    const heading = step.candidate.heading
    const spoken = `${large ? '' : step.candidate.heading + '. '}${step.candidate.sentence} Step ${step.position} of ${step.total}.${last ? ' Last tip.' : ''}`

    const placement: Placement | null =
        size === null
            ? null
            : placeBubble({ target: step.rect, bubble: size, window, insets, actionable: step.actionable })

    const proxyPress = usePressMotion(travelling || placement === null)
    const noFit = size !== null && placement === null
    useEffect(() => {
        if (noFit) controls.defer()
    }, [noFit, controls.defer])

    useEffect(() => {
        cancelAnimation(fade)
        cancelAnimation(lift)
        if (reduceMotion) {
            fade.value = 1
            lift.value = 1
        } else {
            fade.value = 0
            lift.value = 0
            fade.value = withTiming(1, timing(motion.fast))
            lift.value = withSpring(1, SPRING_GENTLE)
        }
        return (): void => {
            cancelAnimation(fade)
            cancelAnimation(lift)
        }
    }, [fade, lift, reduceMotion, step.token])

    // Screen readers hear the tip once and land on its heading; the effect is cancelled with the tip.
    useEffect(() => {
        let live = true
        const timer = setTimeout(() => {
            if (!live) return
            AccessibilityInfo.announceForAccessibility?.(spoken)
            const node = headingRef.current
            if (node !== null && typeof AccessibilityInfo.sendAccessibilityEvent === 'function') {
                try {
                    AccessibilityInfo.sendAccessibilityEvent(node, 'focus')
                } catch {
                    return
                }
            }
        }, motion.fast)
        return (): void => {
            live = false
            clearTimeout(timer)
        }
    }, [spoken])

    const dim = scheme === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.35)'
    const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }))
    const bubbleStyle = useAnimatedStyle(() => ({
        opacity: fade.value,
        transform: [{ scale: 0.98 + 0.02 * lift.value }],
    }))
    const maxWidth = bubbleWidth(window, insets, large)
    const maxHeight = bubbleMaxHeight(window, insets, large)
    const onBubbleLayout = (event: LayoutChangeEvent): void => {
        const { width, height } = event.nativeEvent.layout
        setSize((now) =>
            now !== null && Math.abs(now.width - width) < 0.5 && Math.abs(now.height - height) < 0.5
                ? now
                : { width, height },
        )
    }
    // Until the bubble has measured itself it draws invisibly, so it never flashes at a guessed position.
    const place = placement
    const arrow = place?.arrow ?? null
    const panels = [
        { key: 'top', style: topStyle },
        { key: 'bottom', style: bottomStyle },
        { key: 'left', style: leftStyle },
        { key: 'right', style: rightStyle },
    ]
    return (
        <View
            ref={frameRoot}
            testID="coach-overlay"
            nativeID={
                owner === null
                    ? originId('shell')
                    : mergeNativeIds(
                          `truebuild-document-root:${owner.documentId}`,
                          frameRoot === undefined
                              ? undefined
                              : `truebuild-document-content-boundary:${owner.documentId}`,
                          originId(origin),
                      )
            }
            style={styles.root}
            pointerEvents="box-none"
            accessibilityViewIsModal={true}
            importantForAccessibility="yes"
            onAccessibilityEscape={controls.skip}
        >
            <View
                nativeID={originId(origin)}
                testID={evidenceScene === undefined ? undefined : `inert-tour-scene-${evidenceScene}`}
                collapsable={false}
                style={styles.root}
                pointerEvents="box-none"
            >
                <Animated.View
                    style={[styles.root, fadeStyle, place === null && { opacity: 0 }]}
                    pointerEvents={place === null ? 'none' : 'box-none'}
                >
                    {panels.map((panel) => (
                        <Animated.View key={panel.key} style={[styles.panel, panel.style, { backgroundColor: dim }]}>
                            <Pressable
                                accessible={false}
                                accessibilityElementsHidden={true}
                                importantForAccessibility="no"
                                // Swallows the touch so nothing outside the cutout can be hit while a tip is up.
                                onPress={noop}
                                style={StyleSheet.absoluteFill}
                            />
                        </Animated.View>
                    ))}
                    <Animated.View
                        testID="coach-ring"
                        pointerEvents="none"
                        accessibilityElementsHidden={true}
                        importantForAccessibility="no"
                        style={[styles.ring, ringStyle, proxyPress.style, { borderColor: colors.focus }]}
                    />
                    <Pressable
                        testID="coach-target-hole"
                        accessibilityRole={step.actionable ? 'button' : 'text'}
                        accessibilityLabel={step.actionable ? step.label : step.candidate.heading}
                        accessibilityHint={step.actionable ? TARGET_HINT : undefined}
                        onPressIn={proxyPress.onPressIn}
                        onPressOut={proxyPress.onPressOut}
                        disabled={travelling}
                        accessibilityState={{ disabled: travelling }}
                        onPress={controls.activate}
                        style={[styles.hole, { left: hole.x, top: hole.y, width: hole.width, height: hole.height }]}
                    />
                </Animated.View>
                <Animated.View
                    testID="coach-bubble"
                    onLayout={onBubbleLayout}
                    pointerEvents={place === null ? 'none' : 'box-none'}
                    style={[
                        styles.bubble,
                        {
                            width: maxWidth,
                            maxHeight,
                            backgroundColor: colors.surfaceRaised,
                            left: place?.x ?? 0,
                            top: place?.y ?? 0,
                            // Hidden until measured and placed; an actionable tip with no clear spot is withheld.
                            opacity: place === null ? 0 : undefined,
                        },
                        place === null ? undefined : bubbleStyle,
                    ]}
                >
                    {arrow === null || place === null ? null : (
                        <View
                            accessibilityElementsHidden={true}
                            importantForAccessibility="no"
                            style={[
                                styles.arrow,
                                {
                                    backgroundColor: colors.surfaceRaised,
                                    left: arrow.x - ARROW_SIZE / 2,
                                    top: arrow.direction === 'up' ? -ARROW_SIZE / 2 : undefined,
                                    bottom: arrow.direction === 'down' ? -ARROW_SIZE / 2 : undefined,
                                },
                            ]}
                        />
                    )}
                    {large ? null : (
                        <View
                            ref={attachMeterRoot}
                            testID="coach-heading"
                            accessible={true}
                            accessibilityRole="header"
                            nativeID={originId(origin)}
                        >
                            <Heading>{heading}</Heading>
                        </View>
                    )}
                    <ScrollView
                        testID="coach-bubble-scroll"
                        style={styles.scroll}
                        contentContainerStyle={styles.scrollContent}
                        showsVerticalScrollIndicator={true}
                    >
                        <View
                            ref={large ? attachMeterRoot : undefined}
                            testID={large ? 'coach-heading' : undefined}
                            nativeID={originId(origin)}
                        >
                            <Body>{step.candidate.sentence}</Body>
                        </View>
                    </ScrollView>
                    <View
                        testID="coach-dots"
                        accessibilityElementsHidden={true}
                        importantForAccessibility="no"
                        style={styles.dots}
                    >
                        {Array.from({ length: step.total }, (_, index) => (
                            <View
                                key={index}
                                style={[
                                    styles.dot,
                                    {
                                        backgroundColor:
                                            index + 1 === step.position ? colors.focus : colors.borderStrong,
                                    },
                                ]}
                            />
                        ))}
                    </View>
                    <View style={styles.actions}>
                        <View style={styles.action}>
                            <AppButton
                                label="Skip"
                                compact={large}
                                accessibilityLabel="Skip tips"
                                variant="quiet"
                                testID="coach-skip"
                                onPress={controls.skip}
                            />
                        </View>
                        <View style={styles.action}>
                            {last ? (
                                <AppButton
                                    label={large ? 'Done' : 'Got it'}
                                    compact={large}
                                    accessibilityLabel="Got it"
                                    variant="accent"
                                    testID="coach-got-it"
                                    disabled={travelling}
                                    onPress={controls.next}
                                />
                            ) : (
                                <AppButton
                                    label="Next"
                                    compact={large}
                                    variant="secondary"
                                    testID="coach-next"
                                    disabled={travelling}
                                    onPress={controls.next}
                                />
                            )}
                        </View>
                    </View>
                </Animated.View>
            </View>
        </View>
    )
}

function rectBetween(from: Rect, to: Rect, progress: number): Rect {
    'worklet'
    const p = Math.max(0, Math.min(1, progress))
    return {
        x: from.x + (to.x - from.x) * p,
        y: from.y + (to.y - from.y) * p,
        width: from.width + (to.width - from.width) * p,
        height: from.height + (to.height - from.height) * p,
    }
}

function noop(): void {
    return undefined
}

const styles = StyleSheet.create({
    root: { ...StyleSheet.absoluteFill },
    panel: { position: 'absolute' },
    ring: { position: 'absolute', borderWidth: 2, borderRadius: 12 },
    hole: { position: 'absolute', borderRadius: 12 },
    bubble: {
        position: 'absolute',
        borderRadius: radius.md,
        padding: space.md,
        gap: space.sm,
    },
    arrow: {
        position: 'absolute',
        width: ARROW_SIZE,
        height: ARROW_SIZE,
        transform: [{ rotate: '45deg' }],
    },
    scroll: { flexGrow: 0, flexShrink: 1 },
    scrollContent: { paddingBottom: space.xxs },
    dots: { flexDirection: 'row', gap: space.xs, alignItems: 'center', minHeight: space.md },
    dot: { width: space.xs, height: space.xs, borderRadius: radius.pill },
    actions: { flexDirection: 'row', gap: space.xs, minHeight: touchTarget },
    action: { flex: 1 },
})
