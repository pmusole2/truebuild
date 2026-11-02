import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    screenDocumentV2Schema,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
} from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { encodeWireProposal } from '../../providers/document-wire'
import { demoSession, documentInputs } from '../../test-support/document-inputs'
import { buildDocumentContext, sha256 } from './context'
import { evaluateWire } from './ground'

const hidden = (node: ScreenNodeV2): ScreenNodeV2 => ({
    type: 'Section',
    title: { kind: 'literal', text: 'More detail' },
    collapsible: true,
    initiallyOpen: false,
    children: [node],
})

function editFact(
    proposal: ScreenProposalV2,
    factId: string,
    edit: (node: ScreenNodeV2) => ScreenNodeV2,
): ScreenProposalV2 {
    const walk = (node: ScreenNodeV2): ScreenNodeV2 => {
        if (node.type === 'Text' && node.content.kind === 'fact' && node.content.factId === factId) return edit(node)
        return 'children' in node ? { ...node, children: node.children.map(walk) } : node
    }
    return { ...proposal, body: walk(proposal.body) }
}

describe('question and answer detail at the raw provider and client gates', () => {
    it.each(['questions', 'answer'] as const)(
        '%s accepts a complete raw proposal with explicitly classified detail closed',
        (kind) => {
            const inputs = documentInputs(kind)
            const context = buildDocumentContext(inputs)
            let proposal = buildFallbackProposalV2(context.material)
            // These directions were explicitly classified separately from the manual's safety notes.
            proposal = editFact(proposal, 'orientation', hidden)
            const evaluated = evaluateWire(JSON.parse(JSON.stringify(encodeWireProposal(proposal))), context)
            expect(evaluated).toMatchObject({ ok: true })
            if (!evaluated.ok) return
            const document = assembleDocumentV2(
                context.material,
                evaluated.proposal,
                { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
                { sha256Hex: sha256, now: (): Date => new Date(0) },
            )
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256)).toEqual([])
            expect(document.facts.find((fact) => fact.factId === 'orientation')).toMatchObject({
                text: 'Groove faces inward toward the divider.',
                basis: 'direction',
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            })
            const view = context.view.dynamic.document as { facts: unknown[]; requirements: { facts: string[] } }
            expect(view.facts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: 'orientation', text: 'Groove faces inward toward the divider.' }),
                ]),
            )
            expect(view.requirements.facts).not.toContain('orientation')
        },
    )

    it.each(['questions', 'answer'] as const)('%s rejects hiding or omitting a legacy unclassified warning', (kind) => {
        const manual = demoSession({ safety: false })
        delete manual.reviewedSteps[0]!.safetyNotes
        const orientation = manual.reviewedSteps[0]!.orientation
        if (orientation.state !== 'known') throw new Error('The demo orientation must be known')
        orientation.value.description = 'Do not release the panel. It can fall and cause injury.'
        const context = buildDocumentContext(documentInputs(kind, manual))
        const original = buildFallbackProposalV2(context.material)
        for (const edit of [hidden, (): ScreenNodeV2 => ({ type: 'Spacer', size: 'sm' })]) {
            const changed = editFact(original, 'orientation', edit)
            const evaluated = evaluateWire(encodeWireProposal(changed), context)
            expect(evaluated.ok).toBe(false)
            if (!evaluated.ok) expect(evaluated.issues.join()).toMatch(/required_fact_is_missing/u)
        }
    })

    it.each(['questions', 'answer'] as const)('%s rejects hidden or omitted safety', (kind) => {
        const context = buildDocumentContext(documentInputs(kind))
        const original = buildFallbackProposalV2(context.material)
        for (const edit of [hidden, (): ScreenNodeV2 => ({ type: 'Spacer', size: 'sm' })]) {
            const changed = editFact(original, 'safety:n1', edit)
            const evaluated = evaluateWire(encodeWireProposal(changed), context)
            expect(evaluated.ok).toBe(false)
            if (!evaluated.ok) expect(evaluated.issues.join()).toMatch(/required_fact_is_missing/u)
        }
    })

    it('keeps an answer card in the ready screen and requires it there', () => {
        const context = buildDocumentContext(documentInputs('answer'))
        const proposal = buildFallbackProposalV2(context.material)
        const result = evaluateWire(encodeWireProposal(proposal), context)
        expect(result).toMatchObject({ ok: true })
        const answers: ScreenNodeV2[] = []
        visitVariantNodesV2(proposal, '', ({ node }) => {
            if (node.type === 'VerdictCard') answers.push(node)
        })
        expect(answers).toHaveLength(1)
        const withoutAnswer = structuredClone(proposal)
        const walk = (node: ScreenNodeV2): ScreenNodeV2 => {
            if (node.type === 'VerdictCard') return { type: 'Spacer', size: 'sm' }
            return 'children' in node ? { ...node, children: node.children.map(walk) } : node
        }
        withoutAnswer.body = walk(withoutAnswer.body)
        const missing = evaluateWire(encodeWireProposal(withoutAnswer), context)
        expect(missing.ok).toBe(false)
        if (!missing.ok) expect(missing.issues.join()).toMatch(/required_fact_is_missing|required_node_is_missing/u)
    })
})
