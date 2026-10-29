import { useEffect, useLayoutEffect, useRef } from 'react'
import {
    cancelAnimation,
    Easing,
    interpolate,
    ReduceMotion,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withSpring,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated'
import { motion, space } from '../theme/tokens'
import { useFeedback } from './feedback'

/** The one timing curve. No ease-in, bounce or elastic curve exists in this app. */
export const EASE_OUT = Easing.out(Easing.cubic)

/**
 * The one spring. Reanimated multiplies a duration-based spring's perceptual duration by 1.5 when it solves for
 * stiffness, so dividing the emphasis budget by 1.5 targets about 350 ms of real settling. Critically damped and
 * clamped, so nothing overshoots. `ReduceMotion.System` makes the platform's own Reduce Motion resolve it at once.
 */
export const SPRING_GENTLE = {
    duration: motion.emphasis / 1.5,
    dampingRatio: 1,
    overshootClamping: true,
    reduceMotion: ReduceMotion.System,
} as const

/** A cubic ease-out timing config for one of the three durations. */
export function timing(duration: number): {
    readonly duration: number
    readonly easing: typeof EASE_OUT
    readonly reduceMotion: ReduceMotion
} {
    return { duration, easing: EASE_OUT, reduceMotion: ReduceMotion.System }
}

/** How far a step's picture and sentence travel together when the step changes. */
export const STEP_TRAVEL = 16

type EntranceStyle = ReturnType<typeof useAnimatedStyle>

/** Signed distance the incoming step starts from: later steps arrive from ahead, earlier ones from behind, none reduced. */
export function stepTravel(direction: number, reduceMotion: boolean): number {
    return reduceMotion ? 0 : STEP_TRAVEL * (direction < 0 ? -1 : 1)
}

/**
 * One shared transform for everything that belongs to a step: the picture, its overlays and the instruction. They use
 * the same value, so they can never slide apart. A key change moves them in from the side the step lies on (`direction`
 * +1 for a later step, -1 for an earlier one). While `enabled` is false (pending work, a sheet, a tour, a blurred
 * screen) or under reduced motion the change is applied instantly and no stale entrance is ever replayed.
 */
export function useStepTransition(stepKey: string, direction: number, enabled: boolean): EntranceStyle {
    const { reduceMotion } = useFeedback()
    const progress = useSharedValue(1)
    const lastKey = useRef(stepKey)
    const travel = useSharedValue(0)
    useEffect(() => {
        const changed = lastKey.current !== stepKey
        lastKey.current = stepKey
        cancelAnimation(progress)
        if (changed && enabled) {
            travel.value = stepTravel(direction, reduceMotion)
            progress.value = 0
            progress.value = withTiming(1, timing(reduceMotion ? motion.fast : motion.standard))
        } else {
            progress.value = 1
        }
        return (): void => cancelAnimation(progress)
    }, [stepKey, enabled, reduceMotion, progress, travel])
    return useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateX: interpolate(progress.value, [0, 1], [reduceMotion ? 0 : travel.value, 0]) }],
    }))
}

/**
 * The result icon's single reveal: it scales 0.8 to 1 with the one gentle spring and fades in at `fast`, once per
 * result identity for this app session. A revisit, More or a re-render finds the identity already revealed and shows
 * the icon at rest. Reduced motion shows it at rest at once.
 */
export function useIconReveal(identity: string, enabled: boolean): EntranceStyle {
    const { reduceMotion, revealOnce } = useFeedback()
    const progress = useSharedValue(1)
    useEffect(() => {
        cancelAnimation(progress)
        // The identity is spent the first time it is seen, played or not: an icon that arrives while a tip, a sheet or
        // pending work holds the screen still is shown at rest and never replayed later.
        const first = revealOnce(identity)
        if (first && enabled && !reduceMotion) {
            progress.value = 0
            progress.value = withSpring(1, SPRING_GENTLE)
        } else {
            progress.value = 1
        }
        return (): void => {
            cancelAnimation(progress)
            progress.value = 1
        }
    }, [identity, enabled, reduceMotion, revealOnce, progress])
    return useAnimatedStyle(() => ({
        opacity: Math.min(1, progress.value * (motion.emphasis / motion.fast)),
        transform: [{ scale: interpolate(progress.value, [0, 1], [0.8, 1]) }],
    }))
}

