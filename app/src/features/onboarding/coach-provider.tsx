import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
    type ComponentRef,
    type ReactElement,
    type ReactNode,
    type RefObject,
} from 'react'
import { AccessibilityInfo, AppState, BackHandler, Platform, StatusBar, View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useCoachWindow } from './coach-window'
import { useFeedback } from '../../ui/feedback'
import { touchTarget } from '../../theme/tokens'
import { validRect } from './coach-placement'
import { tipsSkippedByLaunchUrl, tipsSkippedSynchronously } from './coach-skip'
import type {
    ActiveStep,
    CoachCandidate,
    CoachHost,
    CoachReport,
    OnboardingScreen,
    OnboardingStore,
    Rect,
} from './coach-types'
import { ONBOARDING_SCREENS } from './onboarding-store'

/** What a registered target gives the tour: the node to measure and the exact action the real control runs. */
export type TargetHandle = {
    readonly ref: RefObject<ComponentRef<typeof View> | null>
    readonly onPress?: () => void
    readonly label: string
}

type Measure = (handle: TargetHandle) => Promise<Rect | null>

/** Real measurement. A node that never answers resolves null, so a missing anchor never wedges the tour. */
export const measureInWindow: Measure = (handle) =>
    new Promise((resolve) => {
        const node = handle.ref.current
        if (node === null) {
            resolve(null)
            return
        }
        const timer = setTimeout(() => resolve(null), 500)
        try {
            node.measureInWindow((x, y, width, height) => {
                clearTimeout(timer)
                // Android measures from the app content window; both full-screen coach hosts include the status area.
                // Keep native header, body and camera targets in the same screen coordinate space.
                resolve({ x, y: y + (Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0), width, height })
            })
        } catch {
            clearTimeout(timer)
            resolve(null)
        }
    })

export type CoachContextValue = {
    readonly registerTarget: (key: string, handle: () => TargetHandle) => () => void
    readonly report: (screen: OnboardingScreen, report: CoachReport) => void
    readonly clearReport: (screen: OnboardingScreen) => void
    readonly active: ActiveStep | null
    readonly evidenceScene: string | undefined
    readonly next: () => void
    readonly skip: () => void
    readonly activate: () => void
    readonly defer: () => void
    readonly showTipsAgain: () => void
    readonly hideForTesting: () => void
}

const CoachContext = createContext<CoachContextValue | null>(null)

// The screen a subtree belongs to, and whether its route is the focused one and not mid-transition.
const ScopeContext = createContext<{ readonly screen: OnboardingScreen | null; readonly active: boolean }>({
    screen: null,
    active: true,
})

export function useCoach(): CoachContextValue | null {
    return useContext(CoachContext)
}

/** True while a tip is on screen: the underlying screen's own motion holds still. */
export function useCoachAttention(): boolean {
    return useContext(CoachContext)?.active != null
}

