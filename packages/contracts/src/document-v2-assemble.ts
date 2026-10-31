import {
    SCREEN_CATALOG_V2_VERSION,
    SCREEN_DOCUMENT_V2_VERSION,
    screenStageV2,
    sourceMapV2,
    variantComponentPathsV2,
    variantOriginV2,
    type CarriedStatesV2,
    type DocumentMetadataV2,
    type FallbackReasonV2,
    type ScreenDocumentV2,
    type ScreenProposalV2,
    type VariantState,
} from './document-v2'
import { screenContextJsonV2, screenContextPartsV2 } from './document-v2-context'
import type { DocumentMaterialV2 } from './document-v2-material'
import { canonicalJson } from './screen-context'

// ---------------------------------------------------------------------------------------------------------------------
// Assembly. Shared by every producer of a published document: the model path, the recorded path and the fallback builder.
// ---------------------------------------------------------------------------------------------------------------------

export interface AssembleDeps {
    sha256Hex(text: string): string
    now(): Date
}

export interface DocumentFacts {
    source: 'generated' | 'fallback'
    evidence: DocumentMetadataV2['evidence']
    fallbackReason: FallbackReasonV2 | null
    model?: DocumentMetadataV2['model']
    /** Recordings only: the identity of the recording (see `recordedDocumentFactsV2`). */
    fixtureId?: string | null
    authoring?: DocumentMetadataV2['authoring']
    /**
     * Fallback documents only: state variants authored by generated documents of other contexts, with their original
     * provenance (see `rebindGeneratedStatesV2`). Those variants, and only those, are attributed `generated`.
     */
    carried?: CarriedStatesV2
    /** Generated documents only: state variants the shell filled from its templates (origin `shell`). */
    shellStates?: readonly VariantState[]
    effort?: DocumentMetadataV2['effort']
    repaired?: boolean
    rejectedIssues?: number | null
    cacheHit?: boolean
    promptVersion?: number
    generatedAt?: string
    timing?: DocumentMetadataV2['timing']
    usage?: DocumentMetadataV2['usage']
}

/**
 * Builds the published document from material and a proposal, adding only what the server owns: identity, the fact and
 * source tables, the requirements, origins and the source map. It never edits the proposal. Callers validate the
 * result with `screenDocumentV2Schema`.
 */
export function assembleDocumentV2(
    material: DocumentMaterialV2,
    proposal: ScreenProposalV2,
    about: DocumentFacts,
    deps: AssembleDeps,
): ScreenDocumentV2 {
    const { inputs } = material
    const parts = screenContextPartsV2(inputs)
    const bound = {
        manualId: parts.identity.manualId,
        revision: parts.identity.revision,
        stepId: parts.identity.stepId,
        captureId: parts.identity.captureId,
        contextKey: deps.sha256Hex(screenContextJsonV2(inputs)),
    }
    const tables = { facts: material.facts, sources: material.sources }
    const shell = { ...proposal, ...tables }
    const carried = about.carried !== undefined && Object.keys(about.carried).length > 0 ? about.carried : undefined
    const shellStates =
        about.shellStates !== undefined && about.shellStates.length > 0 ? [...about.shellStates] : undefined
    const origins = Object.fromEntries(
        variantComponentPathsV2(proposal).flatMap(({ name, paths }) =>
            paths.map((path) => [path, variantOriginV2({ source: about.source, carried, shellStates }, name)] as const),
        ),
    )
    const metadata: DocumentMetadataV2 = {
        source: about.source,
        origins,
        sourceMap: sourceMapV2(shell),
        evidence: about.evidence,
        ...(about.fixtureId == null ? {} : { fixtureId: about.fixtureId }),
        ...(about.authoring === undefined ? {} : { authoring: about.authoring }),
        ...(carried === undefined ? {} : { carried }),
        ...(shellStates === undefined ? {} : { shellStates }),
        stage: screenStageV2(inputs.kind),
        model: about.model ?? null,
        effort: about.effort ?? null,
        fallbackReason: about.fallbackReason,
        repaired: about.repaired ?? false,
        rejectedIssues: about.rejectedIssues ?? null,
        cacheHit: about.cacheHit ?? false,
        catalogVersion: SCREEN_CATALOG_V2_VERSION,
        promptVersion: about.promptVersion ?? 0,
        generatedAt: about.generatedAt ?? deps.now().toISOString(),
        timing: about.timing ?? { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
        usage: about.usage ?? { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
    }
    return {
        version: SCREEN_DOCUMENT_V2_VERSION,
        kind: inputs.kind,
        screenId: deps.sha256Hex(
            canonicalJson({
                bound,
                kind: inputs.kind,
                source: about.source,
                proposal,
                ...tables,
                requirements: material.requirements,
                // Present only on a document that carries states, so every other document keeps the identity it always had.
                ...(carried === undefined ? {} : { carried }),
                ...(shellStates === undefined ? {} : { shellStates }),
                ...(about.authoring === undefined ? {} : { authoring: about.authoring }),
            }),
        ),
        bound,
        metadata,
        header: proposal.header,
        body: proposal.body,
        bar: proposal.bar,
        overlays: proposal.overlays,
        states: proposal.states,
        facts: material.facts,
        sources: material.sources,
        requirements: material.requirements,
    }
}
