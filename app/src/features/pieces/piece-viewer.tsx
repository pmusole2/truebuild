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
import {
    Image,
    Modal,
    PanResponder,
    Platform,
    Pressable,
    StyleSheet,
    useWindowDimensions,
    View,
    type GestureResponderEvent,
} from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { requireOptionalNativeModule } from 'expo'
import type { ExpoWebGLRenderingContext } from 'expo-gl'
import { pieceSpecSchema, type PieceSpec } from '@truebuild/contracts'
import { BlueprintLoader, LoaderSwap } from '../../ui/blueprint-loader'
import { Heading, Caption, Body } from '../../ui/text'
import { radius, space, touchTarget } from '../../theme/tokens'
import { useTheme } from '../../theme/theme'
import type { PieceScene } from './piece-scene'
import { loadPieceGL, loadPieceScene } from './piece-gl'
import { lockPageScroll, unlockPageScroll } from './viewer-scroll-lock'

// The normal document renderer may import this module without loading GL or Three (including on unsupported devices).
const LazyGLView = lazy(loadPieceGL)

type FallbackReason =
    | 'invalid_spec'
    | 'gl_unavailable'
    | 'registry_rejected_or_unavailable'
    | 'startup_timeout'
    | 'scene_creation_failed'
    | 'draw_failed'
    | 'context_lost'
    | 'gl_surface_failed'

/** At most one bounded diagnostic per mounted instance; no names, images or model text are logged. */
function useFallbackLog(pieceId: string | null, reason: FallbackReason | null): void {
    const reported = useRef(false)
    useEffect(() => {
        if (reason === null || reported.current) return
        reported.current = true
        console.info(JSON.stringify({ event: 'piece_viewer_fallback', pieceId, reason }))
    }, [pieceId, reason])
}

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

function PieceCard({
    name,
    imageUri,
    height,
    showName = true,
}: {
    name: string
    imageUri?: string
    height: number
    showName?: boolean
}): ReactElement {
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
            {showName ? <Heading>{name}</Heading> : null}
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
    /** A guide card already prints the name beside its quantity; the accessible label still names the piece. */
    readonly showName?: boolean
    /** Render completion samples, used by the explicit fixture route; never starts an animation loop. */
    readonly onFrame?: (timestampMs: number) => void
}

/** A malformed or unsupported 3D spec has the same quiet 2D card as a device without GL. */
export function PieceViewer({
    piece,
    fallbackImageUri,
    height = 320,
    showName = true,
    onFrame,
}: ViewerProps): ReactElement {
    const parsed = useMemo(() => validatedPiece(piece), [piece])
    const size = Number.isFinite(height) ? Math.max(160, Math.min(640, height)) : 320
    const fallback = (
        <PieceCard
            name={parsed?.name ?? fallbackName(piece)}
            imageUri={fallbackImageUri}
            height={size}
            showName={showName}
        />
    )
    const glAvailable = parsed !== null && availableGL()
    useFallbackLog(parsed?.id ?? null, parsed === null ? 'invalid_spec' : glAvailable ? null : 'gl_unavailable')
    if (parsed === null || !glAvailable) return fallback
    return (
        <ValidPieceViewer
            key={JSON.stringify(parsed)}
            piece={parsed}
            height={size}
            showName={showName}
            fallback={fallback}
            onFrame={onFrame}
        />
    )
}

/** A text button at the 44 point touch floor. Local so the viewer's module graph does not load the button and motion stack. */
function ViewerButton({
    label,
    accessibilityLabel,
    testID,
    onPress,
}: {
    label: string
    accessibilityLabel: string
    testID: string
    onPress: () => void
}): ReactElement {
    const { colors } = useTheme()
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPress={onPress}
            style={[styles.viewerButton, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}
        >
            <Body>{label}</Body>
        </Pressable>
    )
}

function fingerDistance(event: GestureResponderEvent): number | null {
    const [one, two] = event.nativeEvent.touches
    return one === undefined || two === undefined ? null : Math.hypot(one.pageX - two.pageX, one.pageY - two.pageY)
}

