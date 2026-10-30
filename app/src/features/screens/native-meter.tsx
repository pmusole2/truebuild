import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
    type ReactElement,
    type ReactNode,
} from 'react'
import { Platform, useWindowDimensions } from 'react-native'
import { usePathname } from 'expo-router'
import { useOptionalWorkflow } from '../capture/workflow-context'
import { useCoach } from '../onboarding/coach-provider'
import { MeterRootsContext, type MeterRoots } from '../../ui/meter-roots'
import { useJudge } from './judge-context'
import { logNativeCheckpoint } from './native-meter-log'
import {
    NativeHostMeter,
    type NativeHostMeasurement,
    type NativeHostMeterSnapshot,
    type NativeHostSessionSummary,
} from './native-host-meter'

type MeterPlatform = 'ios' | 'android'

/** Runs `run` once, soon, and returns how to cancel it. One frame lets a sheet or tip that just mounted finish mounting. */
export type MeterSchedule = (run: () => void) => () => void

const nextFrame: MeterSchedule = (run) => {
    const handle = requestAnimationFrame(run)
    return (): void => cancelAnimationFrame(handle)
}

type MeterControl = {
    readonly meter: NativeHostMeter
    readonly sessionId: string
    readonly platform: MeterPlatform
    readonly schedule: MeterSchedule
    /** Names why the next checkpoint is being taken and marks the last measurement out of date. */
    readonly note: (cause: string) => void
    /** The causes since the last checkpoint, as one stable identifier. */
    readonly take: () => string
    /** Session-local opaque identity. Raw workflow identifiers never enter a measurement or log. */
    readonly view: (identity: string) => string
}

const MeterControlContext = createContext<MeterControl | null>(null)

/** The routes a checkpoint may name; anything else is "other". Opaque, never a manual title or id. */
const SCREENS = ['home', 'add', 'reading', 'check', 'guide', 'done', 'camera', 'compare'] as const
export function screenOfPath(pathname: string): string {
    const first = pathname.split('/').find((part) => part !== '')
    if (first === undefined) return 'home'
    return (SCREENS as readonly string[]).includes(first) ? first : 'other'
}

/**
 * The device-only host meter. It exists only while the judge's "show how Meta AI built this" preference is on (or a
 * proof run asks for it) on iOS or Android, so a normal run pays nothing and shows nothing. The meter itself never
 * loads native code; the roots a mounted app, sheet, coach overlay and camera hand it (see `useMeterRoot`) are read
 * through the public host instance API only.
 */
export function NativeMeterProvider({
    children,
    enabled,
    platform = Platform.OS,
    sessionId,
    schedule = nextFrame,
}: {
    readonly children: ReactNode
    /** Forces the meter on or off. By default it follows the judge preference. */
    readonly enabled?: boolean
    readonly platform?: string
    readonly sessionId?: string
    readonly schedule?: MeterSchedule
}): ReactElement {
    const { showBuilt } = useJudge()
    const supported = platform === 'ios' || platform === 'android'
    const active = supported && (enabled ?? showBuilt)
    const [session] = useState(() => sessionId ?? `device-${Math.random().toString(36).slice(2, 10)}`)
    const [control, setControl] = useState<MeterControl | null>(null)
    useEffect(() => {
        if (!active) return undefined
        const meter = new NativeHostMeter()
        const causes = new Set<string>()
        const views = new Map<string, string>()
        const made: MeterControl = {
            meter,
            sessionId: session,
            platform: platform as MeterPlatform,
            schedule,
            note: (cause): void => {
                causes.add(cause)
                meter.markStale()
            },
            take: (): string => {
                const id = [...causes].sort().join('+') || 'requested'
                causes.clear()
                return id
            },
            view: (identity): string => {
                let id = views.get(identity)
                if (id === undefined) {
                    id = `view-${views.size + 1}`
                    views.set(identity, id)
                }
                return id
            },
        }
        setControl(made)
        return (): void => {
            meter.dispose()
            setControl(null)
        }
    }, [active, platform, session, schedule])
    const roots = useMemo<MeterRoots | null>(
        () =>
            control === null
                ? null
                : {
                      registerRoot: (ref, kind, selection): (() => void) => {
                          const stop = control.meter.registerRoot(ref, { ...selection, kind })
                          control.note(kind)
                          return (): void => {
                              stop()
                              control.note(kind)
                          }
                      },
                  },
        [control],
    )
    return (
        <MeterControlContext.Provider value={control}>
            <MeterRootsContext.Provider value={roots}>{children}</MeterRootsContext.Provider>
        </MeterControlContext.Provider>
    )
}

const none = (): (() => void) => (): void => undefined

/**
 * Takes the checkpoints. It sits where it can see the workflow and the coach, and takes one explicit checkpoint when
 * the focused screen, the delivered documents, the tip, the busy state or the window layout change, and whenever a
 * root is added or removed (a sheet, an overlay, the camera). Each change only marks the last measurement out of date;
 * one measurement follows on the next frame. No observer, no timer and no polling.
 */
