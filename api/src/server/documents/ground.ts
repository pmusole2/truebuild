import {
    assembleDocumentV2,
    componentPathsV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    semanticIssuesV2,
    type ScreenProposalV2,
} from '@truebuild/contracts'

import { decodeWireProposal, wireIssueCodes } from '../../providers/document-wire'
import { sha256, type DocumentContext } from './context'

/**
 * The gate every model document passes. It only ever REJECTS: it returns machine issue codes (a component path and a
 * static rule, never the rejected text) and the caller repairs once or replaces the whole document with the complete
 * deterministic one. Nothing the model wrote is edited, dropped, appended to or merged.
 */
export type Evaluation = { ok: true; proposal: ScreenProposalV2 } | { ok: false; issues: string[] }

export function semanticIssues(proposal: ScreenProposalV2, context: DocumentContext): string[] {
    return semanticIssuesV2(proposal, context.material)
}

/**
 * The contract itself is the rest of the gate: assembled with neutral synthetic metadata it checks structure, refs,
 * allowed intents per kind, the state variants and every mandatory witness. Only static rule names are reported.
 */
export function contractIssues(proposal: ScreenProposalV2, context: DocumentContext): string[] {
    const candidate = assembleDocumentV2(
        context.material,
        proposal,
        { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
        { sha256Hex: sha256, now: () => new Date(0) },
    )
    const parsed = screenDocumentV2Schema.safeParse(candidate)
    if (parsed.success) return []
    const rule = (message: string): string =>
        message
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, '_')
            .replace(/^_|_$/gu, '')
            .slice(0, 64)
    return [
        ...new Set(
            parsed.error.issues.map((issue) =>
                issue.code === 'custom'
                    ? `contract:${rule(issue.message)}`
                    : `${issue.path.slice(0, 3).map(String).join('.')}:${issue.code}`,
            ),
        ),
    ].slice(0, 12)
}

/** Everything a validated proposal must satisfy, in the order the cheapest and most informative rules report first. */
export function checkProposal(proposal: ScreenProposalV2, context: DocumentContext): string[] {
    const structural = contractIssues(proposal, context)
    const semantic = semanticIssues(proposal, context)
    return [...structural, ...semantic].slice(0, 16)
}

/** A raw provider value (the flat wire table): decode, then the full gate. */
export function evaluateWire(value: unknown, context: DocumentContext): Evaluation {
    const decoded = decodeWireProposal(value)
    if (!decoded.ok) return decoded
    const issues = checkProposal(decoded.proposal, context)
    return issues.length === 0 ? { ok: true, proposal: decoded.proposal } : { ok: false, issues }
}

/** A cached, previously accepted proposal re-checked against the requesting context. */
export function evaluateProposal(proposal: unknown, context: DocumentContext): Evaluation {
    const parsed = screenProposalV2Schema.safeParse(proposal)
    if (!parsed.success) return { ok: false, issues: wireIssueCodes(parsed.error) }
    const issues = checkProposal(parsed.data, context)
    return issues.length === 0 ? { ok: true, proposal: parsed.data } : { ok: false, issues }
}

/** Paths of the documents' components, exposed for tests that assert the origin map. */
export const pathsOf = componentPathsV2