function ValidPieceViewer({
    piece,
    height,
    showName,
    fallback,
    onFrame,
    fullscreen = false,
}: {
    piece: PieceSpec
    height: number
    showName: boolean
    fallback: ReactElement
    onFrame?: (timestampMs: number) => void
    /** The expanded copy inside its Modal: it never opens another Modal. */
    fullscreen?: boolean
}): ReactElement {
    const { colors } = useTheme()
    const [failureReason, setFailureReason] = useState<FallbackReason | null>(null)
    const [expanded, setExpanded] = useState(false)
    const failed = failureReason !== null
    useFallbackLog(piece.id, failureReason)
    const host = useRef<ComponentRef<typeof View>>(null)
    const scrollOwner = useRef<object>({})
    const lockPage = useCallback((): void => lockPageScroll(scrollOwner.current), [])
    const unlockPage = useCallback((): void => unlockPageScroll(scrollOwner.current), [])
    const mounted = useRef(true)
    const unavailable = useRef(false)
    const creationEpoch = useRef(0)
    const startupDeadline = useRef(performance.now() + 5_000)
    const startupTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const scene = useRef<PieceScene | null>(null)
    const frame = useRef<number | null>(null)
    const reportFrame = useRef(onFrame)
    const lastTap = useRef(0)
    const tap = useRef({ x: 0, y: 0, moved: false })
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
    const fail = useCallback(
        (reason: FallbackReason): void => {
            unavailable.current = true
            release()
            // The name card has no drag, so a failure mid-drag must hand the page back.
            unlockPage()
            if (mounted.current) setFailureReason(reason)
        },
        [release, unlockPage],
    )
    const watchStartup = useCallback((): void => {
        clearStartup()
        if (!mounted.current || unavailable.current || scene.current !== null) return
        // A native surface can fail without ever delivering onContextCreate; it still resolves to the name card.
        startupTimer.current = setTimeout(
            () => fail('startup_timeout'),
            Math.max(0, startupDeadline.current - performance.now()),
        )
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
                fail('draw_failed')
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
                const { createPieceScene } = await loadPieceScene()
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
                if (epoch === creationEpoch.current) fail('scene_creation_failed')
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
            // An unmount mid-drag (or a modal closing over it) must not leave the page held still.
            unlockPage()
        }
    }, [release, watchStartup, unlockPage])
    // Native uses PanResponder pinch; the web wheel listener is non-passive so zoom cannot scroll the page behind it.
    useEffect(() => {
        const element: unknown = host.current
        if (Platform.OS !== 'web' || typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return
        const previous = element.style.touchAction
        element.style.touchAction = 'pan-y'
        const wheel = (event: WheelEvent): void => {
            event.preventDefault()
            scene.current?.zoom(Math.exp(-Math.max(-500, Math.min(500, event.deltaY)) * 0.0018))
            draw()
        }
        element.addEventListener('wheel', wheel, { passive: false })
        const reset = (): void => {
            scene.current?.reset()
            draw()
        }
        element.addEventListener('dblclick', reset)
        return (): void => {
            element.removeEventListener('wheel', wheel)
            element.removeEventListener('dblclick', reset)
            element.style.touchAction = previous
        }
    }, [draw, failed])
    const responder = useMemo(
        () =>
            PanResponder.create({
                // A touch that starts on the view belongs to it in any direction; the page holds still until it ends.
                onStartShouldSetPanResponder: () => true,
                onMoveShouldSetPanResponder: () => true,
                onPanResponderTerminationRequest: () => false,
                onPanResponderGrant: (event, movement): void => {
                    lockPage()
                    gesture.current = {
                        x: movement.dx,
                        y: movement.dy,
                        distance: fingerDistance(event),
                        pinched: false,
                    }
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
                onPanResponderRelease: (): void => unlockPage(),
                onPanResponderTerminate: (): void => unlockPage(),
            }),
        [draw, lockPage, unlockPage],
    )
    if (failed) return fallback
    const webEvents = Platform.OS === 'web' ? { onContextLost: (): void => fail('context_lost') } : {}
    return (
        <View style={styles.viewer} testID="piece-viewer">
            {showName ? <Heading>{piece.name}</Heading> : null}
            <View
                ref={host}
                testID="piece-viewer-gesture-surface"
                accessibilityLabel={`${piece.name}, interactive 3D view`}
                style={[styles.viewport, { height, backgroundColor: colors.surfaceSunken }]}
                onTouchStart={(event): void => {
                    const { pageX, pageY, touches } = event.nativeEvent
                    tap.current = { x: pageX, y: pageY, moved: touches.length > 1 }
                }}
                onTouchMove={(event): void => {
                    const { pageX, pageY, touches } = event.nativeEvent
                    if (touches.length > 1 || Math.hypot(pageX - tap.current.x, pageY - tap.current.y) > 6)
                        tap.current.moved = true
                }}
                onTouchEnd={(event): void => {
                    if (event.nativeEvent.touches.length > 0) return
                    if (!tap.current.moved) {
                        const now = Date.now()
                        if (now - lastTap.current < 320) {
                            scene.current?.reset()
                            draw()
                            lastTap.current = 0
                        } else lastTap.current = now
                    } else lastTap.current = 0
                }}
                {...responder.panHandlers}
            >
                <GLBoundary fallback={fallback} failed={(): void => fail('gl_surface_failed')}>
                    <Suspense fallback={fallback}>
                        <LazyGLView style={styles.gl} onContextCreate={create} onLayout={draw} {...webEvents} />
                    </Suspense>
                </GLBoundary>
            </View>
            <Caption>Drag to rotate. Pinch to zoom. Double-tap to reset.</Caption>
            {fullscreen ? null : (
                <ViewerButton
                    label="Expand"
                    accessibilityLabel={`Expand ${piece.name} 3D view`}
                    testID="piece-viewer-expand"
                    onPress={(): void => setExpanded(true)}
                />
            )}
            {fullscreen ? null : (
                <Modal
                    testID="piece-viewer-fullscreen-modal"
                    visible={expanded}
                    animationType="slide"
                    onRequestClose={(): void => setExpanded(false)}
                >
                    <SafeAreaProvider>
                        <FullscreenPieceViewer
                            piece={piece}
                            showName={showName}
                            fallback={fallback}
                            onFrame={onFrame}
                            onClose={(): void => setExpanded(false)}
                        />
                    </SafeAreaProvider>
                </Modal>
            )}
        </View>
    )
}

function FullscreenPieceViewer({
    piece,
    showName,
    fallback,
    onFrame,
    onClose,
}: {
    piece: PieceSpec
    showName: boolean
    fallback: ReactElement
    onFrame?: (timestampMs: number) => void
    onClose: () => void
}): ReactElement {
    const { colors } = useTheme()
    const { height } = useWindowDimensions()
    const insets = useSafeAreaInsets()
    return (
        <View
            testID="piece-viewer-fullscreen"
            style={[
                styles.fullscreen,
                {
                    backgroundColor: colors.canvas,
                    paddingTop: insets.top + space.md,
                    paddingBottom: insets.bottom + space.md,
                    paddingLeft: insets.left + space.md,
                    paddingRight: insets.right + space.md,
                },
            ]}
        >
            <ViewerButton
                label="Close"
                accessibilityLabel="Close 3D view"
                testID="piece-viewer-close"
                onPress={onClose}
            />
            <ValidPieceViewer
                piece={piece}
                height={Math.max(160, height - insets.top - insets.bottom - 200)}
                showName={showName}
                fallback={fallback}
                onFrame={onFrame}
                fullscreen
            />
        </View>
    )
}

const MAX_GRID_ITEMS = 30

/** One closed step-catalog entry; a named tile exists even while its 3D spec is still pending. */
export type PieceGridItem = {
    pieceId: string
    name: string
    quantity: number | null
    state?: 'pending' | 'unavailable'
}

type GridRow = {
    pieceId: string
    name: string
    quantity: number | null
    state?: PieceGridItem['state']
    spec: PieceSpec | undefined
}

/** Only a known positive safe integer is shown; an unknown count is absent rather than guessed. */
function knownQuantity(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function catalogItems(items: readonly PieceGridItem[], pieceIds: readonly string[] | undefined): PieceGridItem[] {
    if (!Array.isArray(items) || items.length > MAX_GRID_ITEMS) return []
    const ids = new Set<string>()
    for (const item of items) {
        if (!item || typeof item.pieceId !== 'string' || item.pieceId.length === 0 || typeof item.name !== 'string')
            return []
        if (ids.has(item.pieceId)) return []
        ids.add(item.pieceId)
    }
    if (pieceIds === undefined) return [...items]
    if (!Array.isArray(pieceIds)) return []
    const wanted = new Set(pieceIds)
    if (wanted.size > MAX_GRID_ITEMS) return []
    return items.filter((item) => wanted.has(item.pieceId))
}

/** Valid specs only; a spec whose id is ambiguous is dropped so its tile stays a placeholder. */
function specsById(pieces: readonly PieceSpec[]): Map<string, PieceSpec> {
    const specs = new Map<string, PieceSpec>()
    if (!Array.isArray(pieces) || pieces.length > MAX_GRID_ITEMS) return specs
    const values = pieces.map(validatedPiece).filter((piece): piece is PieceSpec => piece !== null)
    const counts = new Map<string, number>()
    for (const piece of values) counts.set(piece.id, (counts.get(piece.id) ?? 0) + 1)
    for (const piece of values) if (counts.get(piece.id) === 1) specs.set(piece.id, piece)
    return specs
}

/** One linked piece in Guide mode: its own inline viewer, with a ready marker set by the first real 3D frame. */
function GuidePieceCard({
    row,
    cutout,
    onFrame,
}: {
    row: GridRow
    cutout: string | undefined
    onFrame: ((timestampMs: number) => void) | undefined
}): ReactElement {
    const [ready, setReady] = useState(false)
    const readyRef = useRef(false)
    useFallbackLog(
        row.pieceId,
        row.spec === undefined && row.state === 'unavailable' ? 'registry_rejected_or_unavailable' : null,
    )
    const pieceFrame = useCallback(
        (timestampMs: number): void => {
            onFrame?.(timestampMs)
            if (readyRef.current) return
            readyRef.current = true
            setReady(true)
        },
        [onFrame],
    )
    const placeholder = (
        <PiecePlaceholder pieceId={row.pieceId} name={row.name} state={row.state} imageUri={cutout} showName={false} />
    )
    return (
        <View style={styles.guideCard} testID={`piece-card-${row.pieceId}`}>
            <View style={styles.guideHeader}>
                <Body>{row.name}</Body>
                {row.quantity === null ? null : (
                    <View testID={`piece-quantity-${row.pieceId}`}>
                        <Caption>{`×${row.quantity}`}</Caption>
                    </View>
                )}
            </View>
            {/* The 3D view arrives in place of its own waiting drawing; a terminal unavailable card never waits. */}
            {/* While the spec is pending only the one overlaid waiting drawing exists; the viewer replaces it in place. */}
            <LoaderSwap waiting={row.spec === undefined && row.state !== 'unavailable'} loader={placeholder}>
                {row.spec !== undefined ? (
                    <PieceViewer
                        piece={row.spec}
                        fallbackImageUri={cutout}
                        height={240}
                        showName={false}
                        onFrame={pieceFrame}
                    />
                ) : row.state === 'unavailable' ? (
                    placeholder
                ) : null}
            </LoaderSwap>
            {ready ? <View testID={`piece-viewer-ready-${row.pieceId}`} style={styles.marker} /> : null}
        </View>
    )
}

function PiecePlaceholder({
    pieceId,
    name,
    state,
    imageUri,
    showName = true,
}: {
    pieceId: string
    name: string
    state?: PieceGridItem['state']
    imageUri?: string
    showName?: boolean
}): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            testID={`piece-placeholder-${pieceId}`}
            accessibilityLabel={name}
            style={[styles.fallback, styles.placeholder, { backgroundColor: colors.surfaceSunken }]}
        >
            {state === 'unavailable' && imageUri !== undefined ? (
                <Image
                    source={{ uri: imageUri }}
                    resizeMode="contain"
                    style={styles.fallbackImage}
                    accessibilityLabel={name}
                />
            ) : null}
            {showName ? <Heading>{name}</Heading> : null}
            {/* The cutout is the piece scene's backdrop while its 3D view is prepared; an unavailable view stays static. */}
            {state === 'unavailable' ? (
                <Caption>3D view unavailable</Caption>
            ) : (
                <BlueprintLoader phase="piece" imageUri={imageUri} />
            )}
        </View>
    )
}

