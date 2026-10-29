import { composeProposalV2, type ScreenKindV2, type ScreenNodeV2, type ScreenProposalV2 } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { demoSession, documentInputs, fullUi } from '../../test-support/document-inputs'
import { buildDocumentContext } from './context'
import { checkProposal } from './ground'

// The gate every model document passes refuses a live binding the screen has no state for.

const contextOf = (kind: ScreenKindV2): ReturnType<typeof buildDocumentContext> =>
    buildDocumentContext(documentInputs(kind, demoSession(), fullUi))
const withNode = (proposal: ScreenProposalV2, node: ScreenNodeV2): ScreenProposalV2 => ({
    ...proposal,
    body: { type: 'Stack', gap: 'md', align: 'stretch', children: [proposal.body, node] },
})
const issuesWith = (kind: ScreenKindV2, node: ScreenNodeV2): string[] => {
    const context = contextOf(kind)
    return checkProposal(withNode(composeProposalV2(context.material), node), context)
}

describe('unsupported live bindings are rejected by the server gate', () => {
    it('refuses review progress outside the quick check and accepts it there', () => {
        const review: ScreenNodeV2 = { type: 'Progress', binding: 'review', label: null }
        expect(issuesWith('guide', review).join()).toContain('binding_unavailable')
        expect(issuesWith('home', review).join()).toContain('binding_unavailable')
        expect(issuesWith('quick-check', review)).toEqual([])
    })

    it('refuses step progress without a step, reading progress outside a reading, and a built-view toggle off the judge screen', () => {
        expect(issuesWith('home', { type: 'Progress', binding: 'step', label: null }).join()).toContain(
            'binding_unavailable',
        )
        expect(issuesWith('guide', { type: 'Progress', binding: 'reading', label: null }).join()).toContain(
            'binding_unavailable',
        )
        expect(
            issuesWith('guide', {
                type: 'Toggle',
                binding: 'built-view',
                label: { kind: 'literal', text: 'Show how Meta AI built this' },
            }).join(),
        ).toContain('binding_unavailable')
    })
})
