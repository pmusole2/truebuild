import { describe, expect, it } from 'vitest'

import {
    buildFallbackProposalV2,
    documentMaterialV2,
    manualChecksInitiallyOpen,
    manualDirectionGroups,
    manualDirectionFacts,
    manualSessionSchema,
    requiredManualFacts,
    sourceResolverV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
} from './index'
import { recordedDirectionCases as recorded } from './step-directions.test-support'

function descendants(node: ScreenNodeV2): ScreenNodeV2[] {
    return [node, ...('children' in node ? node.children.flatMap(descendants) : [])]
}

function forStep(session: ManualSession, stepId: string): ScreenContextInputsV2 {
    return { kind: 'guide', session, stepId, captureId: null, result: null, failure: null }
}

describe('one source-backed Directions rule across recorded manuals', () => {
    it('preserves the conservative legacy mandatory payload outside the new Guide', () => {
        const session = manualSessionSchema.parse(recorded[0]!.session)
        const step = session.reviewedSteps.find((item) => item.stepId === recorded[0]!.stepId)!
        step.safetyNotes = null
        step.correction = {
            reviewed: false,
            actions: [{ actionId: 'legacy-fix', instruction: 'Keep the supported fix.', sourceRefs: step.sourceRefs }],
        }
        session.rawExtraction = {
            parts: session.parts,
            unknowns: [],
            steps: session.reviewedSteps.map((item) => ({
                ...item,
                correction: item.correction === null ? null : { ...item.correction, reviewed: false },
            })),
        }
        session.reviewStatus = 'unreviewed'
        session.reviewedSteps = []
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        expect(requiredManualFacts(session, step.stepId).some((fact) => fact.factId === 'correction:legacy-fix')).toBe(
            false,
        )
        expect(manualDirectionFacts(session, step.stepId).some((fact) => fact.factId === 'correction:legacy-fix')).toBe(
            false,
        )
    })
    it.each(recorded.flatMap((row) => [false, true].map((actions) => ({ ...row, actions }))))(
        '$name with actions=$actions: procedure only, checks separate, unreviewed correction hidden',
        (row) => {
            const session = manualSessionSchema.parse(row.session)
            const step = (
                session.reviewStatus === 'reviewed' ? session.reviewedSteps : session.rawExtraction!.steps
            ).find((candidate) => candidate.stepId === row.stepId)!
            if (row.actions) {
                step.actions = row.instructions.map((instruction, index) => ({
                    actionId: `a${index}`,
                    instruction,
                    sourceRefs: step.sourceRefs,
                }))
            } else {
                delete step.actions
            }
            step.correction = {
                reviewed: false,
                actions: [
                    {
                        actionId: 'unreviewed',
                        instruction: 'Unreviewed fix must stay hidden.',
                        sourceRefs: step.sourceRefs,
                    },
                ],
            }
            if (session.reviewStatus === 'reviewed') {
                session.reviewStatus = 'unreviewed'
                session.rawExtraction = {
                    parts: session.parts,
                    steps: session.reviewedSteps.map((item) => ({
                        ...item,
                        correction: item.correction === null ? null : { ...item.correction, reviewed: false },
                    })),
                    unknowns: [],
                }
                session.reviewedSteps = []
            }
            expect(manualSessionSchema.safeParse(session).success).toBe(true)
            const facts = manualDirectionFacts(session, step.stepId)
            const groups = manualDirectionGroups(facts)
            const expected = row.actions
                ? row.instructions
                : [
                      step.title,
                      ...(step.orientation.state === 'known' ? [step.orientation.value.description] : []),
                      ...(step.connection.state === 'known' ? [step.connection.value.description] : []),
                  ]
            expect(groups.directions.map((fact) => fact.text)).toEqual(expected)
            expect(facts.some((fact) => fact.factId.startsWith('correction:'))).toBe(false)
            const material = documentMaterialV2(forStep(session, step.stepId), false)
            const proposal = buildFallbackProposalV2(material)
            expect(proposal.header.title).toEqual({ kind: 'bound', key: 'step-position' })
            expect(proposal.header.subtitle).toEqual(row.actions ? { kind: 'bound', key: 'step-title' } : null)
            const nodes = descendants(proposal.body)
            const directions = nodes.find(
                (node) => node.type === 'Section' && node.title?.kind === 'literal' && node.title.text === 'Directions',
            )!
            const checks = nodes.find(
                (node) =>
                    node.type === 'Section' && node.title?.kind === 'literal' && node.title.text === 'Check your work',
            )!
            const ids = (node: ScreenNodeV2): string[] =>
                descendants(node).flatMap((child) =>
                    child.type === 'Text' && child.content.kind === 'fact' ? [child.content.factId] : [],
                )
            expect(ids(directions)).toEqual(groups.directions.map((fact) => fact.factId))
            const directionSources = descendants(directions).flatMap((node) =>
                node.type === 'Citation' ? node.sources : [],
            )
            expect(directionSources).toEqual(
                expect.arrayContaining(
                    sourceResolverV2(material.sources)(groups.directions.flatMap((fact) => fact.sourceRefs)),
                ),
            )
            expect(checks).toMatchObject({ collapsible: true, initiallyOpen: manualChecksInitiallyOpen(step) })
            expect(ids(checks)).toEqual(groups.checks.map((fact) => fact.factId))
            expect(ids(directions).some((id) => ids(checks).includes(id))).toBe(false)
            expect(material.facts.some((fact) => fact.text === 'Unreviewed fix must stay hidden.')).toBe(false)
        },
    )
})