/** Guides show every linked piece inline; other grids share one GPU viewer selected by the 2D tiles. */
export function PiecesGrid({
    pieces,
    pieceIds,
    cutouts,
    onFrame,
    items,
}: {
    readonly pieces: readonly PieceSpec[]
    readonly pieceIds?: readonly string[]
    /** 2D cutout by piece id: the fallback picture while a piece has no usable 3D view. */
    readonly cutouts?: Readonly<Record<string, string>>
    readonly onFrame?: (timestampMs: number) => void
    /** Closed step catalog: its order and names drive the tiles; pieces only supply the 3D specs. */
    readonly items?: readonly PieceGridItem[]
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
    const rows = useMemo((): GridRow[] => {
        if (items === undefined)
            return accepted.map((piece) => ({ pieceId: piece.id, name: piece.name, quantity: null, spec: piece }))
        const specs = specsById(pieces)
        return catalogItems(items, pieceIds).map((item) => ({
            pieceId: item.pieceId,
            name: item.name,
            quantity: knownQuantity(item.quantity),
            state: item.state,
            spec: specs.get(item.pieceId),
        }))
    }, [accepted, items, pieces, pieceIds])
    const [selected, setSelected] = useState<string | null>(null)
    const current = rows.find((row) => row.pieceId === selected) ?? rows[0]
    if (current === undefined) return <PieceCard name="Assembly pieces" height={240} />
    // Guide mode: every linked piece shows its own 3D view; the legacy single shared viewer stays for non-guide grids.
    if (items !== undefined)
        return (
            <View style={styles.viewer} testID="pieces-grid">
                {rows.map((row) => (
                    <GuidePieceCard key={row.pieceId} row={row} cutout={cutouts?.[row.pieceId]} onFrame={onFrame} />
                ))}
            </View>
        )
    return (
        <View style={styles.viewer} testID="pieces-grid">
            {current.spec === undefined ? (
                <PiecePlaceholder
                    pieceId={current.pieceId}
                    name={current.name}
                    state={current.state}
                    imageUri={cutouts?.[current.pieceId]}
                />
            ) : (
                <PieceViewer piece={current.spec} fallbackImageUri={cutouts?.[current.pieceId]} onFrame={onFrame} />
            )}
            <View style={styles.grid}>
                {rows.map((row) => (
                    <Pressable
                        key={row.pieceId}
                        testID={`piece-tile-${row.pieceId}`}
                        accessibilityRole="button"
                        accessibilityLabel={`View ${row.name}`}
                        accessibilityState={{ selected: current.pieceId === row.pieceId }}
                        onPress={(): void => setSelected(row.pieceId)}
                        style={[
                            styles.tile,
                            {
                                backgroundColor: colors.surface,
                                borderColor: current.pieceId === row.pieceId ? colors.accent : colors.border,
                            },
                        ]}
                    >
                        <View style={[styles.swatch, { backgroundColor: row.spec?.color ?? colors.border }]} />
                        <Body>{row.name}</Body>
                        {row.quantity === null ? null : (
                            <View testID={`piece-quantity-${row.pieceId}`}>
                                <Caption>{`×${row.quantity}`}</Caption>
                            </View>
                        )}
                    </Pressable>
                ))}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    viewer: { gap: space.sm },
    fullscreen: { flex: 1, padding: space.md, gap: space.sm },
    viewerButton: {
        alignSelf: 'flex-start',
        minHeight: touchTarget,
        minWidth: touchTarget,
        justifyContent: 'center',
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
    },
    guideCard: { gap: space.xs },
    guideHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
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
    // Matches the default viewport height so the placeholder-to-viewer swap does not jump the page.
    placeholder: { minHeight: 320 },
    // Test-visible readiness witness only: it takes no layout space and draws nothing.
    marker: { position: 'absolute', width: 0, height: 0 },
})
