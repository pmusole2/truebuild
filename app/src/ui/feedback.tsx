import { createContext, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { AccessibilityInfo } from 'react-native'

// Haptic intents the UI asks for. A device adapter maps them to native patterns; the default adapter does nothing, so
// nothing vibrates until an adapter is injected at integration.
export type HapticKind = 'selection' | 'success' | 'warning'

// Adapters may complete asynchronously (device haptic engines return promises). A rejection is absorbed by useFeedback.
export type HapticPort = {
    readonly trigger: (kind: HapticKind) => void | Promise<void>
}

export const noopHaptics: HapticPort = {
    trigger: (): void => undefined,
}

type FeedbackContextValue = {
    readonly haptics: HapticPort
    // null means "follow the system setting"; a boolean is an explicit override for previews and tests.
    readonly reduceMotionOverride: boolean | null
}

const FeedbackContext = createContext<FeedbackContextValue>({ haptics: noopHaptics, reduceMotionOverride: null })

/**
 * Tracks the system reduce-motion setting. Until the system answers, motion counts as reduced, so no animation starts
 * before the user's preference is known.
 */
export function useSystemReduceMotion(): boolean {
    const [reduced, setReduced] = useState(true)
    useEffect(() => {
        let active = true
        void AccessibilityInfo.isReduceMotionEnabled().then((value: boolean): void => {
            if (active) {
                setReduced(value)
            }
        })
        const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value: boolean): void => {
            setReduced(value)
        })
        return (): void => {
            active = false
            subscription.remove()
        }
    }, [])
    return reduced
}

export function FeedbackProvider({
    haptics = noopHaptics,
    reduceMotion = null,
    children,
}: {
    readonly haptics?: HapticPort
    readonly reduceMotion?: boolean | null
    readonly children: ReactNode
}): ReactElement {
    const value = useMemo(
        (): FeedbackContextValue => ({ haptics, reduceMotionOverride: reduceMotion }),
        [haptics, reduceMotion],
    )
    return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>
}

export type Feedback = {
    readonly haptic: (kind: HapticKind) => void
    readonly reduceMotion: boolean
}

export function useFeedback(): Feedback {
    const { haptics, reduceMotionOverride } = useContext(FeedbackContext)
    const system = useSystemReduceMotion()
    return useMemo((): Feedback => {
        const haptic = (kind: HapticKind): void => {
            // Feedback is best-effort: neither a synchronous throw nor a rejected promise may block the action it accompanies.
            try {
                void Promise.resolve(haptics.trigger(kind)).catch((): void => undefined)
            } catch {
                return
            }
        }
        return { haptic, reduceMotion: reduceMotionOverride ?? system }
    }, [haptics, reduceMotionOverride, system])
}