/** Marks a subtree as one screen's, so its bar actions register under that screen. */
export function CoachScope({
    screen,
    active = true,
    children,
}: {
    readonly screen: OnboardingScreen | null
    // False while the route is blurred or in a native transition.
    readonly active?: boolean
    readonly children: ReactNode
}): ReactElement {
    const value = useMemo(() => ({ screen, active }), [screen, active])
    return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export function useCoachScope(): { readonly screen: OnboardingScreen | null; readonly active: boolean } {
    return useContext(ScopeContext)
}

/**
 * Registers a real control as a tip target. `onPress` is read at the moment a tip's target is tapped, so the registry
 * always runs the same function the control itself would. Without a provider or a screen it renders its children alone.
 */
export function CoachTarget({
    id,
    screen: screenProp,
    label,
    onPress,
    style,
    registry,
    children,
}: {
    readonly id: string
    readonly screen?: OnboardingScreen | null
    readonly label: string
    readonly onPress?: () => void
    readonly style?: ViewStyle
    readonly registry?: Pick<CoachContextValue, 'registerTarget'> | null
    readonly children: ReactNode
}): ReactElement {
    const inherited = useContext(CoachContext)
    const coach = registry ?? inherited
    const scope = useContext(ScopeContext)
    const screen = screenProp ?? scope.screen
    const ref = useRef<ComponentRef<typeof View>>(null)
    const latest = useRef({ label, onPress })
    latest.current = { label, onPress }
    const register = coach?.registerTarget
    useEffect(() => {
        if (register === undefined || screen === null) {
            return undefined
        }
        return register(`${screen}:${id}`, (): TargetHandle => ({ ref, ...latest.current }))
    }, [register, screen, id])
    if (coach === null || screen === null) {
        return <>{children}</>
    }
    return (
        <View ref={ref} collapsable={false} style={style}>
            {children}
        </View>
    )
}

/**
 * A screen reports what it could teach right now and whether it is fit to teach it. The provider decides when, and
 * never changes a controller or any manual state.
 */
export function useCoachScreen(
    screen: OnboardingScreen,
    input: { readonly suppressed: boolean; readonly candidates: readonly CoachCandidate[]; readonly host?: CoachHost },
): void {
    const coach = useContext(CoachContext)
    const scope = useContext(ScopeContext)
    const report = coach?.report
    const clearReport = coach?.clearReport
    const signature = JSON.stringify(input.candidates)
    const candidates = useRef(input.candidates)
    candidates.current = input.candidates
    const host = input.host ?? 'root'
    useEffect(() => {
        report?.(screen, {
            focused: scope.active,
            suppressed: input.suppressed,
            candidates: candidates.current,
            host,
        })
    }, [report, screen, scope.active, input.suppressed, signature, host])
    useEffect(() => (): void => clearReport?.(screen), [clearReport, screen])
}

function reducer(count: number): number {
    return count + 1
}

export type CoachProviderProps = {
    readonly store: OnboardingStore
    readonly children: ReactNode
    // No reads, no writes, no tips. Previews and fixtures use this.
    readonly disabled?: boolean
    // Development-only inert fixture identity; never shown as product copy.
    readonly evidenceScene?: string
    // Wait after a screen becomes eligible, so a native transition has finished. 350 ms in the app.
    readonly settleMs?: number
    readonly measure?: Measure
    // Draws the active tip. The app passes its overlay; the provider owns only when a tip may show.
    readonly renderOverlay?: (
        active: ActiveStep,
        controls: Pick<CoachContextValue, 'next' | 'skip' | 'activate' | 'defer'>,
    ) => ReactNode
}

export const SETTLE_MS = 350

/**
 * One tour at a time, owned here. A screen's tip shows only when its route is focused and settled, nothing on it is
 * working or covered, the app is active and its record says unseen. Every asynchronous step carries a generation so a
 * stale measurement can never show a tip for a state that has gone. Saving "seen" is in-memory first and never awaited,
 * so no action ever waits for storage.
 */
export function CoachProvider({
    store,
    children,
    disabled = false,
    evidenceScene,
    settleMs = SETTLE_MS,
    measure = measureInWindow,
    renderOverlay,
}: CoachProviderProps): ReactElement {
    const { haptic } = useFeedback()
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const window = useCoachWindow()
    const insets = useSafeAreaInsets()
    const [appActive, setAppActive] = useState(
        AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
    )
    const [hidden, setHidden] = useState(false)
    const [urlSkip, setUrlSkip] = useState(tipsSkippedSynchronously)
    const [active, setActive] = useState<ActiveStep | null>(null)
    const [runTick, rerun] = useReducer(reducer, 0)

    const targets = useRef(new Map<string, () => TargetHandle>())
    const [reports, setReports] = useState<ReadonlyMap<OnboardingScreen, CoachReport>>(() => new Map())
    const reportsRef = useRef(reports)
    reportsRef.current = reports
    // Candidate ids already taught on a screen this tour; kept across pauses, cleared on completion or reset.
    const shown = useRef(new Map<OnboardingScreen, Set<string>>())
    const generation = useRef(0)
    const token = useRef(0)
    const latch = useRef({ token: -1, consumed: false })
    const resumeNow = useRef(false)
    const activeRef = useRef<ActiveStep | null>(null)
    activeRef.current = active
    useEffect(
        () => (): void => {
            generation.current += 1
            activeRef.current = null
        },
        [],
    )

    const tipsOff = disabled || hidden || urlSkip
    useEffect(() => {
        if (disabled) return undefined
        let live = true
        void tipsSkippedByLaunchUrl().then((value) => {
            if (live && value) setUrlSkip(true)
        })
        return (): void => {
            live = false
        }
    }, [disabled])
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (next) => setAppActive(next === 'active'))
        return (): void => subscription.remove()
    }, [])

    const registerTarget = useCallback((key: string, handle: () => TargetHandle): (() => void) => {
        targets.current.set(key, handle)
        return (): void => {
            if (targets.current.get(key) === handle) {
                targets.current.delete(key)
            }
        }
    }, [])
    const report = useCallback((screen: OnboardingScreen, next: CoachReport): void => {
        setReports((previous) => {
            const before = previous.get(screen)
            if (before !== undefined && sameReport(before, next)) return previous
            return new Map(previous).set(screen, next)
        })
    }, [])
    const clearReport = useCallback((screen: OnboardingScreen): void => {
        setReports((previous) => {
            if (!previous.has(screen)) return previous
            const copy = new Map(previous)
            copy.delete(screen)
            return copy
        })
    }, [])

    const seen = snapshot.seen
    const eligible = useMemo((): OnboardingScreen | null => {
        if (tipsOff || !snapshot.ready || !appActive) return null
        for (const screen of ONBOARDING_SCREENS) {
            const current = reports.get(screen)
            if (
                current !== undefined &&
                current.focused &&
                !current.suppressed &&
                current.candidates.length > 0 &&
                !seen.includes(screen)
            ) {
                return screen
            }
        }
        return null
    }, [tipsOff, snapshot.ready, appActive, seen, reports])

    // A reset forgets this tour's place; the screen then offers its tips again once it is eligible.
    const epoch = useRef(snapshot.resetEpoch)
    useEffect(() => {
        if (epoch.current !== snapshot.resetEpoch) {
            epoch.current = snapshot.resetEpoch
            shown.current.clear()
            resumeNow.current = false
            rerun()
        }
    }, [snapshot.resetEpoch])

    const geometry = `${window.width}x${window.height}:${window.fontScale}:${insets.top}:${insets.right}:${insets.bottom}:${insets.left}`
    const liveReport = eligible === null ? undefined : reports.get(eligible)

    useEffect(() => {
        generation.current += 1
        const mine = generation.current
        const continuing = resumeNow.current && activeRef.current?.screen === eligible
        if (!continuing || eligible === null) {
            activeRef.current = null
            setActive(null)
        }
        if (eligible === null) {
            return undefined
        }
        const screen = eligible
        const settle = resumeNow.current ? 0 : settleMs
        resumeNow.current = false
        const timer = setTimeout(() => {
            void (async (): Promise<void> => {
                const current = reportsRef.current.get(screen)
                if (current === undefined) return
                const taught = shown.current.get(screen) ?? new Set<string>()
                const remaining = current.candidates.filter((candidate) => !taught.has(candidate.id))
                const size = { width: window.width, height: window.height }
                const measured = await Promise.all(
                    remaining.map(async (candidate) => {
                        const handle = targets.current.get(`${screen}:${candidate.id}`)?.()
                        if (handle === undefined) return null
                        const rect = await measure(handle)
                        return validRect(rect, size, insets, candidate.kind, touchTarget)
                            ? { candidate, rect, label: handle.label }
                            : null
                    }),
                )
                // A focus, suppression, size or reset change since this began makes the answer stale: drop it.
                if (mine !== generation.current) return
                const queue = measured.filter((entry) => entry !== null)
                const first = queue[0]
                if (first === undefined) {
                    activeRef.current = null
                    setActive(null)
                    // Everything this screen could teach has been taught or cannot be shown at all: it is done.
                    if (remaining.length > 0 && taught.size > 0) return
                    if (taught.size > 0 && remaining.length === 0) {
                        finish(screen)
                    }
                    return
                }
                token.current += 1
                latch.current = { token: token.current, consumed: false }
                setActive({
                    token: token.current,
                    screen,
                    host: current.host,
                    candidate: first.candidate,
                    rect: first.rect,
                    label: first.label,
                    actionable: first.candidate.kind === 'control',
                    position: taught.size + 1,
                    total: taught.size + queue.length,
                })
            })()
        }, settle)
        return (): void => {
            clearTimeout(timer)
            generation.current += 1
        }
        // Live candidate changes also invalidate copy and geometry, even if the screen and target id stay the same.
    }, [eligible, liveReport, geometry, runTick, settleMs, measure])

    // A visible tip whose target left the screen (or whose candidate the screen withdrew) ends quietly and the tour
    // moves on; it never lingers pointing at nothing.
    const stillOffered =
        active === null || reports.get(active.screen)?.candidates.some((c) => c.id === active.candidate.id) === true
    useEffect(() => {
        if (!stillOffered) {
            resumeNow.current = true
            rerun()
        }
    }, [stillOffered])

    const finish = useCallback(
        (screen: OnboardingScreen): void => {
            shown.current.delete(screen)
            generation.current += 1
            activeRef.current = null
            setActive(null)
            store.complete(screen)
        },
        [store],
    )

    const advance = useCallback((): void => {
        const step = activeRef.current
        if (step === null) return
        const taught = shown.current.get(step.screen) ?? new Set<string>()
        taught.add(step.candidate.id)
        shown.current.set(step.screen, taught)
        if (step.position >= step.total) {
            finish(step.screen)
            return
        }
        // Keep the host mounted between taught steps so its spotlight can travel to the next measured target.
        resumeNow.current = true
        rerun()
    }, [finish])

    const activeToken = active?.token ?? null
    const claim = useCallback((expectedToken: number | null, allowClaimed = false): ActiveStep | null => {
        const step = activeRef.current
        const report = step === null ? undefined : reportsRef.current.get(step.screen)
        if (
            step === null ||
            step.token !== expectedToken ||
            latch.current.token !== step.token ||
            (latch.current.consumed && !allowClaimed) ||
            report?.focused !== true ||
            report.suppressed ||
            !report.candidates.some((candidate) => candidate.id === step.candidate.id)
        ) {
            return null
        }
        latch.current.consumed = true
        return step
    }, [])

    const next = useCallback((): void => {
        if (claim(activeToken) !== null) advance()
    }, [advance, claim, activeToken])

    const skip = useCallback((): boolean => {
        // Skip also owns the brief interval while Next is measuring; token/focus gates still reject stale events.
        const step = claim(activeToken, true)
        if (step !== null) {
            finish(step.screen)
            returnFocus(targets.current.get(`${step.screen}:${step.candidate.id}`)?.())
            return true
        }
        return false
    }, [claim, finish, activeToken])

    // The highlighted target. A control runs its own registered action once, after the tip has been consumed and hidden
    // and the screen marked seen in memory; a surface only moves the tour on.
    const activate = useCallback((): void => {
        const step = claim(activeToken)
        if (step === null) return
        if (!step.actionable) {
            haptic('selection')
            advance()
            return
        }
        const handle = targets.current.get(`${step.screen}:${step.candidate.id}`)?.()
        if (handle?.onPress === undefined) {
            generation.current += 1
            activeRef.current = null
            setActive(null)
            return
        }
        finish(step.screen)
        haptic('selection')
        handle.onPress()
    }, [advance, claim, finish, activeToken, haptic])

    // A bubble that cannot fit withdraws without consuming the lesson. A later eligible focus/geometry change retries.
    const defer = useCallback((): void => {
        if (claim(activeToken) === null) return
        generation.current += 1
        activeRef.current = null
        setActive(null)
    }, [claim, activeToken])

    useEffect(() => {
        if (active === null || Platform.OS !== 'android') return undefined
        const subscription = BackHandler.addEventListener('hardwareBackPress', (): boolean => {
            return skip()
        })
        return (): void => subscription.remove()
    }, [active, skip])

    const showTipsAgain = useCallback((): void => {
        resumeNow.current = false
        generation.current += 1
        activeRef.current = null
        setActive(null)
        setHidden(false)
        store.reset()
    }, [store])
    const hideForTesting = useCallback((): void => setHidden(true), [])

    const value = useMemo(
        (): CoachContextValue => ({
            registerTarget,
            report,
            clearReport,
            active,
            evidenceScene,
            next,
            skip,
            activate,
            defer,
            showTipsAgain,
            hideForTesting,
        }),
        [
            registerTarget,
            report,
            clearReport,
            active,
            evidenceScene,
            next,
            skip,
            activate,
            defer,
            showTipsAgain,
            hideForTesting,
        ],
    )
    return (
        <CoachContext.Provider value={value}>
            <View
                style={ROOT}
                accessibilityElementsHidden={active !== null && active.host === 'root'}
                importantForAccessibility={active !== null && active.host === 'root' ? 'no-hide-descendants' : 'auto'}
            >
                {children}
            </View>
            {renderOverlay !== undefined && active !== null && active.host === 'root'
                ? renderOverlay(active, { next, skip, activate, defer })
                : null}
        </CoachContext.Provider>
    )
}

