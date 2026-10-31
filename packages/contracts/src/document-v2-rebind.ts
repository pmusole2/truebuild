import {
    VARIANT_STATES,
    nodeFactIdsV2,
    nodeIntentsV2,
    screenDocumentV2Schema,
    visitVariantNodesV2,
    type CarriedStateV2,
    type CarriedStatesV2,
    type ScreenDocumentV2,
    type ScreenNodeTypeV2,
    type ScreenProposalV2,
    type ScreenVariantV2,
    type VariantState,
} from './document-v2'
import { assembleDocumentV2, type AssembleDeps, type DocumentFacts } from './document-v2-assemble'
import type { ScreenContextInputsV2 } from './document-v2-context'
import { documentMaterialV2, intentAllowedV2, type DocumentMaterialV2 } from './document-v2-material'
import { verifyDocumentAgainstInputsV2 } from './document-v2-verify'
import type { AppIntent } from './screen'
import { canonicalJson } from './screen-context'

/**
 * Generated state variants on a deterministic document.
 *
 * While the document for a context is still being authored, the app shows the deterministic document it can build
 * locally. Its waiting and failure screens (busy, pending, empty, error, recovery) are plain templates. When the app
 * already holds a GENERATED document (a model response, or a recorded one) whose variant of the same state is valid for
 * this context too, that authored variant is shown instead, and it keeps exactly the provenance of the document that
 * authored it. Nothing is relabelled: a deterministic template is never marked generated, a variant is never edited, and
 * a variant that states anything about a manual is never carried (it belongs to the context that authored it).
 */

/** Node types that name, cite or resolve something specific to the context that authored them. */
const CONTEXT_BOUND_NODES: ReadonlySet<ScreenNodeTypeV2> = new Set<ScreenNodeTypeV2>([
    'Citation',
    'ManualPage',
    'PieceTile',
    'VerdictCard',
    'FactEditor',
    'CameraView',
    'JudgePanel',
    'CompareColumns',
])

/**
 * Whether a variant says nothing about any manual, step, result or source: no fact reference anywhere (header, text,
 * caption, label, title), no citation or manual page, no part tile, no figure of a source, page or part, no verdict, no
 * native view tied to a step, a camera or a result, no named manual. Only closed interface copy, bound live text, the
 * held photo of the context it is shown in, bindings the app resolves itself, and actions.
 */
export function isNonfactualVariantV2(variant: ScreenVariantV2): boolean {
    if ([variant.header.title, variant.header.subtitle].some((ref) => ref?.kind === 'fact')) return false
    let clean = true
    visitVariantNodesV2(variant, '', ({ node }) => {
        if (
            CONTEXT_BOUND_NODES.has(node.type) ||
            (node.type === 'Image' && node.source.kind !== 'capture') ||
            (node.type === 'ManualList' && node.entries !== 'recent') ||
            nodeFactIdsV2(node).length > 0
        ) {
            clean = false
        }
    })
    return clean
}

function variantIntents(variant: ScreenVariantV2): AppIntent[] {
    const intents: AppIntent[] = [variant.header.back, ...variant.header.actions].flatMap((action) =>
        action === null ? [] : [action.intent],
    )
    visitVariantNodesV2(variant, '', ({ node }) => intents.push(...nodeIntentsV2(node)))
    return intents
}
const intentsAllowed = (variant: ScreenVariantV2, material: DocumentMaterialV2): boolean =>
    variantIntents(variant).every((intent) => intentAllowedV2(intent, material))

const proposalOf = (document: ScreenDocumentV2): ScreenProposalV2 => ({
    header: document.header,
    body: document.body,
    bar: document.bar,
    overlays: document.overlays,
    states: document.states,
})

/**
 * A document is a usable donor only if it is a generated document that passes the published schema. Judged on what it is
 * now, every time it is used and never remembered between calls: a document is a plain mutable object, so what it was
 * when it was last checked says nothing about it (and `carriedStateIssuesV2` would then disagree with the rebind).
 */
function usableDonor(donor: ScreenDocumentV2): boolean {
    return donor.metadata.source === 'generated' && screenDocumentV2Schema.safeParse(donor).success
}

function provenanceOf(donor: ScreenDocumentV2): CarriedStateV2 | null {
    const { metadata } = donor
    if (metadata.evidence === 'local-deterministic') return null
    return {
        fromScreenId: donor.screenId,
        evidence: metadata.evidence,
        model: metadata.model,
        effort: metadata.effort,
        generatedAt: metadata.generatedAt,
        promptVersion: metadata.promptVersion,
        fixtureId: metadata.fixtureId ?? null,
        ...(metadata.authoring === undefined ? {} : { authoring: metadata.authoring }),
    }
}

/** The target's own observations, unchanged, plus the states it now carries. */
function aboutOf(target: ScreenDocumentV2, carried: CarriedStatesV2): DocumentFacts {
    const { metadata } = target
    return {
        source: 'fallback',
        evidence: metadata.evidence,
        fallbackReason: metadata.fallbackReason,
        model: metadata.model,
        effort: metadata.effort,
        repaired: metadata.repaired,
        rejectedIssues: metadata.rejectedIssues,
        cacheHit: metadata.cacheHit,
        promptVersion: metadata.promptVersion,
        generatedAt: metadata.generatedAt,
        timing: metadata.timing,
        usage: metadata.usage,
        carried,
    }
}

