import type { HostInstance } from 'react-native'
import { nativeFrameOrigins } from '../../ui/native-frame-origin'
import {
    InvalidNativeMeterMarker,
    NATIVE_CAPABILITY_TYPES,
    nativeMeterOriginInheritance,
    parseNativeMeterMarkers,
    type NativeCapabilityType,
} from '../../ui/native-meter-markers'
import type { MeterRootKind, MeterRootSelection } from '../../ui/meter-roots'
export { NATIVE_CAPABILITY_TYPES } from '../../ui/native-meter-markers'
export type { NativeCapabilityType } from '../../ui/native-meter-markers'
import type {
    RenderOrigin,
    RenderOriginCheckpoint,
    RenderOriginCounts,
} from '../../ui/test-support/render-origin-coverage'

/** Public DOM read surface only; a native HostInstance is assignable to this structural port. */
export interface NativeHostNode {
    readonly nodeType: number
    readonly nodeName: string
    readonly isConnected: boolean
    readonly id?: string
    readonly childNodes: ArrayLike<NativeHostNode>
}

export interface NativeHostRoot {
    readonly isConnected: boolean
    readonly ownerDocument: { readonly documentElement: NativeHostNode } | null
}

/** Only opaque session and stable screen/state identifiers belong here, never manual titles or user text. */
export type NativeHostCheckpoint = Omit<RenderOriginCheckpoint, 'evidence'>
export type NativeHostFailure =
    | 'no-roots'
    | 'missing-root'
    | 'disconnected'
    | 'invalid-marker'
    | 'unsupported-tree'
    | 'traversal-limit'
    | 'root-census-changed'
    | 'incomplete-checkpoints'
    | 'no-checkpoints'
    | 'empty-tree'
    | 'disposed'
    | 'focus-unavailable'

type Counts = Readonly<RenderOriginCounts>
type HostTypes = Readonly<Record<string, Counts>>
type AllTotals =
    | {
          readonly status: 'measured'
          readonly counts: Counts
          readonly byHostType: HostTypes
          readonly rawTextCounts: Counts
          readonly generatedShare: number
          readonly reason: null
      }
    | {
          readonly status: 'unavailable'
          readonly counts: null
          readonly byHostType: null
          readonly rawTextCounts: null
          readonly generatedShare: null
          readonly reason: NativeHostFailure
      }

export const NATIVE_HOST_METRICS_VERSION = 3 as const
export interface NativeHostExcludedTotals {
    readonly counts: Counts
    readonly rawTextCounts: Counts
}
/** Disjoint exclusions: development wins, then the outermost capability boundary owns native internals once. */
export interface NativeHostExclusionReport {
    readonly development: NativeHostExcludedTotals
    readonly capabilityInternals: NativeHostExcludedTotals
    readonly byCapability: Readonly<Partial<Record<NativeCapabilityType, NativeHostExcludedTotals>>>
}
export type NativeHostStrictTotals =
    | {
          readonly strictStatus: 'measured'
          readonly strictCounts: Counts
          readonly strictByHostType: HostTypes
          readonly strictRawTextCounts: Counts
          readonly strictGeneratedShare: number
          readonly strictReason: null
      }
    | {
          readonly strictStatus: 'unavailable'
          readonly strictCounts: null
          readonly strictByHostType: null
          readonly strictRawTextCounts: null
          readonly strictGeneratedShare: null
          readonly strictReason: NativeHostFailure
      }
type Totals = AllTotals &
    NativeHostStrictTotals & {
        readonly metricsVersion: typeof NATIVE_HOST_METRICS_VERSION
        readonly exclusions: NativeHostExclusionReport | null
    }

export const NATIVE_HOST_METER_SCOPE =
    'React Native committed host/ShadowTree checkpoint of registered documents' as const