const ROOT: ViewStyle = { flex: 1 }

function sameReport(a: CoachReport, b: CoachReport): boolean {
    return (
        a.focused === b.focused &&
        a.suppressed === b.suppressed &&
        a.host === b.host &&
        a.candidates.length === b.candidates.length &&
        a.candidates.every((candidate, index) => {
            const other = b.candidates[index]
            return (
                other !== undefined &&
                candidate.id === other.id &&
                candidate.kind === other.kind &&
                candidate.heading === other.heading &&
                candidate.sentence === other.sentence
            )
        })
    )
}

/** Best effort: put screen-reader focus back on the control a finished tip pointed at. */
function returnFocus(handle: TargetHandle | undefined): void {
    const node = handle?.ref.current
    if (node != null && typeof AccessibilityInfo.sendAccessibilityEvent === 'function') {
        try {
            AccessibilityInfo.sendAccessibilityEvent(node, 'focus')
        } catch {
            return
        }
    }
}

/** Shows tips again: clears the record, closes the sheet it was tapped in and lets the screen offer them. */
export function useShowTipsAgain(): ((closeMore: () => void) => void) | null {
    const coach = useContext(CoachContext)
    return useMemo(
        () =>
            coach === null
                ? null
                : (closeMore: () => void): void => {
                      closeMore()
                      coach.showTipsAgain()
                  },
        [coach],
    )
}
