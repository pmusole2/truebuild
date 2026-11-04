import { STATE_COPY_V2 } from '@truebuild/contracts'
import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { AccessibilityInfo, StyleSheet, View } from 'react-native'
import Animated, {
    cancelAnimation,
    Easing,
    ReduceMotion,
    useAnimatedProps,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated'
import Svg, { Circle, G, Image as SvgImage, Line, Path, Rect, Text as SvgText } from 'react-native-svg'
import { useTheme } from '../theme/theme'
import { radius, space, type Colors } from '../theme/tokens'
import { useFeedback } from './feedback'
import { Body, Caption } from './text'

export type BlueprintPhase = 'reading' | 'guide' | 'piece' | 'check' | 'screen'

const AnimatedPath = Animated.createAnimatedComponent(Path)
const AnimatedLine = Animated.createAnimatedComponent(Line)
// A retained drawing stays visible during its swap fade, but no longer owns active work.
const LoaderActivityContext = createContext(true)
const SWAP_MS = 200
const PHASES: Readonly<
    Record<BlueprintPhase, { label: string; slowText: string | null; slowAfterMs: number; timeoutMs: number }>
> = {
    // Model parse and piece client budgets live in app/src/api/model-client.ts.
    reading: {
        label: 'Reading your manual',
        slowText: 'Still working; big manuals take up to a minute',
        slowAfterMs: 20_000,
        timeoutMs: 175_000,
    },
    // Repair-capable Guide work: two 45s attempts plus 2s (api/src/server/documents/service.ts).
    guide: {
        label: 'Building your guide',
        slowText: 'Still writing; this can take up to a minute and a half',
        slowAfterMs: 20_000,
        timeoutMs: 92_000,
    },
    piece: {
        label: 'Shaping the part',
        slowText: 'Still shaping this part',
        slowAfterMs: 20_000,
        timeoutMs: 120_000,
    },
    // Shortest check: 8s (app/src/api/client.ts); model check's 15s is also below the 20s threshold.
    check: { label: 'Checking your build', slowText: null, slowAfterMs: 20_000, timeoutMs: 8_000 },
    // A generic wait of any screen: the app prepares a validated screen (model or local fallback), so no duration is claimed.
    screen: {
        label: STATE_COPY_V2.pending.heading,
        slowText: null,
        slowAfterMs: 20_000,
        timeoutMs: 92_000,
    },
}

function Trace({
    d,
    timeline,
    color,
    from = 0,
    to = 0.7,
    faint = false,
    length = 540,
    testID,
}: {
    d: string
    timeline: SharedValue<number>
    color: string
    from?: number
    to?: number
    faint?: boolean
    length?: number
    testID?: string
}): ReactElement {
    const props = useAnimatedProps(() => ({
        strokeDashoffset: length * (1 - Math.min(1, Math.max(0, (timeline.value - from) / (to - from)))),
    }))
    return (
        <AnimatedPath
            testID={testID}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={faint ? 1 : 2}
            opacity={faint ? 0.45 : 1}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={`${length} ${length}`}
            animatedProps={props}
        />
    )
}

function Sweep({
    timeline,
    color,
    check,
}: {
    timeline: SharedValue<number>
    color: string
    check: boolean
}): ReactElement {
    const props = useAnimatedProps(() => {
        const y = 45 + timeline.value * 88
        return { y1: y, y2: y, opacity: 0.7 }
    })
    return (
        <AnimatedLine
            testID="blueprint-sweep"
            x1={check ? 36 : 88}
            x2={check ? 133 : 223}
            y1={133}
            y2={133}
            stroke={color}
            strokeWidth={1.5}
            animatedProps={props}
        />
    )
}

function BlueprintScene({
    phase,
    timeline,
    colors,
    imageUri,
    stepNumber,
    fit,
}: {
    phase: BlueprintPhase
    timeline: SharedValue<number>
    colors: Colors
    imageUri?: string
    stepNumber?: number
    fit: boolean
}): ReactElement {
    const { accent, inkMuted, border } = colors
    const lift = useAnimatedStyle(() => ({
        transform: [{ translateY: -12 * Math.min(1, Math.max(0, (timeline.value - 0.35) / 0.4)) }],
    }))
    return (
        <View
            testID={`blueprint-scene-${phase}`}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.scene, fit && { flex: 1, aspectRatio: undefined }]}
        >
            <Svg width="100%" height="100%" viewBox="0 0 320 180">
                <G stroke={border} strokeWidth={0.5} opacity={0.45}>
                    {[40, 80, 120, 160, 200, 240, 280].map((x) => (
                        <Line key={`x${x}`} x1={x} y1={16} x2={x} y2={164} />
                    ))}
                    {[30, 70, 110, 150].map((y) => (
                        <Line key={`y${y}`} x1={20} y1={y} x2={300} y2={y} />
                    ))}
                </G>
                <Path
                    d="M20 26V16H30 M290 16H300V26 M300 154V164H290 M30 164H20V154"
                    stroke={accent}
                    opacity={0.5}
                    fill="none"
                />
                {phase === 'reading' ? (
                    <>
                        <Trace
                            d="M92 150V30H194L217 53V150Z M194 30V53H217"
                            timeline={timeline}
                            color={inkMuted}
                            to={0.25}
                        />
                        <Trace
                            length={260}
                            d="M107 49H163 M107 59H147 M107 126H197 M107 136H174"
                            timeline={timeline}
                            color={inkMuted}
                            faint
                            from={0.1}
                            to={0.35}
                        />
                        <Sweep timeline={timeline} color={accent} check={false} />
                    </>
                ) : phase === 'guide' ? (
                    <>
                        <Trace
                            testID="blueprint-trace-card"
                            length={660}
                            d="M56 31H264V149H56Z"
                            timeline={timeline}
                            color={inkMuted}
                            to={0.25}
                        />
                        <Circle cx={78} cy={52} r={12} stroke={accent} strokeWidth={1.5} fill={colors.surfaceSunken} />
                        <SvgText x={78} y={57} fill={accent} fontSize={13} fontWeight="600" textAnchor="middle">
                            {stepNumber ?? 1}
                        </SvgText>
                        <Trace
                            length={300}
                            d="M104 96L138 76L173 96L139 116Z M139 116V129 M104 96V109L139 129L173 109V96"
                            timeline={timeline}
                            color={accent}
                            from={0.2}
                            to={0.55}
                        />
                        <Trace
                            length={95}
                            d="M187 66C222 66 231 79 223 103 M216 94L223 103L232 95"
                            timeline={timeline}
                            color={accent}
                            from={0.45}
                            to={0.7}
                        />
                        <Trace
                            length={75}
                            d="M190 121H195 M200 121H209 M214 121H221 M226 121H236 M190 132H199 M204 132H212 M217 132H228"
                            timeline={timeline}
                            color={inkMuted}
                            from={0.65}
                            to={0.95}
                        />
                    </>
                ) : phase === 'piece' ? (
                    <>
                        {imageUri === undefined ? null : (
                            <SvgImage
                                href={{ uri: imageUri }}
                                x={62}
                                y={27}
                                width={196}
                                height={126}
                                opacity={0.12}
                                preserveAspectRatio="xMidYMid meet"
                            />
                        )}
                        <Trace
                            length={260}
                            d="M72 107L128 75L184 107L128 139Z"
                            timeline={timeline}
                            color={inkMuted}
                            from={0.05}
                            to={0.4}
                        />
                        <Trace
                            length={340}
                            d="M72 107V86L128 54L184 86V107 M72 86L128 118L184 86 M128 118V139"
                            timeline={timeline}
                            color={accent}
                            from={0.4}
                            to={0.8}
                        />
                        <Trace
                            length={145}
                            d="M145 44L201 76 M194 69L201 76L191 78 M205 91V122 M201 116L205 122L209 116"
                            timeline={timeline}
                            color={inkMuted}
                            faint
                            from={0.75}
                            to={0.98}
                        />
                        <Circle cx={128} cy={86} r={9} stroke={accent} strokeWidth={1.5} fill="none" />
                    </>
                ) : phase === 'screen' ? (
                    <>
                        {/* Pages fan out, then flow into one stack: the screen being assembled, not a step count. */}
                        <Trace
                            length={250}
                            d="M50 56H112V132H50Z"
                            timeline={timeline}
                            color={inkMuted}
                            faint
                            to={0.3}
                        />
                        <Trace
                            length={250}
                            d="M60 46H122V122H60Z"
                            timeline={timeline}
                            color={inkMuted}
                            faint
                            from={0.1}
                            to={0.4}
                        />
                        <Trace
                            length={250}
                            d="M70 36H132V112H70Z"
                            timeline={timeline}
                            color={inkMuted}
                            from={0.2}
                            to={0.5}
                        />
                        <Trace
                            length={80}
                            d="M146 84H196 M188 78L196 84L188 90"
                            timeline={timeline}
                            color={accent}
                            from={0.45}
                            to={0.65}
                        />
                        <Trace
                            length={460}
                            d="M214 60H266V140H214Z M220 52H272V132 M226 44H278V124"
                            timeline={timeline}
                            color={accent}
                            from={0.6}
                            to={0.95}
                        />
                    </>
                ) : (
                    <>
                        <Rect x={32} y={36} width={105} height={108} rx={4} fill={colors.surfaceRaised} />
                        {imageUri === undefined ? null : (
                            <SvgImage
                                href={{ uri: imageUri }}
                                x={36}
                                y={40}
                                width={97}
                                height={100}
                                opacity={0.8}
                                preserveAspectRatio="xMidYMid slice"
                            />
                        )}
                        <Trace
                            length={110}
                            d="M46 63V50H59 M110 50H123V63 M123 117V130H110 M59 130H46V117"
                            timeline={timeline}
                            color={accent}
                            to={0.3}
                        />
                        <Trace
                            length={450}
                            d="M184 36H284V144H184Z M196 48H225"
                            timeline={timeline}
                            color={inkMuted}
                            from={0.15}
                            to={0.4}
                        />
                        <Trace
                            length={300}
                            d="M200 94L232 74L266 94L233 114Z M200 94V106L233 126L266 106V94 M233 114V126"
                            timeline={timeline}
                            color={accent}
                            from={0.35}
                            to={0.75}
                        />
                        <Trace
                            length={45}
                            d="M148 90H173 M167 85L173 90L167 95"
                            timeline={timeline}
                            color={accent}
                            from={0.6}
                            to={0.9}
                        />
                        <Sweep timeline={timeline} color={accent} check />
                    </>
                )}
            </Svg>
            {phase === 'reading' ? (
                <Animated.View style={[StyleSheet.absoluteFill, lift]}>
                    <Svg width="100%" height="100%" viewBox="0 0 320 180">
                        <Trace
                            d="M123 85C94 59 96 96 121 91C145 118 150 78 125 83Z M122 84A4 4 0 1 0 122 92A4 4 0 1 0 122 84 M166 83L175 74L188 87L179 96Z M162 86L169 93 M166 82L173 89 M170 78L177 85 M183 110L212 94L232 106L203 123Z M203 123V130L232 113V106 M183 110V117L203 130"
                            timeline={timeline}
                            color={accent}
                            from={0.25}
                            to={0.85}
                        />
                    </Svg>
                </Animated.View>
            ) : null}
        </View>
    )
}