export type NativeHostMethod = 'all-mounted-native-hosts' | 'focused-visible-native-hosts'
export interface NativeHostSelectionReport {
    readonly background: NativeHostExcludedTotals
    readonly focusedRootCount: number
    readonly boundary: 'native-screen' | 'single-app-document'
    readonly overlayRootCount: number
}
export type NativeHostMethodMeasurement = Totals & {
    readonly method: NativeHostMethod
    readonly scope: string
    readonly selection: NativeHostSelectionReport | null
    readonly limitations: readonly string[]
}
export type NativeHostMethodSummary = NativeHostMethodMeasurement & {
    readonly routes: readonly (NativeHostMethodMeasurement & {
        readonly route: string
        readonly sampleCount: number
        readonly minimumGeneratedShare: number | null
        readonly minimumStrictGeneratedShare: number | null
    })[]
    readonly meanRouteGeneratedShare: number | null
    readonly meanRouteStrictGeneratedShare: number | null
    readonly minimumScreenGeneratedShare: number | null
    readonly minimumScreenStrictGeneratedShare: number | null
}
export type NativeHostMeasurement = Totals & {
    readonly methods: {
        readonly allMounted: NativeHostMethodMeasurement
        readonly focusedVisible: NativeHostMethodMeasurement
    }
    readonly checkpoint: NativeHostCheckpoint
    readonly sampledAt: number
    readonly scope: typeof NATIVE_HOST_METER_SCOPE
    readonly rootCount: number | null
}
export type NativeHostScreenSummary = Totals & {
    readonly screen: string
    readonly sampleCount: number
    readonly minimumGeneratedShare: number | null
}
/** checkpoint.screen is the caller's stable route identifier; no user path or native node identity is retained. */
export type NativeHostRouteSummary = NativeHostScreenSummary & { readonly route: string }
export type NativeHostSessionSummary = Totals & {
    readonly methods: {
        readonly allMounted: NativeHostMethodSummary
        readonly focusedVisible: NativeHostMethodSummary
    }
    readonly sessionId: string
    readonly platform: NativeHostCheckpoint['platform']
    readonly sampleCount: number
    readonly screens: readonly NativeHostScreenSummary[]
    readonly routes: readonly NativeHostRouteSummary[]
    readonly meanRouteGeneratedShare: number | null
    readonly meanRouteStrictGeneratedShare: number | null
    readonly minimumScreenGeneratedShare: number | null
}
export interface NativeHostMeterSnapshot {
    readonly version: number
    readonly stale: boolean
    readonly latest: NativeHostMeasurement | null
}
export interface NativeHostMeterOptions {
    readonly now?: () => number
    readonly maxNodes?: number
}

const unavailable = (reason: NativeHostFailure, exclusions: NativeHostExclusionReport | null = null): Totals =>
    Object.freeze({
        metricsVersion: NATIVE_HOST_METRICS_VERSION,
        status: 'unavailable',
        reason,
        counts: null,
        byHostType: null,
        rawTextCounts: null,
        generatedShare: null,
        strictStatus: 'unavailable',
        strictCounts: null,
        strictByHostType: null,
        strictRawTextCounts: null,
        strictGeneratedShare: null,
        strictReason: reason,
        exclusions,
    })
const emptyCounts = (): RenderOriginCounts => ({ generated: 0, fallback: 0, shell: 0, total: 0 })
const identity = (point: NativeHostCheckpoint): string =>
    JSON.stringify([point.sessionId, point.platform, point.screen, point.checkpointId])

function add(target: RenderOriginCounts, source: Counts): void {
    for (const key of ['generated', 'fallback', 'shell', 'total'] as const) target[key] += source[key]
}

interface Accumulator {
    counts: RenderOriginCounts
    rawTextCounts: RenderOriginCounts
    byType: Map<string, RenderOriginCounts>
}
interface ExcludedAccumulator {
    counts: RenderOriginCounts
    rawTextCounts: RenderOriginCounts
}
interface ExclusionAccumulator {
    development: ExcludedAccumulator
    capabilityInternals: ExcludedAccumulator
    byCapability: Map<NativeCapabilityType, ExcludedAccumulator>
}
const emptyExcluded = (): ExcludedAccumulator => ({ counts: emptyCounts(), rawTextCounts: emptyCounts() })
const accumulator = (): Accumulator => ({ ...emptyExcluded(), byType: new Map() })
const emptyExclusions = (): ExclusionAccumulator => ({
    development: emptyExcluded(),
    capabilityInternals: emptyExcluded(),
    byCapability: new Map(),
})

