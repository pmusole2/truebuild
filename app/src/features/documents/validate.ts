import { INTENT_TARGETS, nodeTextRefsV2, type AppIntent } from '@truebuild/contracts'
import { flattenFrameNodes, type FrameDocument, type FrameNode } from './types'

export type FrameValidation = { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] }

function intentKnown(intent: AppIntent): boolean {
    const targets = (INTENT_TARGETS as Readonly<Record<string, readonly string[] | undefined>>)[intent.intent]
    return targets?.includes(intent.target) ?? false
}

function collectIntents(nodes: readonly FrameNode[], out: AppIntent[]): void {
    for (const leaf of flattenFrameNodes(nodes)) {
        switch (leaf.type) {
            case 'ChoiceList':
                leaf.options.forEach((option) => out.push(option.intent))
                break
            case 'ConfirmFact':
                out.push(leaf.confirm)
                if (leaf.dismiss !== null) out.push(leaf.dismiss)
                break
            case 'ActionLink':
                out.push(leaf.intent)
                break
            case 'PageGallery':
                if (leaf.action !== null) out.push(leaf.action)
                break
            default:
                break
        }
    }
}

function placedFactIds(document: FrameDocument): Set<string> {
    const ids = new Set<string>()
    const factText = new Map((document.manualFacts ?? []).map((fact) => [fact.factId, fact.text]))
    for (const leaf of flattenFrameNodes(document.body)) {
        if (leaf.type === 'ManualDirections') leaf.factIds.forEach((id) => ids.add(id))
        // A v2 fact witness: a Text node carrying the fact ref, or adapted text stating the fact verbatim.
        if (leaf.type === 'V2Leaf') {
            nodeTextRefsV2(leaf.node).forEach((ref) => {
                if (ref.kind === 'fact') ids.add(ref.factId)
            })
        }
        if (leaf.type === 'Instruction' || leaf.type === 'Warning') {
            for (const [factId, text] of factText) if (text === leaf.text) ids.add(factId)
        }
    }
    return ids
}

/** Citations render once per fact. Duplicated citation indexes collapse; the document is not credited twice. */
export function dedupeCitations(citations: readonly number[]): readonly number[] {
    return [...new Set(citations)]
}

/**
 * Client reject/repair gate. A document that omits a mandatory safety/citation/action witness, names an unknown
 * intent, or lacks its one primary is rejected whole (the caller renders a complete deterministic fallback
 * document instead). Required facts are never appended natively beside the document and never counted generated.
 */
export function validateFrameDocument(
    document: FrameDocument,
    options: { readonly heldCaptureId?: string | null } = {},
): FrameValidation {
    const errors: string[] = []
    if (document.bar.primary.label.trim() === '') errors.push('missing-primary')
    const intents: AppIntent[] = [document.bar.primary.intent]
    if (document.bar.secondary !== null) intents.push(document.bar.secondary.intent)
    if (document.header.trailing !== null) intents.push(document.header.trailing)
    collectIntents(document.body, intents)
    for (const variant of Object.values(document.variants ?? {})) {
        if (variant === undefined) continue
        collectIntents(variant.body, intents)
        if (variant.bar !== undefined) {
            intents.push(variant.bar.primary.intent)
            if (variant.bar.secondary !== null) intents.push(variant.bar.secondary.intent)
        }
    }
    if (intents.some((intent) => !intentKnown(intent))) errors.push('unknown-intent')
    const sourceCount = document.sources?.length ?? 0
    for (const leaf of flattenFrameNodes(document.body)) {
        const cited =
            leaf.type === 'Instruction' ||
            leaf.type === 'Warning' ||
            leaf.type === 'ResultBanner' ||
            leaf.type === 'AnswerCard' ||
            leaf.type === 'FactPrompt' ||
            leaf.type === 'ConfirmFact'
                ? leaf.citations
                : leaf.type === 'SourceDetails'
                  ? leaf.sources
                  : []
        if (cited.some((index) => index < 0 || index >= sourceCount)) errors.push('citation-out-of-range')
    }
    const required = document.requiredFactIds ?? []
    if (required.length > 0) {
        const placed = placedFactIds(document)
        const published = new Set((document.manualFacts ?? []).map((fact) => fact.factId))
        for (const factId of required) {
            if (!published.has(factId)) errors.push(`mandatory-fact-unpublished:${factId}`)
            else if (!placed.has(factId)) errors.push(`mandatory-fact-omitted:${factId}`)
        }
    }
    if (document.kind === 'result') {
        const held = options.heldCaptureId ?? document.bound.captureId
        if (held === null || held === undefined || document.bound.captureId !== held) {
            errors.push('held-photo-required')
        }
        const hasPhoto = flattenFrameNodes(document.body).some(
            (leaf) => leaf.type === 'PhotoWithRegions' && leaf.captureId === held,
        )
        if (!hasPhoto) errors.push('held-photo-node-missing')
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/** True only when the held, reusable capture is the one the result document is bound to and its photo node resolves. */
export function heldPhotoResolves(
    document: FrameDocument,
    held: { readonly captureId: string; readonly reusable: boolean } | null,
): boolean {
    return (
        held !== null &&
        held.reusable &&
        document.bound.captureId === held.captureId &&
        flattenFrameNodes(document.body).some(
            (leaf) => leaf.type === 'PhotoWithRegions' && leaf.captureId === held.captureId,
        )
    )
}
