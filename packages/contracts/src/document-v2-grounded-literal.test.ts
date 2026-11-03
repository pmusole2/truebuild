import { describe, expect, it } from 'vitest'

import {
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    semanticIssuesV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
} from './index'

const GROUNDED = { groundedTokens: true } as const

/** A Guide of step 1 whose own safety note states `note`: the only facts a digit token may be grounded in. */
function guideMaterial(note: string): ReturnType<typeof documentMaterialV2> {
    const session = createDemoManual()
    session.reviewedSteps[0]!.safetyNotes = [
        {
            noteId: 'n1',
            note: { state: 'known', value: note, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
        },
    ]
    const inputs: ScreenContextInputsV2 = {
        kind: 'guide',
        session,
        stepId: 'step-1',
        captureId: null,
        result: null,
        failure: null,
        uiState: null,
    }
    return documentMaterialV2(inputs, false)
}

/**
 * The fallback Guide with the step's own safety fact written as the literal `text` instead of its fact reference. The
 * guard keeps a fixture change from making every case below pass vacuously.
 */
function withLiteral(material: ReturnType<typeof documentMaterialV2>, text: string): ScreenProposalV2 {
    const proposal = buildFallbackProposalV2(material)
    const walk = (node: ScreenNodeV2): ScreenNodeV2 => {
        const next: ScreenNodeV2 =
            node.type === 'Text' && node.content.kind === 'fact' && node.content.factId === 'safety:n1'
                ? { ...node, content: { kind: 'literal', text } }
                : node
        return 'children' in next ? ({ ...next, children: next.children.map(walk) } as ScreenNodeV2) : next
    }
    const written = { ...proposal, body: walk(proposal.body) }
    expect(JSON.stringify(written.body)).toContain(`"text":${JSON.stringify(text)}`)
    return written
}

const literalIssues = (issues: string[]): string[] =>
    issues.filter((issue) => /:literal_(digits|not_listed)$/u.test(issue))

describe('literal text is grounded only by the current step facts', () => {
    const material = guideMaterial(
        'Fasten with M4x15 screws only, at -5 and ≤10, using 2x4 stock, 2.5 mm, M4.5 and 1,000.',
    )

    it.each(['M4x15', '2x4', 'stock', 'M4x15 screws', '-5', '≤10'])('accepts verbatim grounded text %s', (text) => {
        expect(literalIssues(semanticIssuesV2(withLiteral(material, text), material, GROUNDED))).toEqual([])
    })

    it.each(['M6x20', 'M4x1', 'M4x15 bolts', '5', '10', '2', 'M4', '1', 'invented'])(
        'still rejects the ungrounded literal %s',
        (text) => {
            expect(
                literalIssues(semanticIssuesV2(withLiteral(material, text), material, GROUNDED)).length,
            ).toBeGreaterThan(0)
        },
    )

    it('rejects a token with multiple possible supporting facts', () => {
        const ambiguous = guideMaterial('Lift with 2 people.')
        ambiguous.facts.push({ ...ambiguous.facts[0]!, factId: 'other', text: 'Fasten with 2 M4 screws.' })
        expect(
            literalIssues(semanticIssuesV2(withLiteral(ambiguous, '2'), ambiguous, GROUNDED)).length,
        ).toBeGreaterThan(0)
    })

    it('does not ground text from another step or a screen without the current Guide step', () => {
        const other = guideMaterial('Fasten with M6x20 bolts.')
        other.inputs.kind = 'more'
        expect(
            literalIssues(semanticIssuesV2(withLiteral(material, 'M6x20'), material, GROUNDED)).length,
        ).toBeGreaterThan(0)
        expect(literalIssues(semanticIssuesV2(withLiteral(other, 'M6x20'), other, GROUNDED)).length).toBeGreaterThan(0)
    })

    it('keeps the client rule strict: the same exact token is rejected without server grounding', () => {
        const issues = semanticIssuesV2(withLiteral(material, 'M4x15'), material)
        expect(issues.some((issue) => issue.endsWith(':literal_digits'))).toBe(true)
    })

    it('keeps raw-string fields strict even when their text is grounded', () => {
        const proposal = buildFallbackProposalV2(material)
        proposal.body = {
            type: 'TextField',
            binding: 'question',
            label: { kind: 'literal', text: 'Question' },
            placeholder: 'M4x15',
        }
        expect(semanticIssuesV2(proposal, material, GROUNDED)).toContain('body:literal_not_listed')
    })
})