function freezeExcluded(value: ExcludedAccumulator): NativeHostExcludedTotals {
    return Object.freeze({ counts: Object.freeze(value.counts), rawTextCounts: Object.freeze(value.rawTextCounts) })
}
function freezeExclusions(value: ExclusionAccumulator): NativeHostExclusionReport {
    return Object.freeze({
        development: freezeExcluded(value.development),
        capabilityInternals: freezeExcluded(value.capabilityInternals),
        byCapability: Object.freeze(
            Object.fromEntries(Array.from(value.byCapability, ([key, counts]) => [key, freezeExcluded(counts)])),
        ),
    })
}
const freezeTypes = (byType: Accumulator['byType']): HostTypes =>
    Object.freeze(Object.fromEntries(Array.from(byType, ([name, values]) => [name, Object.freeze(values)])))

function measured(all: Accumulator, strict: Accumulator | null, exclusions: NativeHostExclusionReport | null): Totals {
    if (all.counts.total === 0) return unavailable('empty-tree', exclusions)
    const strictTotals: NativeHostStrictTotals =
        strict !== null && strict.counts.total > 0
            ? {
                  strictStatus: 'measured',
                  strictCounts: Object.freeze(strict.counts),
                  strictByHostType: freezeTypes(strict.byType),
                  strictRawTextCounts: Object.freeze(strict.rawTextCounts),
                  strictGeneratedShare: strict.counts.generated / strict.counts.total,
                  strictReason: null,
              }
            : {
                  strictStatus: 'unavailable',
                  strictCounts: null,
                  strictByHostType: null,
                  strictRawTextCounts: null,
                  strictGeneratedShare: null,
                  strictReason: strict === null ? 'incomplete-checkpoints' : 'empty-tree',
              }
    return Object.freeze({
        metricsVersion: NATIVE_HOST_METRICS_VERSION,
        status: 'measured',
        reason: null,
        counts: Object.freeze(all.counts),
        byHostType: freezeTypes(all.byType),
        rawTextCounts: Object.freeze(all.rawTextCounts),
        generatedShare: all.counts.generated / all.counts.total,
        ...strictTotals,
        exclusions,
    })
}

function addExcluded(target: ExcludedAccumulator, source: NativeHostExcludedTotals): void {
    add(target.counts, source.counts)
    add(target.rawTextCounts, source.rawTextCounts)
}
function addExclusions(target: ExclusionAccumulator, source: NativeHostExclusionReport): void {
    addExcluded(target.development, source.development)
    addExcluded(target.capabilityInternals, source.capabilityInternals)
    for (const capability of NATIVE_CAPABILITY_TYPES) {
        const addition = source.byCapability[capability]
        if (addition === undefined) continue
        const held = target.byCapability.get(capability) ?? emptyExcluded()
        addExcluded(held, addition)
        target.byCapability.set(capability, held)
    }
}
function addAccumulator(target: Accumulator, counts: Counts, raw: Counts, byType: HostTypes): void {
    add(target.counts, counts)
    add(target.rawTextCounts, raw)
    for (const [name, addition] of Object.entries(byType)) {
        const values = target.byType.get(name) ?? emptyCounts()
        add(values, addition)
        target.byType.set(name, values)
    }
}

function aggregate(samples: readonly Totals[]): Totals {
    if (samples.length === 0) return unavailable('no-checkpoints')
    const all = accumulator()
    const strict = accumulator()
    const exclusions = emptyExclusions()
    let complete = true
    let strictComplete = true
    let auditComplete = true
    for (const sample of samples) {
        if (sample.status !== 'measured') complete = false
        else addAccumulator(all, sample.counts, sample.rawTextCounts, sample.byHostType)
        if (sample.strictStatus !== 'measured') strictComplete = false
        else addAccumulator(strict, sample.strictCounts, sample.strictRawTextCounts, sample.strictByHostType)
        if (sample.exclusions === null) auditComplete = false
        else addExclusions(exclusions, sample.exclusions)
    }
    const report = auditComplete ? freezeExclusions(exclusions) : null
    return complete
        ? measured(all, strictComplete ? strict : null, report)
        : unavailable('incomplete-checkpoints', report)
}

