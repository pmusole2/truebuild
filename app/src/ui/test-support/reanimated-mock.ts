// Jest-only stand-in for the react-native-reanimated APIs the UI uses. Reanimated's native runtime cannot load under
// Jest's web-resolved module graph, so this records intent instead: which animation was requested, whether it was
// cancelled on unmount, and what the static style resolves to. It proves no timing and no native motion.
import { createElement, useState, type ComponentType } from 'react'
import { View } from 'react-native'

export const spies = {
    withRepeat: jest.fn((animation: number, _repetitions?: number, _reverse?: boolean): number => animation),
    withTiming: jest.fn((toValue: number, _config?: { duration?: number }): number => toValue),
    withSequence: jest.fn((...values: number[]): number => values[values.length - 1] ?? 0),
    withSpring: jest.fn((toValue: number, _config?: object): number => toValue),
    cancelAnimation: jest.fn((_value: unknown): void => undefined),
}

export function useSharedValue<T>(initial: T): { value: T } {
    const [shared] = useState(() => ({ value: initial }))
    return shared
}

export function useAnimatedStyle<T extends object>(update: () => T): T {
    return update()
}

// Evaluated at render, like useAnimatedStyle: a test reads what the animation drove by rendering again.
export function useAnimatedProps<T extends object>(update: () => T): T {
    return update()
}

// Merges the animated props into the wrapped component's own props, so a test can read what they were bound to.
export function createAnimatedComponent<P extends object>(
    Component: ComponentType<P>,
): ComponentType<P & { animatedProps?: Partial<P> }> {
    return function AnimatedStandIn({ animatedProps, ...props }: P & { animatedProps?: Partial<P> }) {
        return createElement(Component, { ...(props as P), ...animatedProps })
    }
}

export function interpolate(value: number, input: readonly number[], output: readonly number[]): number {
    const [inStart = 0, inEnd = 1] = input
    const [outStart = 0, outEnd = 1] = output
    if (inEnd === inStart) {
        return outEnd
    }
    return outStart + ((value - inStart) / (inEnd - inStart)) * (outEnd - outStart)
}

const identity = <T>(value: T): T => value

export const Easing = {
    ease: identity,
    cubic: identity,
    inOut: <T>(easing: T): T => easing,
    out: <T>(easing: T): T => easing,
}

export enum ReduceMotion {
    System = 'system',
    Always = 'always',
    Never = 'never',
}

export const { withRepeat, withTiming, withSequence, withSpring, cancelAnimation } = spies

export default { View, createAnimatedComponent }
