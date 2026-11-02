import {
    INTENT_TARGETS,
    TIP_TARGETS,
    screenDocumentSchema,
    type AppIntent,
    type ScreenDocument,
    type ScreenNode,
} from '@truebuild/contracts'

/** Facts the screen already holds from the controller; a document may never contradict them. */
export type ScreenFacts = {
    /** The verdict actually held for the current capture, when this is a result screen. */
    readonly decision?: 'pass' | 'refuse' | 'cannot_verify' | null
    /** Tip targets that exist on this screen now. A tip for anything else is dropped. */
    readonly tipTargets?: readonly string[]
}

export type GuardedScreen = {
    readonly document: ScreenDocument
    readonly origin: 'generated' | 'fallback'
    readonly body: readonly ScreenNode[]
    /** The document path (`body.N`) of each kept node, so its server-owned origin is still found after nodes are dropped. */
    readonly paths: readonly string[]
    /** Count of nodes removed by the client: unknown tips, contradicted banners. Reported, never hidden. */
    readonly dropped: number
}

/** Strict parse of a response document. A future version, extra field or malformed value is simply not a document. */
export function parseDocument(value: unknown): ScreenDocument | null {
    const parsed = screenDocumentSchema.safeParse(value)
    return parsed.success ? parsed.data : null
}

/** True only for an intent/target pair in the frozen allowlist. The schema already enforces it; this is the app's own check. */
export function intentAllowed(intent: AppIntent): boolean {
    const targets = (INTENT_TARGETS as Readonly<Record<string, readonly string[] | undefined>>)[intent.intent]
    return targets?.includes(intent.target) ?? false
}

/** A verdict banner states a verdict the person acts on; it survives only when it is the verdict actually held. */
function contradicts(node: ScreenNode, facts: ScreenFacts): boolean {
    return (
        node.type === 'ResultBanner' &&
        (facts.decision === undefined || facts.decision === null || node.verdict !== facts.decision)
    )
}

function filterNode(node: ScreenNode, facts: ScreenFacts, counter: { dropped: number }): ScreenNode | null {
    if (node.type === 'Tip' && facts.tipTargets !== undefined && !facts.tipTargets.includes(node.targetId)) {
        counter.dropped++
        return null
    }
    if (node.type === 'Tip' && !(TIP_TARGETS as readonly string[]).includes(node.targetId)) {
        counter.dropped++
        return null
    }
    if (contradicts(node, facts)) {
        counter.dropped++
        return null
    }
    if (node.type === 'Group' || node.type === 'DetailsDisclosure') {
        // Children keep their positions (their origins are keyed by position), so one that cannot stand drops the group.
        if (node.children.some((child) => contradicts(child, facts))) {
            counter.dropped++
            return null
        }
    }
    return node
}

/**
 * Client-side enforcement on top of the server's: every allowlisted intent, only existing tip targets, and a result
 * banner that matches the held verdict. A document whose verdict banner contradicts the held verdict is rejected whole
 * rather than patched, because the rest of its wording was composed around the wrong outcome.
 */
export function guardDocument(document: ScreenDocument, facts: ScreenFacts): GuardedScreen | null {
    if (document.metadata.source === 'shell') return null
    const intents: AppIntent[] = [document.bar.primary.intent]
    if (document.bar.secondary !== null) intents.push(document.bar.secondary.intent)
    if (document.header.trailing !== null) intents.push(document.header.trailing)
    if (!intents.every(intentAllowed)) return null
    const banners = document.body.flatMap((node) => (node.type === 'ResultBanner' ? [node] : []))
    if (document.kind === 'result') {
        // The result screen is composed around the held verdict. Any other banner means it was composed around a
        // different outcome, so none of its wording can be trusted.
        if (facts.decision === undefined || facts.decision === null) return null
        if (banners.some((banner) => banner.verdict !== facts.decision)) return null
    }
    const counter = { dropped: 0 }
    const kept: { node: ScreenNode; path: string }[] = []
    document.body.forEach((node, index) => {
        const filtered = filterNode(node, facts, counter)
        if (filtered !== null) kept.push({ node: filtered, path: `body.${index}` })
    })
    return {
        document,
        origin: document.metadata.source === 'generated' ? 'generated' : 'fallback',
        body: kept.map((entry) => entry.node),
        paths: kept.map((entry) => entry.path),
        dropped: counter.dropped,
    }
}
