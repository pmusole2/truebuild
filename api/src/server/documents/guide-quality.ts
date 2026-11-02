import { visitVariantNodesV2, type ScreenProposalV2 } from '@truebuild/contracts'

import type { DocumentContext } from './context'

/** A usability floor after strict validation; it never edits model content or relaxes the validator. */
export function guideQualityIssues(proposal: ScreenProposalV2, context: DocumentContext): string[] {
    if (context.inputs.kind !== 'guide') return []
    const issues: string[] = []
    if (
        ![proposal.header.title, proposal.header.subtitle].some(
            (ref) => ref?.kind === 'bound' && ref.key === 'step-title',
        )
    )
        issues.push('guide_quality:title_not_bound')
    const directions = new Set(
        context.material.facts
            .filter(
                (fact) => fact.kind !== 'safety' && (fact.basis === 'direction' || fact.basis === 'unclassified-step'),
            )
            .map((fact) => fact.factId),
    )
    let instruction = false
    visitVariantNodesV2(proposal, '', ({ node, hidden, path }) => {
        if (hidden || !path.startsWith('body') || node.type !== 'Text') return
        // ManualStep.title is the manual's full primary instruction sentence, not a model-written label.
        const ref = node.content
        if ((ref.kind === 'bound' && ref.key === 'step-title') || (ref.kind === 'fact' && directions.has(ref.factId)))
            instruction = true
    })
    if (!instruction) issues.push('guide_quality:instruction_text_missing')
    // GuidePieces is app-owned trailing chrome for EVERY Guide origin. It takes the same stepPieces catalog and
    // quantities as this context, so model node omission cannot remove those viewers or their app-rendered counts.
    return issues
}