function mean(shares: readonly (number | null)[]): number | null {
    if (shares.length === 0 || shares.includes(null)) return null
    return shares.reduce<number>((sum, share) => sum + (share ?? 0), 0) / shares.length
}

function minimum(shares: readonly (number | null)[]): number | null {
    if (shares.length === 0 || shares.includes(null)) return null
    return shares.reduce<number>((lowest, share) => Math.min(lowest, share ?? lowest), 1)
}

class Incomplete extends Error {
    constructor(readonly reason: NativeHostFailure) {
        super(reason)
    }
}

function count(target: ExcludedAccumulator, origin: RenderOrigin, raw: boolean): void {
    const counts = raw ? target.rawTextCounts : target.counts
    counts[origin]++
    counts.total++
}
function countHost(target: Accumulator, origin: RenderOrigin, name: string, raw: boolean): void {
    count(target, origin, raw)
    if (raw) return
    const values = target.byType.get(name) ?? emptyCounts()
    values[origin]++
    values.total++
    target.byType.set(name, values)
}

interface PendingNode {
    node: NativeHostNode
    parent: NativeHostNode | null
    origin: RenderOrigin
    development: boolean
    capability: NativeCapabilityType | null
}
interface CensusNode extends PendingNode {
    readonly raw: boolean
    readonly name: string
}
type Registration = {
    readonly ref: NativeHostRoot | null
    readonly kind: MeterRootKind | null
    readonly selection: MeterRootSelection | undefined
}
const LIMITATIONS = Object.freeze([
    'Committed public host DOM, not a physical UIKit/Android view or pixel census.',
    'Focus and overlay visibility come from trusted mounted registrations; public DOM does not expose occlusion.',
])
const methodResult = (
    totals: Totals,
    method: NativeHostMethod,
    selection: NativeHostSelectionReport | null = null,
): NativeHostMethodMeasurement =>
    Object.freeze({
        ...totals,
        method,
        scope:
            method === 'all-mounted-native-hosts'
                ? NATIVE_HOST_METER_SCOPE
                : 'React Native committed public hosts of the focused screen and visible registered sheets/modals',
        selection,
        limitations: LIMITATIONS,
    })
const isScreen = (name: string): boolean => /^(?:RN:)?(?:RNSScreen|RNSModalScreen)$/u.test(name)
const isModal = (name: string): boolean =>
    /^(?:RN:)?(?:RCTModalHostView|ModalHostView|Modal|RNSFullWindowOverlay)$/u.test(name)
const isDebuggingOverlay = (name: string): boolean => /^(?:RN:)?DebuggingOverlay$/u.test(name)

function reduceCensus(nodes: readonly CensusNode[]): Totals {
    const all = accumulator()
    const strict = accumulator()
    const exclusions = emptyExclusions()
    for (const { origin, raw, name, development, capability } of nodes) {
        if (development) count(exclusions.development, origin, raw)
        else {
            countHost(all, origin, name, raw)
            if (capability === null) countHost(strict, origin, name, raw)
            else {
                count(exclusions.capabilityInternals, origin, raw)
                const byCapability = exclusions.byCapability.get(capability) ?? emptyExcluded()
                count(byCapability, origin, raw)
                exclusions.byCapability.set(capability, byCapability)
            }
        }
    }
    return measured(all, strict, freezeExclusions(exclusions))
}

