import type { JsonElement } from 'test-renderer'
import { nativeMeterOriginInheritance, parseNativeMeterMarkers } from '../native-meter-markers'

export type RenderOrigin = 'generated' | 'fallback' | 'shell'

export interface RenderOriginCheckpoint {
    readonly sessionId: string
    readonly screen: string
    readonly checkpointId: string
    readonly platform: 'ios' | 'android'
    readonly evidence: 'synthetic-fixture'
}

export interface RenderOriginCounts {
    generated: number
    fallback: number
    shell: number
    total: number
}

export interface RenderOriginTotals {
    readonly counts: RenderOriginCounts
    readonly byHostType: Readonly<Record<string, RenderOriginCounts>>
    readonly rawTextCounts: RenderOriginCounts
    readonly status: 'measured' | 'unavailable'
    /** Fraction in [0, 1]; null means the host-element denominator is zero. No threshold is inferred. */
    readonly generatedShare: number | null
}

export interface RenderOriginMeasurement extends RenderOriginTotals {
    readonly checkpoint: RenderOriginCheckpoint
    readonly nodes: readonly {
        readonly path: string
        readonly hostType: string
        readonly origin: RenderOrigin
        readonly testID?: string
    }[]
}

export interface RenderOriginScreenSummary {
    readonly screen: string
    readonly sampleCount: number
    readonly counts: RenderOriginCounts
    readonly status: 'measured' | 'unavailable'
    readonly generatedShare: number | null
    /** Lowest checkpoint share for this screen. Any unavailable checkpoint makes the minimum unavailable. */
    readonly minimumGeneratedShare: number | null
}

export interface RenderOriginSessionSummary extends RenderOriginTotals {
    readonly session: Omit<RenderOriginCheckpoint, 'screen' | 'checkpointId'> | null
    readonly sampleCount: number
    readonly screens: readonly RenderOriginScreenSummary[]
    /** Lowest of the per-screen checkpoint minima, not the lowest screen's weighted aggregate. */
    readonly minimumScreenGeneratedShare: number | null
}

function emptyCounts(): RenderOriginCounts {
    return { generated: 0, fallback: 0, shell: 0, total: 0 }
}

function addCounts(target: RenderOriginCounts, counts: RenderOriginCounts): void {
    target.generated += counts.generated
    target.fallback += counts.fallback
    target.shell += counts.shell
    target.total += counts.total
}

function countOrigin(counts: RenderOriginCounts, origin: RenderOrigin): void {
    counts[origin]++
    counts.total++
}

function share(counts: RenderOriginCounts): Pick<RenderOriginTotals, 'status' | 'generatedShare'> {
    return counts.total === 0
        ? { status: 'unavailable', generatedShare: null }
        : { status: 'measured', generatedShare: counts.generated / counts.total }
}

function minimum(shares: readonly (number | null)[]): number | null {
    if (shares.length === 0 || shares.includes(null)) return null
    return shares.reduce<number>((lowest, value) => Math.min(lowest, value ?? lowest), 1)
}

function inheritanceFor(
    nativeID: unknown,
    inherited: RenderOrigin,
): { readonly origin: RenderOrigin; readonly childOrigin: RenderOrigin } {
    try {
        return nativeMeterOriginInheritance(parseNativeMeterMarkers(nativeID), inherited)
    } catch {
        throw new Error('invalid_render_origin_marker')
    }
}

/**
 * Measures every element in the supplied native test-renderer host tree. Markers belong on existing host
 * roots; the closest marked ancestor owns a node and its raw text unless a nested marker overrides it. Navigation and
 * route ownership boundaries attribute their own hosts only and reset descendant inheritance to shell. Unmarked
 * roots are shell. No supplied hidden/non-accessible host is filtered. RNTL 14 preserves React-hidden hosts in its
 * JSON; a caller using another renderer must disclose any branches it omits. This does not measure physical
 * Fabric/UIKit/Android views or OS chrome.
 * Only paths, host types, origin and optional testIDs are retained; text and other host props are never copied.
 */