export function MeterTriggers(): null {
    const control = useContext(MeterControlContext)
    const pathname = usePathname()
    const workflow = useOptionalWorkflow()
    const coach = useCoach()
    const { showBuilt } = useJudge()
    const window = useWindowDimensions()
    const screens = workflow?.documents ?? null
    const documents = useSyncExternalStore(
        screens?.subscribe ?? none,
        screens?.getVersion ?? ((): number => 0),
        screens?.getVersion ?? ((): number => 0),
    )
    const snapshot = useSyncExternalStore(
        control?.meter.subscribe ?? none,
        control?.meter.getSnapshot ?? ((): null => null),
        control?.meter.getSnapshot ?? ((): null => null),
    )
    const screen = screenOfPath(pathname)
    const tip = coach?.active?.token ?? null
    const busy = workflow?.state.pending != null
    // Distinguish steps and capture phases on the same route, without weighting background precompute deliveries as
    // new views or publishing user identifiers. Recounting the same view/cause replaces its checkpoint.
    const entry = workflow?.entry
    const state = workflow?.state
    const viewIdentity = JSON.stringify([
        screen,
        entry?.session.manualId,
        entry?.session.revision,
        entry?.session.reviewedSteps[entry.stepIndex]?.stepId,
        entry?.session.pages.length,
        state?.capture?.binding.captureId,
        state?.check?.decision,
        state?.answer !== null && state?.answer !== undefined,
        state?.pending,
        state?.cameraIntent?.kind,
        state?.stages?.overlay.status,
        state?.stages?.segments.status,
        tip,
        showBuilt,
        window.width,
        window.height,
        window.fontScale,
    ])
    useEffect(() => control?.note('view'), [control, viewIdentity])
    useEffect(() => control?.note('focus'), [control, screen])
    useEffect(() => control?.note('document'), [control, documents])
    useEffect(() => control?.note('tip'), [control, tip])
    useEffect(() => control?.note('busy'), [control, busy])
    useEffect(() => control?.note('capture'), [control, workflow?.state.capture])
    useEffect(() => control?.note('verdict'), [control, workflow?.state.check])
    useEffect(() => control?.note('answer'), [control, workflow?.state.answer])
    useEffect(() => control?.note('stage'), [control, workflow?.state.stages])
    useEffect(() => control?.note('selection'), [control, workflow?.state.target])
    useEffect(() => control?.note('judge'), [control, showBuilt])
    useEffect(() => control?.note('layout'), [control, window.width, window.height, window.fontScale])
    const stale = snapshot?.stale === true
    const version = snapshot?.version
    useEffect(() => {
        if (control === null || !stale) return undefined
        return control.schedule((): void => {
            const started = performance.now()
            const measurement = control.meter.sample({
                sessionId: control.sessionId,
                platform: control.platform,
                screen,
                checkpointId: `${control.view(viewIdentity)}:${control.take()}`,
            })
            const sampleMs = performance.now() - started
            const session = control.meter.summarizeSession(control.sessionId, control.platform)
            // Only opaque checkpoint names and observed counts. Never native nodes, text, props or photo data.
            logNativeCheckpoint({
                event: 'render_origin_checkpoint',
                evidence: 'native-public-host',
                ...measurement,
                sampleMs,
                session: {
                    methods: session.methods,
                    metricsVersion: session.metricsVersion,
                    status: session.status,
                    sampleCount: session.sampleCount,
                    counts: session.counts,
                    rawTextCounts: session.rawTextCounts,
                    generatedShare: session.generatedShare,
                    reason: session.reason,
                    strictStatus: session.strictStatus,
                    strictCounts: session.strictCounts,
                    strictRawTextCounts: session.strictRawTextCounts,
                    strictGeneratedShare: session.strictGeneratedShare,
                    strictReason: session.strictReason,
                    minimumScreenGeneratedShare: session.minimumScreenGeneratedShare,
                    meanRouteGeneratedShare: session.meanRouteGeneratedShare,
                    meanRouteStrictGeneratedShare: session.meanRouteStrictGeneratedShare,
                    exclusions: session.exclusions,
                    routes: session.routes.map(
                        ({
                            route,
                            status,
                            sampleCount,
                            counts,
                            generatedShare,
                            reason,
                            strictStatus,
                            strictCounts,
                            strictGeneratedShare,
                            strictReason,
                            exclusions,
                        }) => ({
                            route,
                            status,
                            sampleCount,
                            counts,
                            generatedShare,
                            reason,
                            strictStatus,
                            strictCounts,
                            strictGeneratedShare,
                            strictReason,
                            exclusions,
                        }),
                    ),
                },
            })
        })
        // A new root, tip or document while one is scheduled replaces it, so a burst becomes one checkpoint.
    }, [control, stale, version, screen, viewIdentity])
    return null
}

export type MeterReading = {
    /** False when the meter does not exist here: web, or the judge layer is off. */
    readonly active: boolean
    readonly snapshot: NativeHostMeterSnapshot | null
    readonly session: NativeHostSessionSummary | null
    readonly measureNow: (identity?: string) => void
}

/** The meter's latest measurement and its session summary, for the judge layer. Never a number that was not measured. */
export function useMeterReading(): MeterReading {
    const control = useContext(MeterControlContext)
    const snapshot = useSyncExternalStore(
        control?.meter.subscribe ?? none,
        control?.meter.getSnapshot ?? ((): null => null),
        control?.meter.getSnapshot ?? ((): null => null),
    )
    const version = snapshot?.version
    const session = useMemo(
        () => control?.meter.summarizeSession(control.sessionId, control.platform) ?? null,
        // The summary only changes when the meter publishes.
        [control, version],
    )
    return {
        active: control !== null,
        snapshot,
        session,
        measureNow: (identity): void =>
            control?.note(identity === undefined ? 'requested' : `requested-${control.view(identity)}`),
    }
}

export type { NativeHostMeasurement }