/** A drawing of the work, never a percentage or a simulated pipeline milestone. */
export function BlueprintLoader({
    phase,
    label,
    announcementLabel,
    imageUri,
    stepNumber,
    pageCount,
    running = true,
    announce = true,
    testID,
    nativeID,
    compact = false,
    heading = false,
    height,
}: {
    readonly phase: BlueprintPhase
    readonly label?: string
    readonly announcementLabel?: string
    readonly imageUri?: string
    readonly stepNumber?: number
    readonly pageCount?: number
    readonly running?: boolean
    readonly announce?: boolean
    readonly testID?: string
    readonly nativeID?: string
    readonly compact?: boolean
    readonly heading?: boolean
    readonly height?: number
}): ReactElement {
    const { colors } = useTheme()
    const { reduceMotion } = useFeedback()
    const swapActive = useContext(LoaderActivityContext)
    const effectiveRunning = running && swapActive
    const timeline = useSharedValue(1)
    const announced = useRef(false)
    const [slowPhase, setSlowPhase] = useState<BlueprintPhase | null>(null)
    const config = PHASES[phase]
    const slow = effectiveRunning && slowPhase === phase
    const count = Number.isSafeInteger(pageCount) && (pageCount ?? 0) > 0 ? pageCount : undefined
    // An explicit empty label draws the scene without any sentence; an omitted label keeps the phase's own sentence.
    const sentence =
        label ?? (phase === 'reading' && count !== undefined ? `Reading your ${count}-page manual` : config.label)
    useEffect(() => {
        if (announce && effectiveRunning && !announced.current) {
            announced.current = true
            AccessibilityInfo.announceForAccessibility(announcementLabel ?? sentence)
        }
    }, [sentence, announcementLabel, effectiveRunning, announce])
    useEffect(() => {
        setSlowPhase(null)
        if (!effectiveRunning || config.slowText === null || config.slowAfterMs >= config.timeoutMs) return undefined
        const timer = setTimeout((): void => setSlowPhase(phase), config.slowAfterMs)
        return (): void => clearTimeout(timer)
    }, [phase, effectiveRunning, config])
    useEffect(() => {
        cancelAnimation(timeline)
        if (reduceMotion || !effectiveRunning) {
            timeline.value = 1
        } else {
            timeline.value = 0
            timeline.value = withRepeat(
                withTiming(1, {
                    duration: 4200,
                    easing: Easing.inOut(Easing.cubic),
                    reduceMotion: ReduceMotion.System,
                }),
                -1,
                false,
            )
        }
        return (): void => cancelAnimation(timeline)
    }, [timeline, reduceMotion, effectiveRunning])
    return (
        <View
            nativeID={nativeID}
            testID={testID ?? `blueprint-loader-${phase}`}
            style={[
                styles.loader,
                { backgroundColor: colors.surfaceSunken, borderColor: colors.border },
                compact && styles.compact,
                height === undefined ? undefined : { height: Math.max(0, height - space.lg * 2) },
            ]}
        >
            <BlueprintScene
                phase={phase}
                timeline={timeline}
                colors={colors}
                imageUri={imageUri}
                stepNumber={stepNumber}
                fit={height !== undefined}
            />
            <View
                style={styles.copy}
                accessible={heading && sentence !== ''}
                accessibilityRole={heading && sentence !== '' ? 'header' : undefined}
                accessibilityLabel={heading && sentence !== '' ? sentence : undefined}
            >
                {sentence === '' ? null : <Body style={styles.centered}>{sentence}</Body>}
                {config.slowText === null ? null : (
                    <View
                        style={[styles.slowLine, { opacity: slow ? 1 : 0 }]}
                        accessibilityElementsHidden={!slow}
                        importantForAccessibility={slow ? 'auto' : 'no-hide-descendants'}
                    >
                        <Caption style={styles.centered}>{config.slowText}</Caption>
                    </View>
                )}
            </View>
        </View>
    )
}