function summarizeMethod(
    samples: readonly NativeHostMeasurement[],
    key: 'allMounted' | 'focusedVisible',
): NativeHostMethodSummary {
    const method = key === 'allMounted' ? 'all-mounted-native-hosts' : 'focused-visible-native-hosts'
    const groups = new Map<string, NativeHostMethodMeasurement[]>()
    for (const sample of samples) {
        const held = groups.get(sample.checkpoint.screen) ?? []
        held.push(sample.methods[key])
        groups.set(sample.checkpoint.screen, held)
    }
    const routes = Object.freeze(
        Array.from(groups, ([route, points]) =>
            Object.freeze({
                ...methodResult(aggregate(points), method),
                route,
                sampleCount: points.length,
                minimumGeneratedShare: minimum(points.map((point) => point.generatedShare)),
                minimumStrictGeneratedShare: minimum(points.map((point) => point.strictGeneratedShare)),
            }),
        ),
    )
    return Object.freeze({
        ...methodResult(aggregate(samples.map((sample) => sample.methods[key])), method),
        routes,
        meanRouteGeneratedShare: mean(routes.map((route) => route.generatedShare)),
        meanRouteStrictGeneratedShare: mean(routes.map((route) => route.strictGeneratedShare)),
        minimumScreenGeneratedShare: minimum(routes.map((route) => route.minimumGeneratedShare)),
        minimumScreenStrictGeneratedShare: minimum(routes.map((route) => route.minimumStrictGeneratedShare)),
    })
}

/**
 * On-demand committed public-ref snapshots, not an every-commit observer or physical UIKit/Android view census.
 * Caller owns the complete app/modal root registry and supplies only opaque checkpoint identifiers. No text, props,
 * unrelated ids or native nodes are retained in results. Public id must not shadow a different nativeID marker.
 * CameraView/ManualPage markers may surround actual camera pixels/manual image internals only, never
 * model-configured text, icons, layout, controlled children, document panes or navigation chrome. A closed marker alone cannot prove
 * that semantic placement: the trusted renderer/root registry still needs independent review. Only the actual DebuggingOverlay subtree is excluded as development; a marker on another host fails closed. Known root/navigation host names beneath any exclusion instead invalidate the census.
 */
export class NativeHostMeter {
    private readonly listeners = new Set<() => void>()
    private readonly roots = new Map<symbol, Registration>()
    private readonly samples = new Map<string, NativeHostMeasurement>()
    private readonly now: () => number
    private readonly maxNodes: number
    private rootVersion = 0
    private snapshot: NativeHostMeterSnapshot = Object.freeze({ version: 0, stale: true, latest: null })
    private disposed = false
    constructor(options: NativeHostMeterOptions = {}) {
        this.now = options.now ?? Date.now
        // Bound synchronous native reads. This correctness guard is not a coverage or cost target.
        this.maxNodes = options.maxNodes ?? 20_000
        if (!Number.isSafeInteger(this.maxNodes) || this.maxNodes <= 0)
            throw new Error('invalid_native_host_meter_limit')
    }
    registerRoot(
        ref: HostInstance | NativeHostRoot | null,
        options?: MeterRootSelection & { readonly kind: MeterRootKind },
    ): () => void {
        if (this.disposed) return (): void => {}
        const token = Symbol()
        this.roots.set(token, { ref, kind: options?.kind ?? null, selection: options })
        this.rootVersion++
        this.publish(this.snapshot.latest, true)
        return (): void => {
            if (!this.roots.delete(token)) return
            this.rootVersion++
            this.publish(this.snapshot.latest, true)
        }
    }
    subscribe = (listener: () => void): (() => void) => {
        if (this.disposed) return (): void => {}
        this.listeners.add(listener)
        return (): void => {
            this.listeners.delete(listener)
        }
    }
    getSnapshot = (): NativeHostMeterSnapshot => this.snapshot
    private publish(latest: NativeHostMeasurement | null, stale: boolean): void {
        this.snapshot = Object.freeze({ version: this.snapshot.version + 1, stale, latest })
        for (const listener of this.listeners) listener()
    }
    markStale(): void {
        if (!this.disposed && !this.snapshot.stale) this.publish(this.snapshot.latest, true)
    }

