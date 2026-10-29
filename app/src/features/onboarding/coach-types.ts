import type { OnboardingScreen, createOnboardingStore } from './onboarding-store'

export type { OnboardingScreen }
export type OnboardingStore = ReturnType<typeof createOnboardingStore>

export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** A control is something the person taps; a surface is a picture the tip only points at. */
export type CoachKind = 'control' | 'surface'

/** One tip a screen could show now. `id` is the target registered by the owner of the real control. */
export type CoachCandidate = {
    readonly id: string
    readonly kind: CoachKind
    readonly heading: string
    readonly sentence: string
}

/** Which overlay host draws the tip: the shared window overlay, or the screen's own (the full-screen camera). */
export type CoachHost = 'root' | 'local'

export type CoachReport = {
    readonly focused: boolean
    // True while anything makes the screen unfit for a tip: pending work, loading, a sheet, a keyboard, a transition.
    readonly suppressed: boolean
    readonly candidates: readonly CoachCandidate[]
    readonly host: CoachHost
}

export type ActiveStep = {
    readonly token: number
    readonly screen: OnboardingScreen
    readonly host: CoachHost
    readonly candidate: CoachCandidate
    readonly rect: Rect
    readonly label: string
    // The real action exists (a control). A surface advances only.
    readonly actionable: boolean
    readonly position: number
    readonly total: number
}
