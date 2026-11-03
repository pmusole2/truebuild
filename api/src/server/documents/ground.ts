import {
    assembleDocumentV2,
    allowedLiteralsV2,
    groundedFactV2,
    nodeTextRefsV2,
    visitVariantNodesV2,
    componentPathsV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    semanticIssuesV2,
    withShellStatesV2,
    type ScreenProposalV2,
    type ScreenVariantV2,
    type TextRefV2,
} from '@truebuild/contracts'

import { decodeWireProposal, wireIssueCodes } from '../../providers/document-wire'
import { sha256, type DocumentContext } from './context'

/**
 * The strict gate every model document passes, after any separately enabled structural normalization. This gate only
 * REJECTS: it returns machine issue codes (a component path and a static rule, never rejected text), and the caller
 * repairs once or replaces the whole document with the complete deterministic one. Grounded authored text is bound to
 * its complete witnessed fact before publication, preserving the installed app's strict literal contract.
 */
export type Evaluation = { ok: true; proposal: ScreenProposalV2 } | { ok: false; issues: string[] }

export function semanticIssues(proposal: ScreenProposalV2, context: DocumentContext): string[] {
    return semanticIssuesV2(proposal, context.material, { groundedTokens: true })
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

/**
 * The model's ready screen with the shell's deterministic state variants, through the full gate. The model never
 * authors a state, so every accepted proposal carries exactly the shell's states for this context.
 */
function evaluateReady(ready: ScreenVariantV2, context: DocumentContext): Evaluation {
    const proposal = withShellStatesV2(context.material, ready)
    const issues = semanticIssues(proposal, context)
    if (issues.length > 0) return { ok: false, issues }
    const canonical = structuredClone(proposal)
    const copy = (text: string): string =>
        text
            .normalize('NFC')
            .toLowerCase()
            .replace(/\s+/gu, ' ')
            .trim()
            .replace(/[.!…]+$/u, '')
    const allowed = new Set(allowedLiteralsV2(context.material, 'ready').map(copy))
    const bind = (ref: TextRefV2 | null): void => {
        if (ref?.kind !== 'literal' || allowed.has(copy(ref.text))) return
        const fact = groundedFactV2(context.material, ref.text, { groundedTokens: true })
        if (fact === undefined) return
        Reflect.deleteProperty(ref, 'text')
        Object.assign(ref, { kind: 'fact', factId: fact.factId })
    }
    bind(canonical.header.title)
    bind(canonical.header.subtitle)
    visitVariantNodesV2(canonical, '', ({ node }) => nodeTextRefsV2(node).forEach(bind))
    const strict = [...contractIssues(canonical, context), ...semanticIssuesV2(canonical, context.material)]
    return strict.length === 0 ? { ok: true, proposal: canonical } : { ok: false, issues: strict }
}

/** A raw provider value (the flat wire table of a ready screen): decode, then the full gate. */
export function evaluateWire(value: unknown, context: DocumentContext): Evaluation {
    const decoded = decodeWireProposal(value)
    return decoded.ok ? evaluateReady(decoded.ready, context) : decoded
}

/** A cached, previously accepted proposal: its ready screen re-checked against the requesting context. */
export function evaluateProposal(proposal: unknown, context: DocumentContext): Evaluation {
    const parsed = screenProposalV2Schema.safeParse(proposal)
    if (!parsed.success) return { ok: false, issues: wireIssueCodes(parsed.error) }
    const { states: _states, ...ready } = parsed.data
    return evaluateReady(ready, context)
}

/** Paths of the documents' components, exposed for tests that assert the origin map. */
export const pathsOf = componentPathsV2
