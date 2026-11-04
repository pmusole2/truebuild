import {
    Component,
    Suspense,
    lazy,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type RefObject,
    type ReactElement,
    type ReactNode,
} from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { stepMotionCopy, stepMotionSceneSchema, type StepMotionScene } from '@truebuild/contracts'
import type { ExpoWebGLRenderingContext } from 'expo-gl'
import { BlueprintLoader } from '../../ui/blueprint-loader'
import { useFeedback } from '../../ui/feedback'
import { Body, Caption } from '../../ui/text'
import { IconButton } from '../../ui/button'
import { radius, space } from '../../theme/tokens'
import { useTheme } from '../../theme/theme'
import { isGLAvailable, loadPieceGL, loadStepMotionScene } from '../pieces/piece-gl'
import type { StepMotionClock, StepMotionGLScene } from './step-motion-scene'

// The GL surface and its Three scene load lazily, so a document without a motion hint never pays for either.
const LazyGLView = lazy(loadPieceGL)
const VIEWPORT_ASPECT = 16 / 10
// At most 30 frames a second. rAF usually fires on a 16.7ms cadence, so the 1ms allowance keeps every other tick.
const MIN_FRAME_MS = 1000 / 30 - 1
// The piece viewer's startup window: a surface that never delivers a context resolves to nothing instead of a blank box.
const STARTUP_MS = 5_000
// Scene identity changes restart the GL surface; a module counter keeps each identity's key unique.
let sceneGeneration = 0

/**
 * Playback time lives here, not in the GL scene. `since` is the wall-clock start of the running stretch, or null while
 * paused. Background, inactivity and unmount pause it; only Replay returns it to zero.
 */
type Playback = { readonly elapsed: number; readonly since: number | null }

function elapsedOf(playback: Playback, now: number): number {
    return playback.since === null ? playback.elapsed : playback.elapsed + (now - playback.since)
}

function pausePlayback(ref: RefObject<Playback>): void {
    ref.current = { elapsed: elapsedOf(ref.current, performance.now()), since: null }
}

function resumePlayback(ref: RefObject<Playback>): void {
    if (ref.current.since === null) ref.current = { elapsed: ref.current.elapsed, since: performance.now() }
}

export type StepMotionAvailability = 'motion' | 'loading' | 'fallback'

export type StepMotionHintProps = {
    readonly scene: unknown
    readonly loading?: boolean
    readonly active?: boolean
    readonly readingLanguage?: string
    readonly fallback?: ReactNode
    readonly stepLabel?: string
    readonly onAvailabilityChange?: (status: StepMotionAvailability) => void
    readonly onActionIndex?: (actionIndex: number | null) => void
}

function parseScene(value: unknown): StepMotionScene | null {
    const result = stepMotionSceneSchema.safeParse(value)
    return result.success ? result.data : null
}

/**
 * Background and inactive pause the hint. An unknown or absent state leaves it as it was, so a platform without
 * AppState signals (web) keeps playing.
 */
function useAppActive(): boolean {
    const [foreground, setForeground] = useState(true)
    useEffect(() => {
        if (!AppState.isAvailable) return undefined
        const apply = (status: string | null | undefined): void => {
            if (status === 'active') setForeground(true)
            else if (status === 'background' || status === 'inactive') setForeground(false)
        }
        const subscription = AppState.addEventListener('change', apply)
        apply(AppState.currentState)
        return (): void => subscription.remove()
    }, [])
    return foreground
}

class GLBoundary extends Component<
    { readonly onFail: () => void; readonly children: ReactNode },
    { readonly failed: boolean }
> {
    state = { failed: false }

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true }
    }

    componentDidCatch(): void {
        this.props.onFail()
    }

    render(): ReactNode {
        return this.state.failed ? null : this.props.children
    }
}

/**
 * A quiet motion hero. Its optional manual reference fills the same frame for absent or unavailable motion.
 * The GL surface exists only while the hint is active, foregrounded and valid.
 */