    private traverse(checkpoint: NativeHostCheckpoint): {
        totals: Totals
        focused: NativeHostMethodMeasurement
        rootCount: number
    } {
        if (this.roots.size === 0) throw new Incomplete('no-roots')
        const version = this.rootVersion
        const registered: { ref: NativeHostRoot; root: NativeHostNode }[] = []
        const roots = new Set<NativeHostNode>()
        for (const { ref } of this.roots.values()) {
            if (ref === null) throw new Incomplete('missing-root')
            if (ref.isConnected !== true) throw new Incomplete('disconnected')
            const root = ref.ownerDocument?.documentElement
            if (root == null || root.nodeType !== 1) throw new Incomplete('unsupported-tree')
            registered.push({ ref, root })
            roots.add(root)
        }
        const stack: PendingNode[] = Array.from(roots, (node) => ({
            node,
            parent: null,
            origin: 'shell',
            development: false,
            capability: null,
        }))
        const seen = new Set<NativeHostNode>()
        const census: CensusNode[] = []
        const frameMarkers = new Map<NativeHostNode, string>()
        while (stack.length > 0) {
            const entry = stack.pop()!
            const node = entry.node
            if (typeof node !== 'object' || node === null || seen.has(node)) throw new Incomplete('unsupported-tree')
            if (seen.size >= this.maxNodes) throw new Incomplete('traversal-limit')
            seen.add(node)
            if (node.isConnected !== true) throw new Incomplete('disconnected')
            const children = node.childNodes
            const length = children?.length
            if (length == null || !Number.isSafeInteger(length) || length < 0) throw new Incomplete('unsupported-tree')
            let origin = entry.origin
            let childOrigin = origin
            let development = entry.development
            let capability = entry.capability
            const raw = node.nodeType === 3
            let name = ''
            if (raw) {
                if (length !== 0) throw new Incomplete('unsupported-tree')
            } else if (node.nodeType === 1) {
                name = node.nodeName
                const id = node.id
                if (
                    typeof name !== 'string' ||
                    name === '' ||
                    name.length > 128 ||
                    (id !== undefined && typeof id !== 'string')
                )
                    throw new Incomplete('unsupported-tree')
                const frameMarker = nativeFrameOrigins.markerFor(node)
                if (frameMarker !== undefined) frameMarkers.set(node, frameMarker)
                const markers = parseNativeMeterMarkers(frameMarker ?? id)
                const inheritance = nativeMeterOriginInheritance(markers, origin)
                origin = inheritance.origin
                childOrigin = inheritance.childOrigin
                // A development marker alone never authorizes hiding ordinary application content.
                if (markers.development && !isDebuggingOverlay(name)) throw new Incomplete('invalid-marker')
                development ||= isDebuggingOverlay(name)
                // Only actual camera pixels and manual image internals are outside the strict denominator.
                const eligible =
                    markers.capability === 'CameraView' || markers.capability === 'ManualPage'
                        ? markers.capability
                        : null
                capability ??= eligible
                if (
                    (development || capability !== null) &&
                    /^(?:RN:)?(?:RootView|RCTRootView|RNSScreen.*|RNSModalScreen)$/u.test(name)
                )
                    throw new Incomplete('invalid-marker')
            } else throw new Incomplete('unsupported-tree')
            census.push({ ...entry, origin, development, capability, raw, name })
            if (length > this.maxNodes - seen.size - stack.length) throw new Incomplete('traversal-limit')
            for (let index = length - 1; index >= 0; index--)
                stack.push({ node: children[index]!, parent: node, origin: childOrigin, development, capability })
        }
        // No selected subset can rescue an incomplete mounted census.
        for (const node of seen) if (node.isConnected !== true) throw new Incomplete('disconnected')
        for (const [node, marker] of frameMarkers) {
            if (nativeFrameOrigins.markerFor(node) !== marker) throw new Incomplete('root-census-changed')
        }
        for (const { ref, root } of registered) {
            if (ref.isConnected !== true || root.isConnected !== true) throw new Incomplete('disconnected')
            if (ref.ownerDocument?.documentElement !== root) throw new Incomplete('root-census-changed')
        }
        if (version !== this.rootVersion) throw new Incomplete('root-census-changed')
        const totals = reduceCensus(census)
        let focused: NativeHostMethodMeasurement
        try {
            focused = this.focused(census, checkpoint)
        } catch (error) {
            focused = methodResult(
                unavailable(error instanceof Incomplete ? error.reason : 'unsupported-tree'),
                'focused-visible-native-hosts',
            )
        }
        return { totals, focused, rootCount: roots.size }
    }