export interface RebindResult {
    /** `target` itself (the same reference) when nothing was carried. */
    document: ScreenDocumentV2
    /** The states that now come from a generated document. */
    carried: VariantState[]
}

/**
 * Carries authored state variants of already-generated documents onto the deterministic document built for `inputs`.
 *
 * For each requested state (default: every state), the first donor, in the order given, whose variant is nonfactual,
 * offers only actions this context allows, and is valid for this exact context is carried. "Valid" is not a similarity
 * guess: the rebound document must pass `screenDocumentV2Schema` (the target's own variant policy, mandatory witnesses,
 * spines) and `verifyDocumentAgainstInputsV2` for `inputs` (interface copy, bound keys, the busy activity heading,
 * bindings, camera and coach rules). Anything that does not fit keeps the deterministic variant of that state. The
 * donor needs no relation to the target beyond that: a generic authored template can serve any kind, a kind-specific
 * one fails closed.
 *
 * `target` must be a `fallback` document built for `inputs` (a generated document is never partly replaced). The result
 * keeps its identity (`bound`, facts, sources, requirements), its ready screen and its metadata, and adds the
 * provenance of each carried variant to `metadata.carried`; only those variants are attributed `generated`.
 */
export function rebindGeneratedStatesV2(
    inputs: ScreenContextInputsV2,
    target: ScreenDocumentV2,
    donors: readonly ScreenDocumentV2[],
    deps: AssembleDeps,
    options: { states?: readonly VariantState[] } = {},
): RebindResult {
    const unchanged: RebindResult = { document: target, carried: [] }
    if (target.metadata.source !== 'fallback' || target.kind !== inputs.kind) return unchanged
    const usable = donors.filter(usableDonor)
    if (usable.length === 0) return unchanged
    // The target must be exactly the deterministic document of these inputs; otherwise there is nothing to rebind to.
    if (verifyDocumentAgainstInputsV2(target, inputs, deps.sha256Hex).length > 0) return unchanged

    const material = documentMaterialV2(inputs)
    const wanted = new Set(options.states ?? VARIANT_STATES)
    let current = target
    let carriedStates: CarriedStatesV2 = { ...target.metadata.carried }
    const carried: VariantState[] = []
    for (const state of VARIANT_STATES) {
        // A state the document does not carry has nothing to replace, and a variant already authored stays as it is.
        if (!wanted.has(state) || current.states[state] === null || carriedStates[state] !== undefined) continue
        for (const donor of usable) {
            const variant = donor.states[state]
            const provenance = provenanceOf(donor)
            // A shell-filled state of a generated document is a template, never the model's authorship.
            if (!variant || provenance === null || donor.metadata.shellStates?.includes(state)) continue
            if (!isNonfactualVariantV2(variant) || !intentsAllowed(variant, material)) continue
            const nextCarried: CarriedStatesV2 = { ...carriedStates, [state]: provenance }
            const proposal = proposalOf(current)
            const candidate = assembleDocumentV2(
                material,
                { ...proposal, states: { ...proposal.states, [state]: variant } },
                aboutOf(target, nextCarried),
                deps,
            )
            const parsed = screenDocumentV2Schema.safeParse(candidate)
            if (!parsed.success || verifyDocumentAgainstInputsV2(parsed.data, inputs, deps.sha256Hex).length > 0)
                continue
            current = parsed.data
            carriedStates = nextCarried
            carried.push(state)
            break
        }
    }
    return carried.length === 0 ? unchanged : { document: current, carried }
}

/**
 * For audits and proof: every state a document carries equals, byte for byte, the variant of a GENERATED document in
 * `donors` with that `screenId`, and the recorded provenance equals that document's own. Machine codes
 * `carried:<state>:donor_missing | variant_differs | provenance_differs`; empty means the attribution is honest.
 */
export function carriedStateIssuesV2(document: ScreenDocumentV2, donors: readonly ScreenDocumentV2[]): string[] {
    const issues: string[] = []
    for (const state of VARIANT_STATES) {
        const claim = document.metadata.carried?.[state]
        if (claim === undefined) continue
        const donor = donors.find(
            (candidate) =>
                candidate.screenId === claim.fromScreenId &&
                candidate.metadata.source === 'generated' &&
                !candidate.metadata.shellStates?.includes(state),
        )
        if (donor === undefined) {
            issues.push(`carried:${state}:donor_missing`)
            continue
        }
        const authored = donor.states[state]
        if (!authored || canonicalJson(authored) !== canonicalJson(document.states[state])) {
            issues.push(`carried:${state}:variant_differs`)
        }
        const { metadata } = donor
        if (
            claim.evidence !== metadata.evidence ||
            claim.model !== metadata.model ||
            claim.effort !== metadata.effort ||
            claim.generatedAt !== metadata.generatedAt ||
            claim.promptVersion !== metadata.promptVersion ||
            claim.fixtureId !== (metadata.fixtureId ?? null) ||
            canonicalJson(claim.authoring ?? null) !== canonicalJson(metadata.authoring ?? null)
        ) {
            issues.push(`carried:${state}:provenance_differs`)
        }
    }
    return issues
}
