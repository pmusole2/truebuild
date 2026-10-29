import type { HostInstance } from 'react-native'
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

export const NATIVE_HOST_METRICS_VERSION = 2 as const
export const NATIVE_CAPABILITY_TYPES = [
    'CameraView',
    'ManualPage',
    'PieceTile',
    'VerdictCard',
    'JudgePanel',
    'CompareColumns',
    'CoachMark',
] as const
export type NativeCapabilityType = (typeof NATIVE_CAPABILITY_TYPES)[number]
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
export type NativeHostMeasurement = Totals & {
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

function aggregate(samples: readonly NativeHostMeasurement[]): Totals {
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

function originFor(id: string | undefined, inherited: RenderOrigin): RenderOrigin {
    switch (id) {
        case 'truebuild-render-origin:generated':
            return 'generated'
        case 'truebuild-render-origin:fallback':
            return 'fallback'
        case 'truebuild-render-origin:shell':
            return 'shell'
        default:
            if (id === 'truebuild-render-origin' || id?.startsWith('truebuild-render-origin:'))
                throw new Incomplete('invalid-marker')
            return inherited
    }
}

function boundaryFor(id: string | undefined): { development: boolean; capability: NativeCapabilityType | null } {
    const capabilityNamespace = 'truebuild-capability-internals'
    const developmentNamespace = 'truebuild-meter-exclude'
    if (id === developmentNamespace || id?.startsWith(`${developmentNamespace}:`)) {
        if (id !== `${developmentNamespace}:development`) throw new Incomplete('invalid-marker')
        return { development: true, capability: null }
    }
    if (id === capabilityNamespace || id?.startsWith(`${capabilityNamespace}:`)) {
        const capability = NATIVE_CAPABILITY_TYPES.find((type) => id === `${capabilityNamespace}:${type}`)
        if (capability === undefined) throw new Incomplete('invalid-marker')
        return { development: false, capability }
    }
    return { development: false, capability: null }
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
    origin: RenderOrigin
    development: boolean
    capability: NativeCapabilityType | null
}

/**
 * On-demand committed public-ref snapshots, not an every-commit observer or physical UIKit/Android view census.
 * Caller owns the complete app/modal root registry and supplies only opaque checkpoint identifiers. No text, props,
 * unrelated ids or native nodes are retained in results. Public id must not shadow a different nativeID marker.
 * Capability markers may surround actual native implementation internals only, never model-configured text, icons,
 * layout, controlled children, CompareColumns document panes or navigation chrome. A closed marker alone cannot prove
 * that semantic placement: the trusted renderer/root registry still needs independent review. No native type grants
 * an exclusion. Known root/navigation host names beneath any exclusion instead invalidate the census.
 */
export class NativeHostMeter {
    private readonly listeners = new Set<() => void>()
    private readonly roots = new Map<symbol, NativeHostRoot | null>()
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
    registerRoot(ref: HostInstance | NativeHostRoot | null): () => void {
        if (this.disposed) return (): void => {}
        const token = Symbol()
        this.roots.set(token, ref)
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

    private traverse(): { totals: Totals; rootCount: number } {
        if (this.roots.size === 0) throw new Incomplete('no-roots')
        const version = this.rootVersion
        const registered: { ref: NativeHostRoot; root: NativeHostNode }[] = []
        const roots = new Set<NativeHostNode>()
        for (const ref of this.roots.values()) {
            if (ref === null) throw new Incomplete('missing-root')
            if (ref.isConnected !== true) throw new Incomplete('disconnected')
            const root = ref.ownerDocument?.documentElement
            if (root == null || root.nodeType !== 1) throw new Incomplete('unsupported-tree')
            registered.push({ ref, root })
            roots.add(root)
        }
        const stack: PendingNode[] = Array.from(roots, (node) => ({
            node,
            origin: 'shell',
            development: false,
            capability: null,
        }))
        const seen = new Set<NativeHostNode>()
        const all = accumulator()
        const strict = accumulator()
        const exclusions = emptyExclusions()
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
                origin = originFor(id, origin)
                // Still parse every excluded descendant: malformed markers must never hide behind an exclusion.
                const boundary = boundaryFor(id)
                development ||= boundary.development
                capability ??= boundary.capability
                if (
                    (development || capability !== null) &&
                    /^(?:RN:)?(?:RootView|RCTRootView|RNSScreen.*)$/u.test(name)
                ) {
                    throw new Incomplete('invalid-marker')
                }
            } else throw new Incomplete('unsupported-tree')
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
            if (length > this.maxNodes - seen.size - stack.length) throw new Incomplete('traversal-limit')
            for (let index = length - 1; index >= 0; index--) {
                stack.push({ node: children[index]!, origin, development, capability })
            }
        }
        // Losing any earlier node/root invalidates the census, even if the last node itself stayed connected.
        for (const node of seen) if (node.isConnected !== true) throw new Incomplete('disconnected')
        for (const { ref, root } of registered) {
            if (ref.isConnected !== true || root.isConnected !== true) throw new Incomplete('disconnected')
            if (ref.ownerDocument?.documentElement !== root) throw new Incomplete('root-census-changed')
        }
        if (version !== this.rootVersion) throw new Incomplete('root-census-changed')
        return { totals: measured(all, strict, freezeExclusions(exclusions)), rootCount: roots.size }
    }

    sample(checkpoint: NativeHostCheckpoint): NativeHostMeasurement {
        let totals = unavailable(this.disposed ? 'disposed' : 'no-roots')
        let rootCount: number | null = null
        const key = identity(checkpoint)
        if (!this.disposed) {
            try {
                const result = this.traverse()
                totals = result.totals
                rootCount = result.rootCount
            } catch (error) {
                totals = unavailable(error instanceof Incomplete ? error.reason : 'unsupported-tree')
            }
        }
        const result: NativeHostMeasurement = Object.freeze({
            ...totals,
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
