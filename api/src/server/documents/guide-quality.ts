import {
    isManualCheckFact,
    canonicalJson,
    guideHeaderTextV2,
    isManualDirectionFact,
    visitVariantNodesV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
} from '@truebuild/contracts'

import type { DocumentContext } from './context'

/** A usability floor after strict validation; it never edits model content or relaxes the validator. */
export function guideQualityIssues(proposal: ScreenProposalV2, context: DocumentContext): string[] {
    if (context.inputs.kind !== 'guide') return []
    const issues: string[] = []
    const legacy = context.material.legacyDirections === true
    const boundHeader = legacy
        ? [proposal.header.title, proposal.header.subtitle].some(
              (ref) => ref?.kind === 'bound' && ref.key === 'step-title',
          )
        : canonicalJson({ title: proposal.header.title, subtitle: proposal.header.subtitle }) ===
          canonicalJson(guideHeaderTextV2(context.material))
    if (!boundHeader) issues.push('guide_quality:title_not_bound')
    const directions = context.material.facts
        .filter((fact) =>
            legacy
                ? fact.kind !== 'safety' &&
                  fact.kind !== 'title' &&
                  (fact.basis === 'direction' || fact.basis === 'unclassified-step')
                : isManualDirectionFact(fact),
        )
        .map((fact) => fact.factId)
    const seen: string[] = []
    let occurrences = 0
    visitVariantNodesV2(proposal, '', ({ node, hidden, path }) => {
        if (
            path.startsWith('body') &&
            node.type === 'Text' &&
            node.content.kind === 'fact' &&
            directions.includes(node.content.factId)
        )
            occurrences++
        if (
            !hidden &&
            path.startsWith('body') &&
            node.type === 'Text' &&
            node.content.kind === 'fact' &&
            directions.includes(node.content.factId)
        )
            seen.push(node.content.factId)
    })
    if (
        legacy
            ? seen.length === 0
            : directions.length === 0 ||
              occurrences !== directions.length ||
              seen.length !== directions.length ||
              directions.some((id, index) => id !== seen[index])
    ) {
        issues.push('guide_quality:instruction_text_missing')
        return issues
    }
    if (legacy) return issues
    const checks = new Set(context.material.facts.filter(isManualCheckFact).map((fact) => fact.factId))
    const checked = new Set<string>()
    let misplaced = false
    let repeatedTitle = false
    const inspect = (node: ScreenNodeV2, inChecks = false, inDirections = false): void => {
        if (node.type === 'Section') {
            const title = node.title?.kind === 'literal' ? node.title.text : null
            inChecks ||= title === 'Check your work' && node.collapsible && !node.initiallyOpen
            inDirections ||= title === 'Directions'
        }
        if (node.type === 'Text') {
            if (node.content.kind === 'bound' && node.content.key === 'step-title') repeatedTitle = true
            if (node.content.kind === 'fact' && checks.has(node.content.factId)) {
                if (!inChecks || inDirections) misplaced = true
                checked.add(node.content.factId)
            }
        }
        if ('children' in node) node.children.forEach((child) => inspect(child, inChecks, inDirections))
    }
    inspect(proposal.body)
    if (repeatedTitle) issues.push('guide_quality:title_repeated')
    if (misplaced || checked.size !== checks.size) issues.push('guide_quality:checks_not_separate')
    return issues
}
