import {
    COACH_COPY_V2,
    assembleDocumentV2,
    bindingIssuesV2,
    cameraIssuesV2,
    componentPathsV2,
    earnedStateIssuesV2,
    coachIssuesV2,
    intentAllowedV2,
    literalIssuesV2,
    nodeIntentsV2,
    nodeTextRefsV2,
    resultOfKindV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    variantsOfV2,
    visitVariantNodesV2,
    type AppIntent,
    type HeaderV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type TextRefV2,
} from '@truebuild/contracts'

import { decodeWireProposal, wireIssueCodes } from '../../providers/document-wire'
import { normalize } from '../screens/text'
import {
    CAMERA_CUES_V2,
    CAMERA_PILLS_V2,
    GENERIC_LABELS,
    availableBoundKeys,
    confirmLabelsFor,
    labelsFor,
    sha256,
    type DocumentContext,
} from './context'

/**
 * The gate every model document passes. It only ever REJECTS: it returns machine issue codes (a component path and a
 * static rule, never the rejected text) and the caller repairs once or replaces the whole document with the complete
 * deterministic one. Nothing the model wrote is edited, dropped, appended to or merged.
 */
export type Evaluation = { ok: true; proposal: ScreenProposalV2 } | { ok: false; issues: string[] }

const HAS_DIGIT = /\d/u
const same = (a: string, b: string): boolean => normalize(a) === normalize(b)

/** Titles of screens that make a claim about the person's work: the only wording the server allows is the listed one. */
function claimTitles(context: DocumentContext): readonly string[] | null {
    const { material } = context
    if (context.inputs.kind === 'result') {
        return material.decision === 'pass'
            ? ['Looks right']
            : material.decision === 'refuse'
              ? ['Not quite right']
              : ['Cannot tell yet']
    }
    if (context.inputs.kind === 'completion') {
        return material.completion === 'witnessed' ? ['All steps done'] : ['Your build']
    }
    return null
}

function labelAllowed(label: string, intent: AppIntent, extra: readonly string[]): boolean {
    return [...labelsFor(intent), ...extra].some((candidate) => same(candidate, label))
}

/** Wording a control may use besides the per-intent registry, by variant (the confirmation labels only in `confirming`). */
function extraLabels(name: 'ready' | string, intent: AppIntent, fallback: readonly string[]): readonly string[] {
    if (name === 'confirming') return [...GENERIC_LABELS, ...confirmLabelsFor(intent)]
    return name === 'ready' ? fallback : GENERIC_LABELS
}