/** Retain the measured wait footprint only while waiting and during the 200ms outgoing fade. */
export function LoaderSwap({
    fill = false,
    waiting,
    loader,
    children,
    testID,
}: {
    readonly fill?: boolean
    readonly waiting: boolean
    readonly loader: ReactNode
    readonly children: ReactNode
    readonly testID?: string
}): ReactElement {
    const { reduceMotion } = useFeedback()
    const parentActive = useContext(LoaderActivityContext)
    const progress = useSharedValue(waiting ? 0 : 1)
    const [outgoing, setOutgoing] = useState(false)
    const [footprint, setFootprint] = useState(0)
    const wasWaiting = useRef(waiting)
    const retained = useRef(loader)
    if (waiting) retained.current = loader
    const departing = wasWaiting.current && !waiting && !reduceMotion
    const showLoader = waiting || (!reduceMotion && (outgoing || departing))
    useEffect(() => {
        const arrived = wasWaiting.current && !waiting
        wasWaiting.current = waiting
        cancelAnimation(progress)
        if (waiting) {
            progress.value = 0
            setOutgoing(false)
            return undefined
        }
        if (!arrived || reduceMotion) {
            progress.value = 1
            setOutgoing(false)
            return undefined
        }
        setOutgoing(true)
        progress.value = withTiming(1, { duration: SWAP_MS, reduceMotion: ReduceMotion.System })
        const timer = setTimeout((): void => setOutgoing(false), SWAP_MS)
        return (): void => clearTimeout(timer)
    }, [waiting, reduceMotion, progress])
    useEffect(() => (): void => cancelAnimation(progress), [progress])
    const contentStyle = useAnimatedStyle(() => ({ opacity: progress.value }))
    const loaderStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }))
    return (
        <View testID={testID} style={[styles.swap, fill && { flex: 1 }, showLoader && { minHeight: footprint }]}>
            <Animated.View
                pointerEvents={waiting ? 'none' : 'auto'}
                accessibilityElementsHidden={waiting}
                importantForAccessibility={waiting ? 'no-hide-descendants' : 'auto'}
                style={[fill && { flex: 1 }, waiting && StyleSheet.absoluteFill, contentStyle]}
            >
                {children}
            </Animated.View>
            {showLoader ? (
                <Animated.View
                    pointerEvents="none"
                    onLayout={waiting ? (event): void => setFootprint(event.nativeEvent.layout.height) : undefined}
                    accessibilityElementsHidden={!waiting}
                    importantForAccessibility={waiting ? 'auto' : 'no-hide-descendants'}
                    style={[!waiting && StyleSheet.absoluteFill, loaderStyle]}
                >
                    <LoaderActivityContext.Provider value={parentActive && waiting}>
                        {retained.current}
                    </LoaderActivityContext.Provider>
                </Animated.View>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    // The loader card is centred in its column with 24 points around it; the scene and its copy are centred within it.
    loader: {
        alignSelf: 'stretch',
        margin: space.lg,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        padding: space.md,
        gap: space.xs,
        alignItems: 'center',
    },
    compact: { padding: space.sm },
    scene: { width: '100%', aspectRatio: 320 / 180 },
    copy: { gap: space.xxs, alignSelf: 'stretch' },
    centered: { textAlign: 'center' },
    slowLine: { minHeight: 40 },
    swap: { width: '100%' },
})
