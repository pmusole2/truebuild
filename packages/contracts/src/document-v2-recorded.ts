import { z } from 'zod'

import { fixtureIdV2Schema, syntheticAuthorV2Schema, type SyntheticAuthorV2 } from './document-v2'
import type { DocumentFacts } from './document-v2-assemble'
import { aiEffortSchema, standardModelSchema } from './telemetry'

/**
 * Provenance of a recorded model response: the run that REALLY authored a proposal, kept so the document built from it
 * can say so truthfully. A closed record (strict, no timing, no usage, no cost): what was not observed is absent, never
 * estimated. `effort` is one of the documented reasoning efforts; nothing here sets or caps a budget.
 *
 * It travels beside the proposal (a sidecar file or a field of the record), never inside it. The proposal itself is
 * the strict `ScreenProposalV2` tree the model returned; identity, tables, requirements, origins and the source map
 * are computed by `assembleDocumentV2`, never taken from a file.
 */
export const recordedProvenanceV2Schema = z.strictObject({
    fixtureId: fixtureIdV2Schema,
    model: standardModelSchema,
    effort: aiEffortSchema,
    /** When the model authored it (UTC). Becomes `metadata.generatedAt`, never the time the record is bound. */
    recordedAt: z.iso.datetime(),
    promptVersion: z.number().int().min(0),
    /** Whether the recorded answer needed the single repair. A one-shot authoring says `false`. */
    repaired: z.boolean(),
})
export type RecordedProvenanceV2 = z.infer<typeof recordedProvenanceV2Schema>

/**
 * What `assembleDocumentV2` is told about a recorded proposal (its `about` argument): a generated document whose
 * evidence is `recorded-generation`, with the model, effort, date and fixture id of the run that authored it and no
 * timing, no usage and no cache hit. Bind it with
 * `assembleDocumentV2(documentMaterialV2(inputs), validatedProposal, recordedDocumentFactsV2(provenance), deps)`, then
 * check the result with `screenDocumentV2Schema` and `verifyDocumentAgainstInputsV2` for the same inputs.
 */
export function recordedDocumentFactsV2(provenance: RecordedProvenanceV2): DocumentFacts {
    return {
        source: 'generated',
        evidence: 'recorded-generation',
        fallbackReason: null,
        fixtureId: provenance.fixtureId,
        model: provenance.model,
        effort: provenance.effort,
        repaired: provenance.repaired,
        rejectedIssues: null,
        cacheHit: false,
        promptVersion: provenance.promptVersion,
        generatedAt: provenance.recordedAt,
        timing: { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
        usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
    }
}

/** Offline AI-authored synthetic composition, with no Meta model call or invented inference observations. */
export function syntheticDocumentFactsV2(author: SyntheticAuthorV2): DocumentFacts {
    const authoring = syntheticAuthorV2Schema.parse(author)
    return {
        source: 'generated',
        evidence: 'synthetic-fixture',
        fallbackReason: null,
        model: null,
        effort: null,
        authoring,
        generatedAt: authoring.recordedAt,
        repaired: false,
        cacheHit: false,
        promptVersion: 0,
    }
}