/**
 * A single coordinated emphasis timeline (0 to 1) for a cold entrance. `play` starts it once; the groups read it
 * through `entranceGroup`. Reduced motion collapses it to one `fast` fade with no travel.
 */
export function useEntranceTimeline(play: boolean, enabled = true): SharedValue<number> {
    const { reduceMotion } = useFeedback()
    const timeline = useSharedValue(1)
    const started = useRef(false)
    useLayoutEffect(() => {
        cancelAnimation(timeline)
        if (!enabled || started.current) {
            if (play) started.current = true
            timeline.value = 1
            return undefined
        }
        if (!play) return undefined
        started.current = true
        timeline.value = 0
        timeline.value = withTiming(1, timing(reduceMotion ? motion.fast : motion.emphasis))
        return (): void => {
            cancelAnimation(timeline)
            timeline.value = 1
        }
    }, [play, enabled, reduceMotion, timeline])
    return timeline
}

/**
 * A group's opacity and 4 point rise along the shared timeline, staged between `from` and `to` (0..1). Reduced motion
 * has no staging and no rise: every group fades with the single `fast` timeline.
 */
export function useEntranceGroup(
    timeline: SharedValue<number>,
    from: number,
    to: number,
    rise: boolean,
): EntranceStyle {
    const { reduceMotion } = useFeedback()
    const start = reduceMotion ? 0 : from
    const end = reduceMotion ? 1 : to
    const lift = rise && !reduceMotion ? space.xxs : 0
    return useAnimatedStyle(() => {
        const t = Math.min(1, Math.max(0, (timeline.value - start) / (end - start)))
        return { opacity: t, transform: [{ translateY: (1 - t) * lift }] }
    })
}

/**
 * A screen that mounts with its content ready: one group fades in with a 4 point rise, once per mount, at `standard`.
 * Reduced motion is a single `fast` fade. `enabled` false (the screen is covered, working or a tip owns attention)
 * shows the content at rest and never plays a stale entrance later. The header and bottom bar never take part.
 */
export function useLoadEntrance(enabled: boolean): EntranceStyle {
    const { reduceMotion } = useFeedback()
    const progress = useSharedValue(1)
    const played = useRef(false)
    useLayoutEffect(() => {
        cancelAnimation(progress)
        const first = !played.current
        played.current = true
        if (first && enabled) {
            progress.value = 0
            progress.value = withTiming(1, timing(reduceMotion ? motion.fast : motion.standard))
        } else {
            progress.value = 1
        }
        return (): void => cancelAnimation(progress)
    }, [enabled, reduceMotion, progress])
    const lift = reduceMotion ? 0 : space.xxs
    return useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: (1 - progress.value) * lift }],
    }))
}

/** One leg of the Reading indicator's calm loop, derived from the emphasis duration. */
export const READING_LEG = motion.emphasis * 2

/**
 * The Reading screen's single ambient loop: a gentle opacity breath on the UI thread, using only the ease-out curve.
 * It runs while `running` and is cancelled the moment it stops, on unmount and under reduced motion (full strength).
 */
export function useReadingLoop(running: boolean): EntranceStyle {
    const { reduceMotion } = useFeedback()
    const breath = useSharedValue(1)
    useEffect(() => {
        cancelAnimation(breath)
        if (!running || reduceMotion) {
            breath.value = 1
            return undefined
        }
        breath.value = withRepeat(
            withSequence(withTiming(0.4, timing(READING_LEG)), withTiming(1, timing(READING_LEG))),
            -1,
            false,
        )
        return (): void => {
            cancelAnimation(breath)
            breath.value = 1
        }
    }, [running, reduceMotion, breath])
    return useAnimatedStyle(() => ({ opacity: breath.value }))
}

/** A content state changes in place; native navigation and busy/suppressed states always win over its one fast fade. */
export function useContentFade(key: string, enabled: boolean): EntranceStyle {
    const { reduceMotion } = useFeedback()
    const progress = useSharedValue(1)
    const previous = useRef<string | null>(null)
    useLayoutEffect(() => {
        const changed = previous.current !== key
        previous.current = key
        cancelAnimation(progress)
        if (changed && enabled && !reduceMotion) {
            progress.value = 0
            progress.value = withTiming(1, timing(motion.fast))
        } else {
            progress.value = 1
        }
        return (): void => cancelAnimation(progress)
    }, [key, enabled, reduceMotion, progress])
    return useAnimatedStyle(() => ({ opacity: progress.value }))
}