export function measureRenderOriginTree(
    tree: JsonElement | null,
    checkpoint: RenderOriginCheckpoint,
): RenderOriginMeasurement {
    const counts = emptyCounts()
    const rawTextCounts = emptyCounts()
    const byHostType = new Map<string, RenderOriginCounts>()
    const nodes: RenderOriginMeasurement['nodes'][number][] = []

    function visit(node: JsonElement | string, path: string, inherited: RenderOrigin): void {
        if (typeof node === 'string') {
            countOrigin(rawTextCounts, inherited)
            return
        }
        // RNTL 14 toJSON() retains a synthetic type "" container when multiple root hosts are present.
        const container = path === '$' && node.type === ''
        const nativeID: unknown = node.props.nativeID
        const { origin, childOrigin } = container
            ? { origin: inherited, childOrigin: inherited }
            : inheritanceFor(nativeID, inherited)
        if (!container) {
            countOrigin(counts, origin)
            const typeCounts = byHostType.get(node.type) ?? emptyCounts()
            countOrigin(typeCounts, origin)
            byHostType.set(node.type, typeCounts)
            const testID: unknown = node.props.testID
            nodes.push({ path, hostType: node.type, origin, ...(typeof testID === 'string' ? { testID } : {}) })
        }
        node.children.forEach((child, index) => visit(child, `${path}/${index}`, childOrigin))
    }

    if (tree !== null) visit(tree, '$', 'shell')
    return {
        checkpoint: { ...checkpoint },
        counts,
        byHostType: Object.fromEntries(byHostType),
        rawTextCounts,
        ...share(counts),
        nodes,
    }
}

/**
 * Sums a fixed checkpoint matrix, not unique persistent device views. Duplicate identities are rejected even when
 * rerenders differ. Session/platform/evidence must agree; individual screen minima remain visible alongside weighted
 * totals. Callers must freeze their meaningful screen/state matrix before measuring; this helper cannot attest it.
 */
export function summarizeRenderOriginSession(samples: readonly RenderOriginMeasurement[]): RenderOriginSessionSummary {
    const first = samples[0]?.checkpoint
    const session =
        first === undefined ? null : { sessionId: first.sessionId, platform: first.platform, evidence: first.evidence }
    const counts = emptyCounts()
    const rawTextCounts = emptyCounts()
    const byHostType = new Map<string, RenderOriginCounts>()
    const seen = new Set<string>()
    const byScreen = new Map<string, RenderOriginMeasurement[]>()

    for (const sample of samples) {
        const point = sample.checkpoint
        if (
            session === null ||
            point.sessionId !== session.sessionId ||
            point.platform !== session.platform ||
            point.evidence !== session.evidence
        ) {
            throw new Error('mixed_render_origin_session')
        }
        const identity = JSON.stringify([
            point.sessionId,
            point.platform,
            point.evidence,
            point.screen,
            point.checkpointId,
        ])
        if (seen.has(identity)) throw new Error('duplicate_render_origin_checkpoint')
        seen.add(identity)
        const screenSamples = byScreen.get(point.screen) ?? []
        screenSamples.push(sample)
        byScreen.set(point.screen, screenSamples)
        addCounts(counts, sample.counts)
        addCounts(rawTextCounts, sample.rawTextCounts)
        for (const [type, addition] of Object.entries(sample.byHostType)) {
            const typeCounts = byHostType.get(type) ?? emptyCounts()
            addCounts(typeCounts, addition)
            byHostType.set(type, typeCounts)
        }
    }

    const screens = Array.from(byScreen, ([screen, screenSamples]): RenderOriginScreenSummary => {
        const screenCounts = emptyCounts()
        for (const sample of screenSamples) addCounts(screenCounts, sample.counts)
        return {
            screen,
            sampleCount: screenSamples.length,
            counts: screenCounts,
            ...share(screenCounts),
            minimumGeneratedShare: minimum(screenSamples.map((sample) => sample.generatedShare)),
        }
    })
    return {
        session,
        sampleCount: samples.length,
        counts,
        byHostType: Object.fromEntries(byHostType),
        rawTextCounts,
        ...share(counts),
        screens,
        minimumScreenGeneratedShare: minimum(screens.map((screen) => screen.minimumGeneratedShare)),
    }
}