    private focused(census: readonly CensusNode[], checkpoint: NativeHostCheckpoint): NativeHostMethodMeasurement {
        const registrations = [...this.roots.values()]
        const apps = registrations.filter((entry) => entry.kind === 'app')
        if (
            apps.length === 0 ||
            apps.some((entry) => typeof entry.selection?.focused !== 'boolean' || !entry.selection.screen)
        )
            throw new Incomplete('focus-unavailable')
        const focused = apps.filter((entry) => entry.selection?.focused === true)
        if (focused.length !== 1 || focused[0]!.selection?.screen !== checkpoint.screen)
            throw new Incomplete('focus-unavailable')
        const byNode = new Map<object, CensusNode>(census.map((entry) => [entry.node, entry]))
        const at = (registration: Registration): CensusNode => {
            if (registration.ref === null) throw new Incomplete('missing-root')
            const entry = byNode.get(registration.ref)
            if (entry === undefined) throw new Incomplete('missing-root')
            return entry
        }
        const ancestors = (entry: CensusNode): CensusNode[] => {
            const path = [entry]
            while (entry.parent !== null) {
                const parent = byNode.get(entry.parent)
                if (parent === undefined) throw new Incomplete('unsupported-tree')
                path.push(parent)
                entry = parent
            }
            return path
        }
        const focusedPath = ancestors(at(focused[0]!))
        const focusedScreen = focusedPath.find((entry) => isScreen(entry.name))
        const focusedBoundary = focusedScreen ?? focusedPath.at(-1)!
        const focusedDocument = focusedPath.at(-1)!.node
        const excluded = new Set<NativeHostNode>()
        for (const entry of census) {
            if (isScreen(entry.name) && entry.node !== focusedBoundary.node && !focusedPath.includes(entry))
                excluded.add(entry.node)
        }
        for (const app of apps) {
            if (app === focused[0]) continue
            const path = ancestors(at(app))
            const screen = path.find((entry) => isScreen(entry.name))
            if (
                path.at(-1)!.node === focusedDocument &&
                (focusedScreen === undefined || screen === undefined || screen.node === focusedScreen.node)
            )
                throw new Incomplete('unsupported-tree')
            excluded.add((screen ?? path.at(-1)!).node)
        }
        const overlayBoundary = (registration: Registration): CensusNode => {
            const path = ancestors(at(registration))
            const modal = path.find((entry) => isModal(entry.name))
            if (modal !== undefined) return modal
            if (path.at(-1)!.node !== focusedDocument) return path.at(-1)!
            throw new Incomplete('unsupported-tree')
        }
        // A camera is a local capability, not an independently visible overlay. Background cameras stay background.
        const overlayRegistrations = registrations.filter((entry) => entry.kind === 'sheet' || entry.kind === 'coach')
        for (const registration of overlayRegistrations) {
            if (registration.selection?.visible === false) excluded.add(overlayBoundary(registration).node)
        }
        const overlays = overlayRegistrations.filter((entry) => entry.selection?.visible !== false).map(overlayBoundary)
        const overlaySet = new Set(overlays.map((entry) => entry.node))
        const kept: CensusNode[] = []
        const background = emptyExcluded()
        const membership = new Map<
            NativeHostNode,
            { overlay: boolean; focusedDocument: boolean; background: boolean }
        >()
        for (const entry of census) {
            const parent = entry.parent === null ? undefined : membership.get(entry.parent)
            const state = {
                overlay: overlaySet.has(entry.node) || parent?.overlay === true,
                focusedDocument: entry.node === focusedDocument || parent?.focusedDocument === true,
                background: excluded.has(entry.node) || parent?.background === true,
            }
            membership.set(entry.node, state)
            if (state.overlay || (state.focusedDocument && !state.background)) kept.push(entry)
            else count(background, entry.origin, entry.raw)
        }
        return methodResult(
            reduceCensus(kept),
            'focused-visible-native-hosts',
            Object.freeze({
                background: freezeExcluded(background),
                focusedRootCount: 1,
                boundary: focusedScreen === undefined ? 'single-app-document' : 'native-screen',
                overlayRootCount: overlays.length,
            }),
        )
    }

