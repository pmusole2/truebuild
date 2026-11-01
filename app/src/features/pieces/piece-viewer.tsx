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
    type ComponentRef,
    type ReactElement,
    type ReactNode,
} from 'react'
import { Image, PanResponder, Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native'
import { requireOptionalNativeModule } from 'expo'
import type { ExpoWebGLRenderingContext } from 'expo-gl'
import { pieceSpecSchema, type PieceSpec } from '@truebuild/contracts'
import { Heading, Caption, Body } from '../../ui/text'
import { radius, space } from '../../theme/tokens'
import { useTheme } from '../../theme/theme'
import type { PieceScene } from './piece-scene'
import { loadPieceGL } from './piece-gl'

// The normal document renderer may import this module without loading GL or Three (including on unsupported devices).
const LazyGLView = lazy(loadPieceGL)

function validatedPiece(value: unknown): PieceSpec | null {
    try {
        const parsed = pieceSpecSchema.safeParse(value)
        return parsed.success ? parsed.data : null
    } catch {
        return null
    }
}

function fallbackName(value: unknown): string {
    try {
        if (typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string')
            return value.name.trim().slice(0, 80) || 'Assembly piece'
    } catch {
        // A malformed input with a throwing accessor is still only a name card.
    }
    return 'Assembly piece'
}

function availableGL(): boolean {
    try {
        return Platform.OS === 'web'
            ? typeof WebGLRenderingContext !== 'undefined' || typeof WebGL2RenderingContext !== 'undefined'
            : requireOptionalNativeModule('ExpoGL') !== null
    } catch {
        return false
    }
}

function PieceCard({ name, imageUri, height }: { name: string; imageUri?: string; height: number }): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            testID="piece-viewer-fallback"
            accessibilityLabel={name}
            style={[styles.fallback, { minHeight: height, backgroundColor: colors.surfaceSunken }]}
        >
            {imageUri === undefined ? null : (
                <Image
                    source={{ uri: imageUri }}
                    resizeMode="contain"
                    style={styles.fallbackImage}
                    accessibilityLabel={name}
                />
            )}
            <Heading>{name}</Heading>
        </View>
    )
}

class GLBoundary extends Component<
    { children: ReactNode; fallback: ReactNode; failed: () => void },
    { failed: boolean }
> {
    state = { failed: false }
    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true }
    }
    componentDidCatch(): void {
        this.props.failed()
    }
    render(): ReactNode {
        return this.state.failed ? this.props.fallback : this.props.children
    }
}

type ViewerProps = {
    readonly piece: unknown
    readonly fallbackImageUri?: string
    readonly height?: number
    /** Render completion samples, used by the explicit fixture route; never starts an animation loop. */
    readonly onFrame?: (timestampMs: number) => void
}

/** A malformed or unsupported 3D spec has the same quiet 2D card as a device without GL. */
export function PieceViewer({ piece, fallbackImageUri, height = 320, onFrame }: ViewerProps): ReactElement {
    const parsed = useMemo(() => validatedPiece(piece), [piece])
    const size = Number.isFinite(height) ? Math.max(160, Math.min(640, height)) : 320
    const fallback = <PieceCard name={parsed?.name ?? fallbackName(piece)} imageUri={fallbackImageUri} height={size} />
    if (parsed === null || !availableGL()) return fallback
    return (
        <ValidPieceViewer
            key={JSON.stringify(parsed)}
            piece={parsed}
            height={size}
            fallback={fallback}
            onFrame={onFrame}
        />
    )
}

function fingerDistance(event: GestureResponderEvent): number | null {
    const [one, two] = event.nativeEvent.touches
    return one === undefined || two === undefined ? null : Math.hypot(one.pageX - two.pageX, one.pageY - two.pageY)
}

