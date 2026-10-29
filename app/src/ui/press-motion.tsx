import type { ReactElement } from 'react'
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { useFeedback } from './feedback'
import { SPRING_GENTLE } from './motion'

/** How far an action gives under the finger. */
export const PRESS_SCALE = 0.97
const PRESS_FADE = 0.8

export const MotionPressable = Animated.createAnimatedComponent(Pressable)

/**
 * The one press feel for actions: the app's one gentle spring to 0.97 and a slight fade, driven on the UI thread. Under reduced motion
 * nothing scales; the fade alone answers the press, set instantly. A resting opacity lets a disabled control keep its
 * dimmed look, because the animated opacity replaces the static one.
 */
export function usePressMotion(
    inactive: boolean,
    restOpacity = 1,
): {
    readonly style: ReturnType<typeof useAnimatedStyle>
    readonly onPressIn: () => void
    readonly onPressOut: () => void
} {
    const { reduceMotion } = useFeedback()
    const pressed = useSharedValue(0)
    // Plain numbers captured by the worklet below; it calls no other function.
    const shrink = reduceMotion ? 0 : 1 - PRESS_SCALE
    const fade = 1 - PRESS_FADE
    const style = useAnimatedStyle(() => ({
        opacity: restOpacity * (1 - pressed.value * fade),
        transform: [{ scale: 1 - pressed.value * shrink }],
    }))
    const move = (to: 0 | 1): void => {
        if (reduceMotion) {
            cancelAnimation(pressed)
            pressed.value = to
        } else {
            pressed.value = withSpring(to, SPRING_GENTLE)
        }
    }
    return {
        style,
        onPressIn: (): void => {
            if (!inactive) {
                move(1)
            }
        },
        onPressOut: (): void => move(0),
    }
}

/** A pressable row or control with the shared press feel. Backdrops and photo canvases keep a plain Pressable. */
export function PressMotion({
    style,
    disabled = false,
    ...props
}: Omit<PressableProps, 'style'> & { readonly style?: StyleProp<ViewStyle> }): ReactElement {
    const motion = usePressMotion(disabled)
    return (
        <MotionPressable
            {...props}
            disabled={disabled}
            onPressIn={motion.onPressIn}
            onPressOut={motion.onPressOut}
            style={[style, motion.style]}
        />
    )
}
