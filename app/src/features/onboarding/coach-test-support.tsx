import { fireEvent, screen, waitFor } from '@testing-library/react-native'
// Test-only harness for the coach: an in-memory onboarding storage, a fake measurer and a provider wired to the real
// overlay. Nothing here touches AsyncStorage, a controller or the network.
import { useState, type ReactElement, type ReactNode } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider, type HapticPort } from '../../ui/feedback'
import { CoachOverlayView } from './coach-overlay'
import { CoachProvider, CoachScope, type TargetHandle } from './coach-provider'
import type { OnboardingScreen, OnboardingStore, Rect } from './coach-types'
import { createOnboardingStore, ONBOARDING_STORAGE_KEY, type OnboardingStorage } from './onboarding-store'

export type MemoryStorage = OnboardingStorage & {
    readonly data: Map<string, string>
    readonly writes: string[]
}

export function memoryStorage(initial: readonly OnboardingScreen[] = []): MemoryStorage {
    const data = new Map<string, string>()
    const writes: string[] = []
    if (initial.length > 0) {
        data.set(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: 1, seen: initial }))
    }
    return {
        data,
        writes,
        getItem: async (key: string): Promise<string | null> => data.get(key) ?? null,
        setItem: async (key: string, value: string): Promise<void> => {
            writes.push(key)
            data.set(key, value)
        },
    }
}

export async function readyStore(initial: readonly OnboardingScreen[] = []): Promise<{
    store: OnboardingStore
    storage: MemoryStorage
}> {
    const storage = memoryStorage(initial)
    const store = createOnboardingStore(storage)
    await store.restore()
    return { store, storage }
}

// Every control is a comfortable size inside a 390 by 844 window; tests override the entries they care about.
export const RECTS: Record<string, Rect> = {
    'home-add': { x: 16, y: 730, width: 358, height: 56 },
    'keep-building': { x: 16, y: 730, width: 358, height: 56 },
    'header-more': { x: 330, y: 50, width: 44, height: 44 },
    'take-page-photo': { x: 16, y: 730, width: 358, height: 56 },
    'choose-pages': { x: 16, y: 670, width: 358, height: 44 },
    'read-manual': { x: 16, y: 730, width: 358, height: 56 },
    'add-page': { x: 16, y: 670, width: 358, height: 44 },
    'quick-check-fix': { x: 16, y: 730, width: 358, height: 56 },
    'quick-check-skip': { x: 16, y: 670, width: 358, height: 44 },
    'quick-check-clearer': { x: 16, y: 730, width: 358, height: 56 },
    'quick-check-start': { x: 16, y: 730, width: 358, height: 56 },
    'guide-hero': { x: 0, y: 100, width: 390, height: 464 },
    'guide-hero-frame': { x: 0, y: 100, width: 390, height: 464 },
    'guide-primary': { x: 16, y: 730, width: 358, height: 56 },
    'camera-shutter': { x: 157, y: 700, width: 76, height: 76 },
}

/** Measures a registered target by its test ID. Targets register with their test ID as the label unless told otherwise. */
export function fakeMeasure(
    rects: Record<string, Rect | null> = RECTS,
): (handle: TargetHandle) => Promise<Rect | null> {
    return async (handle) => rects[handle.label] ?? null
}

export function CoachHarness({
    store,
    screen = 'home',
    focused = true,
    measure = fakeMeasure(),
    disabled = false,
    reduceMotion = true,
    haptics,
    settleMs = 5,
    children,
}: {
    readonly store: OnboardingStore
    readonly screen?: OnboardingScreen
    readonly focused?: boolean
    readonly measure?: (handle: TargetHandle) => Promise<Rect | null>
    readonly disabled?: boolean
    readonly reduceMotion?: boolean
    readonly haptics?: HapticPort
    readonly settleMs?: number
    readonly children: ReactNode
}): ReactElement {
    return (
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: ZERO }}>
            <ThemeProvider>
                <FeedbackProvider reduceMotion={reduceMotion} haptics={haptics}>
                    <CoachProvider
                        store={store}
                        disabled={disabled}
                        settleMs={settleMs}
                        measure={measure}
                        renderOverlay={(active, controls): ReactElement => (
                            <CoachOverlayView step={active} controls={controls} />
                        )}
                    >
                        <CoachScope screen={screen} active={focused}>
                            {children}
                        </CoachScope>
                    </CoachProvider>
                </FeedbackProvider>
            </ThemeProvider>
        </SafeAreaProvider>
    )
}

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 }

/** A stateful host so a test can flip suppression and focus the way a screen's own state would. */
export function useToggle(initial: boolean): [boolean, () => void] {
    const [value, setValue] = useState(initial)
    return [value, (): void => setValue((now) => !now)]
}

// React Native's onLayout is an OS boundary that the test renderer does not dispatch. Simulate the settled bubble
// before tapping it; layout/placement edge cases dispatch their own real sizes instead of using this fixture.
export async function layoutCoachBubble(): Promise<void> {
    const bubble = screen.queryByTestId('coach-bubble')
    if (bubble !== null) {
        await fireEvent(bubble, 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 220 } },
        })
    }
}

export async function pressCoach(id: string): Promise<void> {
    await layoutCoachBubble()
    await waitFor(() => expect(screen.getByTestId(id)).toBeEnabled())
    await fireEvent.press(screen.getByTestId(id))
}