    sample(checkpoint: NativeHostCheckpoint): NativeHostMeasurement {
        let totals = unavailable(this.disposed ? 'disposed' : 'no-roots')
        let rootCount: number | null = null
        let focused = methodResult(totals, 'focused-visible-native-hosts')
        const key = identity(checkpoint)
        if (!this.disposed) {
            try {
                const result = this.traverse(checkpoint)
                totals = result.totals
                rootCount = result.rootCount
                focused = result.focused
            } catch (error) {
                totals = unavailable(
                    error instanceof Incomplete
                        ? error.reason
                        : error instanceof InvalidNativeMeterMarker
                          ? 'invalid-marker'
                          : 'unsupported-tree',
                )
                focused = methodResult(totals, 'focused-visible-native-hosts')
            }
        }
        const result: NativeHostMeasurement = Object.freeze({
            ...totals,
            methods: Object.freeze({
                allMounted: methodResult(totals, 'all-mounted-native-hosts'),
                focusedVisible: focused,
            }),
            checkpoint: Object.freeze({
                sessionId: checkpoint.sessionId,
                platform: checkpoint.platform,
                screen: checkpoint.screen,
                checkpointId: checkpoint.checkpointId,
            }),
            sampledAt: this.now(),
            scope: NATIVE_HOST_METER_SCOPE,
            rootCount,
        })
        if (!this.disposed) {
            this.samples.set(key, result)
            this.publish(result, false)
        }
        return result
    }

    summarizeSession(sessionId: string, platform: NativeHostCheckpoint['platform']): NativeHostSessionSummary {
        const samples = [...this.samples.values()].filter(
            (sample) => sample.checkpoint.sessionId === sessionId && sample.checkpoint.platform === platform,
        )
        const groups = new Map<string, NativeHostMeasurement[]>()
        for (const sample of samples) {
            const held = groups.get(sample.checkpoint.screen) ?? []
            held.push(sample)
            groups.set(sample.checkpoint.screen, held)
        }
        const screens = Object.freeze(
            Array.from(groups, ([screen, points]): NativeHostScreenSummary =>
                Object.freeze({
                    ...aggregate(points),
                    screen,
                    sampleCount: points.length,
                    minimumGeneratedShare: minimum(points.map((point) => point.generatedShare)),
                }),
            ),
        )
        const totals = aggregate(samples)
        const routes = Object.freeze(
            screens.map((screen): NativeHostRouteSummary =>
                Object.freeze({
                    ...screen,
                    route: screen.screen,
                }),
            ),
        )
        return Object.freeze({
            ...totals,
            methods: Object.freeze({
                allMounted: summarizeMethod(samples, 'allMounted'),
                focusedVisible: summarizeMethod(samples, 'focusedVisible'),
            }),
            sessionId,
            platform,
            sampleCount: samples.length,
            screens,
            routes,
            meanRouteGeneratedShare: mean(routes.map((route) => route.generatedShare)),
            meanRouteStrictGeneratedShare: mean(routes.map((route) => route.strictGeneratedShare)),
            minimumScreenGeneratedShare:
                totals.status === 'measured' ? minimum(screens.map((screen) => screen.minimumGeneratedShare)) : null,
        })
    }

    clearSession(sessionId: string, platform: NativeHostCheckpoint['platform']): void {
        for (const [key, sample] of this.samples)
            if (sample.checkpoint.sessionId === sessionId && sample.checkpoint.platform === platform)
                this.samples.delete(key)
        const latest = this.snapshot.latest
        const clearingLatest = latest?.checkpoint.sessionId === sessionId && latest.checkpoint.platform === platform
        if (!this.disposed) this.publish(clearingLatest ? null : latest, clearingLatest || this.snapshot.stale)
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.roots.clear()
        this.samples.clear()
        this.publish(null, true)
        this.listeners.clear()
    }
}
