import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import { useIsFocused, useNavigation } from 'expo-router'
import { CoachRootOverlay } from './coach-overlay'
import { CoachProvider, CoachScope } from './coach-provider'
import { onboardingStorage } from './coach-storage'
import type { OnboardingScreen } from './coach-types'
import { createOnboardingStore } from './onboarding-store'

/** The app's one coach provider. Its store is the device's own, restored once; screens never wait for it. */
export function AppCoachProvider({ children }: { readonly children: ReactNode }): ReactElement {
    const [store] = useState(() => createOnboardingStore(onboardingStorage))
    useEffect(() => {
        void store.restore()
    }, [store])
    return (
        <CoachProvider
            store={store}
            renderOverlay={(active, controls): ReactElement => <CoachRootOverlay active={active} controls={controls} />}
        >
            {children}
        </CoachProvider>
    )
}

type TransitionEvents = {
    canGoBack: () => boolean
    addListener: (name: string, listener: () => void) => () => void
}

/**
 * A route's tips belong to it only while it is the focused screen and no native transition or swipe-back gesture is
 * moving it. Wrap each route's screen with its key.
 */
export function CoachRoute({
    screen,
    children,
}: {
    readonly screen: OnboardingScreen | null
    readonly children: ReactNode
}): ReactElement {
    const focused = useIsFocused()
    const [appActive, setAppActive] = useState(
        AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
    )
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'))
        return (): void => subscription.remove()
    }, [])
    const navigation = useNavigation() as unknown as Partial<TransitionEvents>
    // A pushed screen can mount before native transitionStart reaches JS. Keep its
    // coach quiet from that first render; native onAppear/transitionEnd releases it.
    // Web's native-stack fallback emits no native appearance events.
    const nativeTransitions = Platform.OS !== 'web'
    const [moving, setMoving] = useState(() => nativeTransitions && navigation.canGoBack?.() === true)
    const latestNavigation = useRef(navigation)
    latestNavigation.current = navigation
    useLayoutEffect(() => {
        if (!nativeTransitions || typeof navigation.addListener !== 'function') return undefined
        const listen = navigation.addListener.bind(navigation)
        const stops = [
            listen('transitionStart', () => setMoving(true)),
            listen('transitionEnd', () => setMoving(false)),
            listen('gestureCancel', () => setMoving(false)),
        ]
        return (): void => stops.forEach((stop) => stop())
    }, [navigation, nativeTransitions])
    useLayoutEffect(() => {
        if (nativeTransitions && focused && latestNavigation.current.canGoBack?.() === true) setMoving(true)
    }, [focused, nativeTransitions])
    return (
        <CoachScope screen={screen} active={focused && !moving && appActive}>
            {children}
        </CoachScope>
    )
}