/** Semantic rules beyond the structural contract. Each issue is `<component path>:<rule>`. */
export function semanticIssues(proposal: ScreenProposalV2, context: DocumentContext): string[] {
    const { material } = context
    const { inputs } = material
    const ui = inputs.uiState
    const issues: string[] = []
    const add = (path: string, rule: string): void => {
        issues.push(`${path}:${rule}`)
    }
    const bound = new Set<string>(availableBoundKeys(material))
    const pageIds = new Set(inputs.session?.pages.map((page) => page.pageId) ?? [])
    const libraryIds = new Set(ui?.library?.entries.map((entry) => entry.manualId) ?? [])
    const question = ui?.review?.currentQuestion ?? null
    const titles = claimTitles(context)
    const factIds = new Set(material.facts.map((fact) => fact.factId))

    const checkRef = (ref: TextRefV2, path: string): void => {
        if (ref.kind === 'literal' && HAS_DIGIT.test(ref.text)) add(path, 'literal_digits')
        if (ref.kind === 'bound' && !bound.has(ref.key)) add(path, 'bound_unavailable')
        if (ref.kind === 'fact' && !factIds.has(ref.factId)) add(path, 'fact_unknown')
    }
    const checkIntent = (intent: AppIntent, path: string): void => {
        if (!intentAllowedV2(intent, material)) add(path, 'intent_not_allowed')
    }
    const checkHeader = (header: HeaderV2, prefix: string, name: string): void => {
        const state = name !== 'ready'
        checkRef(header.title, `${prefix}header`)
        if (header.subtitle) checkRef(header.subtitle, `${prefix}header`)
        const written = header.title.kind === 'literal' ? header.title.text : null
        if (!state && titles !== null && written !== null && !titles.some((listed) => same(listed, written))) {
            add(`${prefix}header`, 'title_not_listed')
        }
        if (header.back) {
            const extra = extraLabels(name, header.back.intent, ['Back', 'More'])
            checkIntent(header.back.intent, `${prefix}header.back`)
            if (!labelAllowed(header.back.label, header.back.intent, extra))
                add(`${prefix}header.back`, 'label_not_listed')
        }
        header.actions.forEach((action, index) => {
            const extra = extraLabels(name, action.intent, ['Back', 'More'])
            checkIntent(action.intent, `${prefix}header.actions.${index}`)
            if (!labelAllowed(action.label, action.intent, extra))
                add(`${prefix}header.actions.${index}`, 'label_not_listed')
        })
    }
    const checkNode = (node: ScreenNodeV2, path: string, name: string): void => {
        for (const ref of nodeTextRefsV2(node)) checkRef(ref, path)
        for (const intent of nodeIntentsV2(node)) checkIntent(intent, path)
        switch (node.type) {
            case 'PrimaryAction':
            case 'SecondaryAction':
                if (!labelAllowed(node.label, node.intent, extraLabels(name, node.intent, ['Back'])))
                    add(path, 'label_not_listed')
                break
            case 'Choice':
                if (node.options.mode === 'intents') {
                    if (node.options.items.some((item) => !labelAllowed(item.label, item.intent, [])))
                        add(path, 'label_not_listed')
                } else if (
                    node.options.binding === 'language' &&
                    (ui?.pages?.languageOptions.length ?? 0) === 0 &&
                    (ui?.language?.options.length ?? 0) === 0
                ) {
                    add(path, 'binding_unavailable')
                } else if (
                    node.options.binding === 'part-target' &&
                    (!ui?.capture || inputs.captureId === null || material.partIds.length === 0)
                ) {
                    add(path, 'binding_unavailable')
                }
                break
            case 'CoachMark': {
                const copy = COACH_COPY_V2[node.targetId]
                if (!copy || !same(copy.heading, node.heading) || !same(copy.body, node.body))
                    add(path, 'coach_copy_not_listed')
                break
            }
            case 'CameraView':
                if (inputs.kind !== 'camera' || ui?.camera?.mode !== node.mode) add(path, 'camera_mismatch')
                if (!CAMERA_CUES_V2.some((cue) => same(cue, node.cue))) add(path, 'cue_not_listed')
                if (node.pill !== null && !CAMERA_PILLS_V2.some((pill) => same(pill, node.pill ?? '')))
                    add(path, 'pill_not_listed')
                break
            case 'PieceTile':
                if (!material.partIds.includes(node.partId)) add(path, 'unknown_part')
                break
            case 'Image':
                if (node.source.kind === 'page' && !pageIds.has(node.source.pageId)) add(path, 'unknown_page')
                if (node.source.kind === 'part' && !material.partIds.includes(node.source.partId))
                    add(path, 'unknown_part')
                if (node.source.kind === 'capture' && inputs.captureId === null) add(path, 'no_capture')
                break
            case 'VerdictCard':
                if (resultOfKindV2(inputs, node.result) === null) add(path, 'no_such_result')
                break
            case 'JudgePanel':
                if (inputs.kind !== 'judge') add(path, 'judge_only')
                break
            case 'CompareColumns':
                if (inputs.kind !== 'compare') add(path, 'compare_only')
                break
            case 'ManualList':
                if (!ui?.library) add(path, 'binding_unavailable')
                else if (node.entries !== 'recent' && node.entries.manualIds.some((id) => !libraryIds.has(id)))
                    add(path, 'unknown_manual')
                break
            case 'PageList':
                if (!ui?.pages) add(path, 'binding_unavailable')
                break
            case 'TextField':
                // The question is the only bare text field; the quick check's drafts belong to the FactEditor.
                if (!ui?.capture) add(path, 'binding_unavailable')
                break
            case 'FactEditor':
                if (question === null || question.kind !== node.kind) add(path, 'binding_unavailable')
                break
            default:
                break
        }
    }
    for (const { name, prefix, variant } of variantsOfV2(proposal)) {
        checkHeader(variant.header, prefix, name)
        visitVariantNodesV2(variant, prefix, (entry) => checkNode(entry.node, entry.path, name))
        // Overlays are tooltip coach marks only (the schema guarantees it); each is anchored to its own target.
        variant.overlays.forEach((overlay, index) => {
            if (overlay.anchor !== overlay.content.targetId) add(`${prefix}overlays.${index}`, 'tooltip_anchor')
        })
    }
    // Every literal is closed interface copy of this screen (no unlisted prose, whatever its length or digits), and
    // progress or success is only shown where something earned it: the registry and the witnesses are shared contracts.
    issues.push(
        ...literalIssuesV2(proposal, material),
        ...earnedStateIssuesV2(proposal, material),
        ...coachIssuesV2(proposal, material),
        ...cameraIssuesV2(proposal, material),
        ...bindingIssuesV2(proposal, material),
    )
    return [...new Set(issues)]
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