export function StepMotionHint({
    scene,
    loading = false,
    active = true,
    readingLanguage = 'en',
    onActionIndex,
    fallback,
    stepLabel,
    onAvailabilityChange,
}: StepMotionHintProps): ReactElement | null {
    const { colors } = useTheme()
    const copy = stepMotionCopy(readingLanguage)
    const { reduceMotion } = useFeedback()
    const appActive = useAppActive()
    const parsed = useMemo(() => parseScene(scene), [scene])
    const glAvailable = useMemo(() => parsed === null || isGLAvailable(), [parsed])
    const generation = useMemo(() => (sceneGeneration += 1), [parsed])
    const [viewportHeight, setViewportHeight] = useState(200)
    const [failed, setFailed] = useState(false)
    const [finished, setFinished] = useState(false)
    const [replays, setReplays] = useState(0)
    const [sceneVersion, setSceneVersion] = useState(0)
    const [readySurface, setReadySurface] = useState<object | null>(null)
    const sceneRef = useRef<StepMotionGLScene | null>(null)
    // One object per live stretch of the GL surface. A context callback may run only while its own surface is still the
    // current one, so a callback queued across deactivation or unmount never loads a builder or allocates GPU objects.
    const surfaceRef = useRef<{ readonly live: boolean }>({ live: false })
    const playback = useRef<Playback>({ elapsed: 0, since: null })
    const lastElapsed = useRef(Number.POSITIVE_INFINITY)
    const onActionRef = useRef(onActionIndex)
    useLayoutEffect(() => {
        onActionRef.current = onActionIndex
    }, [onActionIndex])
    const live = glAvailable && active && appActive && !failed && parsed !== null
    const surface = useMemo(() => ({ live }), [live, generation])

    const releaseScene = useCallback((): void => {
        const previous = sceneRef.current
        sceneRef.current = null
        try {
            previous?.dispose()
        } catch {
            // A lost context cannot be drawn into again, and its surface is already unmounting.
        }
    }, [])

    useLayoutEffect(() => {
        if (!live) return undefined
        surfaceRef.current = surface
        return (): void => {
            // Closing the surface first makes every outstanding context callback stale before GPU objects are released.
            surfaceRef.current = { live: false }
            releaseScene()
        }
    }, [live, generation, surface, releaseScene])

    useEffect(() => {
        if (!live) return undefined
        // A surface that never delivers a context (no native GL, a stalled view) must not leave an empty box behind.
        const timer = setTimeout(() => {
            if (sceneRef.current === null) setFailed(true)
        }, STARTUP_MS)
        return (): void => clearTimeout(timer)
    }, [live, generation])

    const create = useCallback(
        async (gl: ExpoWebGLRenderingContext): Promise<void> => {
            // This callback belongs to this exact surface, even if an old callback arrives after a later reactivation.
            if (!surface.live || surfaceRef.current !== surface || parsed === null) return
            releaseScene()
            try {
                const { createStepMotionScene } = await loadStepMotionScene()
                if (surfaceRef.current !== surface) return
                const created = createStepMotionScene(gl, parsed, {
                    background: colors.surfaceSunken,
                    ground: colors.surfaceRaised,
                })
                if (surfaceRef.current !== surface) {
                    created.dispose()
                    return
                }
                sceneRef.current = created
                setReadySurface(surface)
                setSceneVersion((version) => version + 1)
            } catch {
                if (surfaceRef.current === surface) setFailed(true)
            }
        },
        [parsed, surface, colors.surfaceSunken, colors.surfaceRaised, releaseScene],
    )

    const redraw = useCallback((): void => {
        const current = sceneRef.current
        if (current === null) return
        try {
            current.draw(lastElapsed.current)
        } catch {
            setFailed(true)
        }
    }, [])

    useEffect(() => {
        const current = sceneRef.current
        if (!live || current === null || parsed === null) return undefined
        let frame: number | null = null
        let activeMover: number | null = null
        // Reports only changes of the moving part, so a parent highlight never fires per frame.
        const announce = (mover: number | null): void => {
            if (mover === activeMover) return
            activeMover = mover
            onActionRef.current?.(mover === null ? null : (parsed.movers[mover]?.actionIndex ?? null))
        }
        const step = (elapsed: number): boolean => {
            lastElapsed.current = elapsed
            const clock: StepMotionClock = current.draw(elapsed)
            announce(clock.finished ? null : clock.mover)
            if (clock.finished) setFinished(true)
            return clock.finished
        }
        if (reduceMotion) {
            try {
                // A static accessibility pose does not spend or finish the playback budget.
                lastElapsed.current = Number.POSITIVE_INFINITY
                current.draw(Number.POSITIVE_INFINITY)
                announce(null)
            } catch {
                setFailed(true)
            }
        } else {
            // Resumes from the stored elapsed: a finished sequence stays finished, and no new loop starts on foreground.
            resumePlayback(playback)
            let lastDraw = Number.NEGATIVE_INFINITY
            const tick = (): void => {
                frame = null
                const now = performance.now()
                if (now - lastDraw < MIN_FRAME_MS) {
                    frame = requestAnimationFrame(tick)
                    return
                }
                lastDraw = now
                try {
                    if (step(elapsedOf(playback.current, now))) {
                        pausePlayback(playback)
                        return
                    }
                    frame = requestAnimationFrame(tick)
                } catch {
                    setFailed(true)
                }
            }
            frame = requestAnimationFrame(tick)
        }
        return (): void => {
            if (frame !== null) cancelAnimationFrame(frame)
            pausePlayback(playback)
            announce(null)
        }
    }, [live, parsed, sceneVersion, reduceMotion, replays])

    const fail = useCallback((): void => setFailed(true), [])
    const replay = useCallback((): void => {
        // The only reset of the three-loop budget: the run restarts from zero, and the pending effect cleanup adds nothing.
        playback.current = { elapsed: 0, since: null }
        setFinished(false)
        setReplays((count) => count + 1)
    }, [])

    const availability: StepMotionAvailability =
        !glAvailable || failed ? 'fallback' : parsed !== null ? 'motion' : loading ? 'loading' : 'fallback'
    useEffect(() => {
        onAvailabilityChange?.(availability)
    }, [availability, onAvailabilityChange])

    if (availability === 'fallback' && fallback === undefined) return null
    // Scene availability owns the surrounding Guide layout; transient GL readiness only owns this frame's overlay.
    const waitingForSurface = availability === 'motion' && (!live || readySurface !== surface)
    const showFallback = availability === 'fallback' || (availability === 'motion' && !live && fallback !== undefined)
    const replayable = live && finished && !reduceMotion
    const loader = <BlueprintLoader phase="piece" label={copy.loading} compact height={viewportHeight} />
    return (
        <View testID="step-motion-hint" style={styles.root}>
            <View pointerEvents="box-none" style={styles.frame}>
                <View
                    testID="step-motion-viewport"
                    pointerEvents="none"
                    style={[styles.viewport, { backgroundColor: colors.surfaceSunken }]}
                    onLayout={(event): void => {
                        const height = event.nativeEvent.layout.height
                        if (height > 0) setViewportHeight(height)
                    }}
                >
                    <View style={styles.content}>
                        {!showFallback && parsed !== null && live ? (
                            <GLBoundary key={generation} onFail={fail}>
                                <Suspense fallback={null}>
                                    <LazyGLView style={styles.gl} onContextCreate={create} onLayout={redraw} />
                                </Suspense>
                            </GLBoundary>
                        ) : null}
                        {availability === 'loading' || (waitingForSurface && !showFallback) ? (
                            <View pointerEvents="none" style={styles.content}>
                                {loader}
                            </View>
                        ) : null}
                    </View>
                    {availability !== 'motion' || stepLabel === undefined ? null : (
                        <View
                            testID="step-motion-label"
                            style={[styles.stepLabel, { backgroundColor: colors.surfaceRaised }]}
                        >
                            <Caption>{stepLabel}</Caption>
                        </View>
                    )}
                </View>
                {showFallback ? (
                    <View pointerEvents="box-none" style={styles.content}>
                        {fallback}
                    </View>
                ) : null}
                {replayable && availability === 'motion' ? (
                    <View pointerEvents="box-none" style={styles.replay}>
                        <IconButton
                            testID="step-motion-replay"
                            label="Replay motion"
                            variant="accent"
                            icon="refresh"
                            onPress={replay}
                        />
                    </View>
                ) : null}
            </View>
            {availability === 'motion' && parsed !== null ? (
                <>
                    <Body>{parsed.caption}</Body>
                    <View style={[styles.approximate, { backgroundColor: colors.surfaceSunken }]}>
                        <Caption>
                            {copy.approximate === 'Approximate' ? 'Approximate motion' : copy.approximate}
                        </Caption>
                    </View>
                </>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    root: { gap: space.xs },
    frame: { borderRadius: radius.hero, overflow: 'hidden' },
    viewport: { aspectRatio: VIEWPORT_ASPECT, width: '100%', overflow: 'hidden', borderRadius: radius.hero },
    content: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    gl: { flex: 1 },
    stepLabel: {
        position: 'absolute',
        top: space.sm,
        left: space.sm,
        borderRadius: radius.sm,
        paddingHorizontal: space.xs,
        paddingVertical: space.xxs,
    },
    replay: { position: 'absolute', bottom: space.sm, right: space.sm },
    approximate: {
        alignSelf: 'flex-start',
        borderRadius: radius.sm,
        paddingHorizontal: space.xs,
        paddingVertical: space.xxs,
    },
})