function ValidPieceViewer({
    piece,
    height,
    fallback,
    onFrame,
}: {
    piece: PieceSpec
    height: number
    fallback: ReactElement
    onFrame?: (timestampMs: number) => void
}): ReactElement {
    const { colors } = useTheme()
    const [failed, setFailed] = useState(false)
    const host = useRef<ComponentRef<typeof View>>(null)
    const mounted = useRef(true)
    const unavailable = useRef(false)
    const creationEpoch = useRef(0)
    const startupDeadline = useRef(performance.now() + 5_000)
    const startupTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const scene = useRef<PieceScene | null>(null)
    const frame = useRef<number | null>(null)
    const reportFrame = useRef(onFrame)
    const lastTap = useRef(0)
    const gesture = useRef({ x: 0, y: 0, distance: null as number | null, pinched: false })
    useEffect(() => {
        reportFrame.current = onFrame
    }, [onFrame])
    const clearStartup = useCallback((): void => {
        if (startupTimer.current !== null) clearTimeout(startupTimer.current)
        startupTimer.current = null
    }, [])
    const release = useCallback((): void => {
        creationEpoch.current++
        clearStartup()
        if (frame.current !== null) cancelAnimationFrame(frame.current)
        frame.current = null
        const previous = scene.current
        scene.current = null
        try {
            previous?.dispose()
        } catch {
            // GLView also releases its owned context; context loss must keep the fallback usable.
        }
    }, [clearStartup])
    const fail = useCallback((): void => {
        unavailable.current = true
        release()
        if (mounted.current) setFailed(true)
    }, [release])
    const watchStartup = useCallback((): void => {
        clearStartup()
        if (!mounted.current || unavailable.current || scene.current !== null) return
        // A native surface can fail without ever delivering onContextCreate; it still resolves to the name card.
        startupTimer.current = setTimeout(fail, Math.max(0, startupDeadline.current - performance.now()))
    }, [clearStartup, fail])
    const draw = useCallback((): void => {
        if (!mounted.current || scene.current === null || frame.current !== null) return
        frame.current = requestAnimationFrame((timestamp): void => {
            frame.current = null
            if (!mounted.current || scene.current === null) return
            try {
                const moving = scene.current.draw()
                reportFrame.current?.(timestamp)
                if (moving) draw()
            } catch {
                fail()
            }
        })
    }, [fail])
    const create = useCallback(
        async (gl: ExpoWebGLRenderingContext): Promise<void> => {
            if (!mounted.current || unavailable.current) return
            release()
            const epoch = creationEpoch.current
            // A replacement native surface gets its own startup window, even long after the original mount.
            startupDeadline.current = performance.now() + 5_000
            watchStartup()
            try {
                const { createPieceScene } = await import('./piece-scene')
                if (!mounted.current || unavailable.current || epoch !== creationEpoch.current) return
                const created = createPieceScene(gl, piece, colors.surfaceSunken)
                if (!mounted.current || unavailable.current || epoch !== creationEpoch.current) {
                    created.dispose()
                    return
                }
                scene.current = created
                clearStartup()
                draw()
            } catch {
                if (epoch === creationEpoch.current) fail()
            }
        },
        [piece, colors.surfaceSunken, draw, release, fail, watchStartup, clearStartup],
    )
    useLayoutEffect(() => {
        mounted.current = true
        watchStartup()
        return (): void => {
            // Release GPU objects before the child GLView unregisters its native context during unmount.
            mounted.current = false
            release()
        }
    }, [release, watchStartup])
    // Native uses PanResponder pinch; the web wheel listener is non-passive so zoom cannot scroll the page behind it.
    useEffect(() => {
        const element: unknown = host.current
        if (Platform.OS !== 'web' || typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return
        const previous = element.style.touchAction
        element.style.touchAction = 'none'
        const wheel = (event: WheelEvent): void => {
            event.preventDefault()
            scene.current?.zoom(Math.exp(-Math.max(-500, Math.min(500, event.deltaY)) * 0.0018))
            draw()
        }
        element.addEventListener('wheel', wheel, { passive: false })
        return (): void => {
            element.removeEventListener('wheel', wheel)
            element.style.touchAction = previous
        }
    }, [draw, failed])
    const responder = useMemo(
        () =>
            PanResponder.create({
                onStartShouldSetPanResponder: () => true,
                onMoveShouldSetPanResponder: () => true,
                onPanResponderTerminationRequest: () => false,
                onPanResponderGrant: (event): void => {
                    gesture.current = { x: 0, y: 0, distance: fingerDistance(event), pinched: false }
                },
                onPanResponderMove: (event, movement): void => {
                    const distance = fingerDistance(event)
                    if (distance !== null) {
                        if (gesture.current.distance !== null && gesture.current.distance > 0)
                            scene.current?.zoom(distance / gesture.current.distance)
                        gesture.current.pinched = true
                    } else if (gesture.current.distance === null) {
                        scene.current?.rotate(
                            (movement.dx - gesture.current.x) * 0.009,
                            (movement.dy - gesture.current.y) * 0.009,
                        )
                    }
                    gesture.current.x = movement.dx
                    gesture.current.y = movement.dy
                    gesture.current.distance = distance
                    draw()
                },
                onPanResponderRelease: (_event, movement): void => {
                    if (!gesture.current.pinched && Math.hypot(movement.dx, movement.dy) < 6) {
                        const now = Date.now()
                        if (now - lastTap.current < 320) {
                            scene.current?.reset()
                            draw()
                            lastTap.current = 0
                        } else lastTap.current = now
                    } else lastTap.current = 0
                },
            }),
        [draw],
    )
    if (failed) return fallback
    const webEvents = Platform.OS === 'web' ? { onContextLost: fail } : {}
    return (
        <View style={styles.viewer} testID="piece-viewer">
            <Heading>{piece.name}</Heading>
            <View
                ref={host}
                testID="piece-viewer-gesture-surface"
                accessibilityLabel={`${piece.name}, interactive 3D view`}
                style={[styles.viewport, { height, backgroundColor: colors.surfaceSunken }]}
                {...responder.panHandlers}
            >
                <GLBoundary fallback={fallback} failed={fail}>
                    <Suspense fallback={fallback}>
                        <LazyGLView style={styles.gl} onContextCreate={create} onLayout={draw} {...webEvents} />
                    </Suspense>
                </GLBoundary>
            </View>
            <Caption>Drag to rotate. Pinch to zoom. Double-tap to reset.</Caption>
        </View>
    )
}

/** The grid stays 2D; selecting a tile focuses the single GPU viewer instead of allocating a context per tile. */
export function PiecesGrid({
    pieces,
    pieceIds,
    onFrame,
}: {
    readonly pieces: readonly PieceSpec[]
    readonly pieceIds?: readonly string[]
    readonly onFrame?: (timestampMs: number) => void
}): ReactElement {
    const { colors } = useTheme()
    const accepted = useMemo((): PieceSpec[] => {
        if (!Array.isArray(pieces) || pieces.length > 30) return []
        const parsed = pieces.map(validatedPiece)
        if (parsed.some((piece) => piece === null)) return []
        const values = parsed.filter((piece): piece is PieceSpec => piece !== null)
        if (new Set(values.map((piece) => piece.id)).size !== values.length) return []
        if (pieceIds === undefined) return values
        if (!Array.isArray(pieceIds) || pieceIds.length > 30) return []
        return values.filter((piece) => pieceIds.includes(piece.id))
    }, [pieces, pieceIds])
    const [selected, setSelected] = useState<string | null>(null)
    const current = accepted.find((piece) => piece.id === selected) ?? accepted[0]
    if (current === undefined) return <PieceCard name="Assembly pieces" height={240} />
    return (
        <View style={styles.viewer} testID="pieces-grid">
            <PieceViewer piece={current} onFrame={onFrame} />
            <View style={styles.grid}>
                {accepted.map((piece) => (
                    <Pressable
                        key={piece.id}
                        testID={`piece-tile-${piece.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={`View ${piece.name}`}
                        accessibilityState={{ selected: current.id === piece.id }}
                        onPress={(): void => setSelected(piece.id)}
                        style={[
                            styles.tile,
                            {
                                backgroundColor: colors.surface,
                                borderColor: current.id === piece.id ? colors.accent : colors.border,
                            },
                        ]}
                    >
                        <View style={[styles.swatch, { backgroundColor: piece.color }]} />
                        <Body>{piece.name}</Body>
                    </Pressable>
                ))}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    viewer: { gap: space.sm },
    viewport: { borderRadius: radius.lg, overflow: 'hidden' },
    gl: { flex: 1 },
    fallback: {
        borderRadius: radius.lg,
        padding: space.md,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
    },
    fallbackImage: { width: 160, height: 140 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    tile: {
        flexBasis: 140,
        flexGrow: 1,
        minHeight: 104,
        borderRadius: radius.md,
        padding: space.sm,
        gap: space.xs,
        borderWidth: 2,
    },
    swatch: { width: 40, height: 24, borderRadius: radius.sm },
})
