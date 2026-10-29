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
type Totals =
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
export type NativeHostSessionSummary = Totals & {
    readonly sessionId: string
    readonly platform: NativeHostCheckpoint['platform']
    readonly sampleCount: number
    readonly screens: readonly NativeHostScreenSummary[]
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

const unavailable = (reason: NativeHostFailure): Totals =>
    Object.freeze({
        status: 'unavailable',
        reason,
        counts: null,
        byHostType: null,
        rawTextCounts: null,
        generatedShare: null,
    })
const emptyCounts = (): RenderOriginCounts => ({ generated: 0, fallback: 0, shell: 0, total: 0 })
const identity = (point: NativeHostCheckpoint): string =>
    JSON.stringify([point.sessionId, point.platform, point.screen, point.checkpointId])

function add(target: RenderOriginCounts, source: Counts): void {
    for (const key of ['generated', 'fallback', 'shell', 'total'] as const) target[key] += source[key]
}

function measured(
    counts: RenderOriginCounts,
    byType: Map<string, RenderOriginCounts>,
    raw: RenderOriginCounts,
): Totals {
    if (counts.total === 0) return unavailable('empty-tree')
    return Object.freeze({
        status: 'measured',
        reason: null,
        counts: Object.freeze(counts),
        byHostType: Object.freeze(
            Object.fromEntries(Array.from(byType, ([name, values]) => [name, Object.freeze(values)])),
        ),
        rawTextCounts: Object.freeze(raw),
        generatedShare: counts.generated / counts.total,
    })
}

function aggregate(samples: readonly NativeHostMeasurement[]): Totals {
    if (samples.length === 0) return unavailable('no-checkpoints')
    const counts = emptyCounts()
    const raw = emptyCounts()
    const byType = new Map<string, RenderOriginCounts>()
    for (const sample of samples) {
        if (sample.status !== 'measured') return unavailable('incomplete-checkpoints')
        add(counts, sample.counts)
        add(raw, sample.rawTextCounts)
        for (const [name, addition] of Object.entries(sample.byHostType)) {
            const values = byType.get(name) ?? emptyCounts()
            add(values, addition)
            byType.set(name, values)
        }
    }
    return measured(counts, byType, raw)
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

/**
 * On-demand committed public-ref snapshots, not an every-commit observer or physical UIKit/Android view census.
 * Caller owns the complete app/modal root registry and supplies only opaque checkpoint identifiers. No text, props,
 * unrelated ids or native nodes are retained in results. Public id must not shadow a different nativeID marker.
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
        const stack = Array.from(roots, (node) => ({ node, origin: 'shell' as RenderOrigin }))
        const seen = new Set<NativeHostNode>()
        const counts = emptyCounts()
        const raw = emptyCounts()
        const byType = new Map<string, RenderOriginCounts>()
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
            if (node.nodeType === 3) {
                if (length !== 0) throw new Incomplete('unsupported-tree')
                raw[origin]++
                raw.total++
            } else if (node.nodeType === 1) {
                const name = node.nodeName
                const id = node.id
                if (
                    typeof name !== 'string' ||
                    name === '' ||
                    name.length > 128 ||
                    (id !== undefined && typeof id !== 'string')
                )
                    throw new Incomplete('unsupported-tree')
                origin = originFor(id, origin)
                counts[origin]++
                counts.total++
                const byName = byType.get(name) ?? emptyCounts()
                byName[origin]++
                byName.total++
                byType.set(name, byName)
            } else throw new Incomplete('unsupported-tree')
            if (length > this.maxNodes - seen.size - stack.length) throw new Incomplete('traversal-limit')
            for (let index = length - 1; index >= 0; index--) stack.push({ node: children[index]!, origin })
        }
        // Losing any earlier node/root invalidates the census, even if the last node itself stayed connected.
        for (const node of seen) if (node.isConnected !== true) throw new Incomplete('disconnected')
        for (const { ref, root } of registered) {
            if (ref.isConnected !== true || root.isConnected !== true) throw new Incomplete('disconnected')
            if (ref.ownerDocument?.documentElement !== root) throw new Incomplete('root-census-changed')
        }
        if (version !== this.rootVersion) throw new Incomplete('root-census-changed')
        return { totals: measured(counts, byType, raw), rootCount: roots.size }
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
        return Object.freeze({
            ...totals,
            sessionId,
            platform,
            sampleCount: samples.length,
            screens,
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
