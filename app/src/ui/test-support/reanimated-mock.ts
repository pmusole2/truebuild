// Jest-only stand-in for the react-native-reanimated APIs the UI uses. Reanimated's native runtime cannot load under
// Jest's web-resolved module graph, so this records intent instead: which animation was requested, whether it was
// cancelled on unmount, and what the static style resolves to. It proves no timing and no native motion.
import { useState } from 'react'
import { View } from 'react-native'

export const spies = {
    withRepeat: jest.fn((animation: number, _repetitions?: number, _reverse?: boolean): number => animation),
    withTiming: jest.fn((toValue: number): number => toValue),
    cancelAnimation: jest.fn((_value: unknown): void => undefined),
}

export function useSharedValue<T>(initial: T): { value: T } {
    const [shared] = useState(() => ({ value: initial }))
    return shared
}

export function useAnimatedStyle<T extends object>(update: () => T): T {
    return update()
}

export function withSequence(...values: number[]): number {
    return values[values.length - 1] ?? 0
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

export const { withRepeat, withTiming, cancelAnimation } = spies

export default { View }
