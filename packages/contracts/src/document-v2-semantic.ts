import {
    nodeIntentsV2,
    nodeTextRefsV2,
    variantsOfV2,
    visitVariantNodesV2,
    type HeaderV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type TextRefV2,
} from './document-v2'
import {
    bindingIssuesV2,
    cameraIssuesV2,
    coachIssuesV2,
    earnedStateIssuesV2,
    literalIssuesV2,
    BUSY_COPY_V2,
    CONFIRM_LABELS_V2,
    COACH_COPY_V2,
} from './document-v2-copy'
import { availableBoundKeysV2, intentAllowedV2, type DocumentMaterialV2 } from './document-v2-material'
import { resultOfKindV2 } from './document-v2-context'
import { ACTION_LABELS_V2 } from './document-v2-action-copy'
import type { AppIntent } from './screen'
const normalize = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ').trim().replace(/\.$/u, '')

/** Interface wording a state variant or a header control may use besides the per-intent labels. */
export const GENERIC_ACTION_LABELS_V2 = [
    'Working…',
    'Saving…',
    'Please wait',
    'Try again',
    'Home',
    'Back',
    'More',
] as const
export const CAMERA_CUES_V2 = [
    'Keep the whole step in view',
    'Hold steady',
    'Fill the frame with your work',
    'Fill the frame with the page',
] as const
export const CAMERA_PILLS_V2 = ['Step in view', 'Ready'] as const

/** The two confirmation labels of the reading cancellation: each belongs to one intent, in the `confirming` variant only. */
export function confirmLabelsForV2(intent: AppIntent): readonly string[] {
    if (intent.intent !== 'navigate') return []
    return intent.target === 'pages'
        ? [CONFIRM_LABELS_V2.stop]
        : intent.target === 'reading'
          ? [CONFIRM_LABELS_V2.keep]
          : []
}

/** The wording the server accepts for an action with this intent. */
export function labelsForV2(intent: AppIntent): readonly string[] {
    const table = ACTION_LABELS_V2[intent.intent] as Readonly<Record<string, readonly string[]>>
    return table[intent.target] ?? []
}

const HAS_DIGIT = /\d/u
const same = (a: string, b: string): boolean => normalize(a) === normalize(b)

/** Titles of screens that make a claim about the person's work: the only wording the server allows is the listed one. */
function claimTitles(material: DocumentMaterialV2): readonly string[] | null {
    if (material.inputs.kind === 'result') {
        // A check that has not returned names only what the app is doing.
        if (material.pendingCheck) return [BUSY_COPY_V2.checking.heading]
        return material.decision === 'pass'
            ? ['Looks right']
            : material.decision === 'refuse'
              ? ['Not quite right']
              : ['Cannot tell yet']
    }
    if (material.inputs.kind === 'completion') {
        return material.completion === 'witnessed' ? ['All steps done'] : ['Your build']
    }
    return null
}

function labelAllowed(label: string, intent: AppIntent, extra: readonly string[]): boolean {
    return [...labelsForV2(intent), ...extra].some((candidate) => same(candidate, label))
}

/** Wording a control may use besides the per-intent registry, by variant (the confirmation labels only in `confirming`). */
function extraLabels(name: 'ready' | string, intent: AppIntent, fallback: readonly string[]): readonly string[] {
    if (name === 'confirming') return [...GENERIC_ACTION_LABELS_V2, ...confirmLabelsForV2(intent)]
    return name === 'ready' ? fallback : GENERIC_ACTION_LABELS_V2
}

/** Semantic rules beyond the structural contract. Each issue is `<component path>:<rule>`. */
export function semanticIssuesV2(proposal: ScreenProposalV2, material: DocumentMaterialV2): string[] {
    const { inputs } = material
    const ui = inputs.uiState
    const issues: string[] = []
    const add = (path: string, rule: string): void => {
        issues.push(`${path}:${rule}`)
    }
    const bound = new Set<string>(availableBoundKeysV2(material))
    const pageIds = new Set(inputs.session?.pages.map((page) => page.pageId) ?? [])
    const libraryIds = new Set(ui?.library?.entries.map((entry) => entry.manualId) ?? [])
    const question = ui?.review?.currentQuestion ?? null
    const titles = claimTitles(material)
    const factIds = new Set(material.facts.map((fact) => fact.factId))

    const checkRef = (ref: TextRefV2, path: string): void => {
        if (ref.kind === 'literal' && HAS_DIGIT.test(ref.text)) add(path, 'literal_digits')
        if (ref.kind === 'bound' && !bound.has(ref.key)) add(path, 'bound_unavailable')
        if (ref.kind === 'fact' && !factIds.has(ref.factId)) add(path, 'fact_unknown')
    }
    const checkIntent = (intent: AppIntent, path: string): void => {
        // The shell may retry screen composition from its error state; READY keeps its original intent policy.
        if (path.startsWith('states.error.') && intent.intent === 'retry' && intent.target === 'screen') return
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
