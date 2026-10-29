import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { CoachRootOverlay } from '../../features/onboarding/coach-overlay'
import { CoachProvider, CoachScope, useCoach, type CoachContextValue } from '../../features/onboarding/coach-provider'
import type { OnboardingScreen } from '../../features/onboarding/coach-types'
import { createOnboardingStore } from '../../features/onboarding/onboarding-store'
import type { WorkflowPreviewCase } from './workflow-fixtures'

// INERT TOUR FIXTURE: native visual evidence only. The tips run over the gallery's synthetic screens, whose controller
// does nothing, and the record is held in memory, so tapping a tip's target proves layout and never an action, a
// navigation or persistence. Actual delegation, navigation and storage are proved on the real routes instead.
const IN_MEMORY = {
    getItem: async (): Promise<string | null> => null,
    setItem: async (): Promise<void> => undefined,
}

/** The tour screen a gallery fixture stands for, or null where the product has no tour (Reading, Done, Settings). */
export function tourScreenFor(id: WorkflowPreviewCase): OnboardingScreen | null {
    if (id.startsWith('home-') && id !== 'home-unavailable' && id !== 'home-loading' && id !== 'home-error')
        return 'home'
    if (id === 'pages-empty' || id === 'pages-populated') return 'pages'
    if (id.startsWith('review-')) return 'quick-check'
    if (id.startsWith('guide-')) return 'guide'
    if (id === 'camera-page' || id === 'camera-check' || id === 'camera-question') return 'camera'
    return null
}

/** Mounts the real coach over the gallery when `enabled`; otherwise the gallery stays tip-free, as by default. */
export function InertTour({
    enabled,
    screen,
    scene,
    children,
}: {
    readonly enabled: boolean
    readonly screen: OnboardingScreen | null
    readonly scene?: string
    readonly children: ReactNode | ((registry: Pick<CoachContextValue, 'registerTarget'> | null) => ReactNode)
}): ReactElement {
    const [store] = useState(() => createOnboardingStore(IN_MEMORY))
    useEffect(() => {
        if (enabled && screen !== null) void store.restore()
    }, [store, enabled, screen])
    return (
        <CoachProvider
            store={store}
            evidenceScene={scene}
            disabled={!enabled || screen === null}
            renderOverlay={(active, controls): ReactElement => (
                <CoachRootOverlay active={active} controls={controls} evidenceScene={scene} />
            )}
        >
            <CoachScope screen={screen}>
                <InertContent>{children}</InertContent>
            </CoachScope>
        </CoachProvider>
    )
}

function InertContent({
    children,
}: {
    readonly children: ReactNode | ((registry: Pick<CoachContextValue, 'registerTarget'> | null) => ReactNode)
}): ReactElement {
    const coach = useCoach()
    return <>{typeof children === 'function' ? children(coach) : children}</>
}
