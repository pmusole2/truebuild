import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { modelCheckMetadataSchema } from './model'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    buildFallbackDocumentV2,
    rebindGeneratedStatesV2,
    documentMaterialV2,
    manualSessionSchema,
    manualStepSchema,
    parsedManualSchema,
    manualDirectionFacts,
    requiredManualFacts,
    projectManualSessionExtensions,
    withoutUnreviewedCorrections,
    createDemoManual,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
} from './index'
import { recordedDirectionCases } from './step-directions.test-support'

const deps = {
    sha256Hex: (text: string): string => createHash('sha256').update(text).digest('hex'),
    now: (): Date => new Date('2026-11-03T10:00:00.000Z'),
}

function inputs(): ScreenContextInputsV2 {
    const row = recordedDirectionCases[0]!
    const session = manualSessionSchema.parse(row.session)
    const step = session.reviewedSteps.find((item) => item.stepId === row.stepId)!
    step.actions = row.instructions.map((instruction, index) => ({
        actionId: `a${index}`,
        instruction,
        sourceRefs: step.sourceRefs,
    }))
    return { kind: 'guide', session, stepId: step.stepId, captureId: null, result: null, failure: null }
}

describe('step direction compatibility boundaries', () => {
    it.each([true, false])('accepts request-bound documents in legacy=%s mode using the server echo', (legacy) => {
        const request = inputs()
        const material = documentMaterialV2(request, legacy)
        const document = assembleDocumentV2(
            material,
            buildFallbackProposalV2(material),
            {
                source: 'fallback',
                evidence: 'synthetic-fixture',
                fallbackReason: 'disabled',
            },
            deps,
        )
        expect(document.metadata).toMatchObject(legacy ? {} : { stepActions: 1 })
        if (legacy) expect(document.metadata).not.toHaveProperty('stepActions')
        expect(verifyDocumentAgainstInputsV2(document, request, deps.sha256Hex)).toEqual([])
    })

    it.each(['camera', 'result', 'answer', 'recovery'] as const)(
        'keeps action-bearing %s documents on their established material',
        (kind) => {
            const request = { ...inputs(), kind }
            const material = documentMaterialV2(request, false)
            const document = assembleDocumentV2(
                material,
                buildFallbackProposalV2(material),
                {
                    source: 'fallback',
                    evidence: 'synthetic-fixture',
                    fallbackReason: 'disabled',
                },
                deps,
            )
            expect(document.metadata.stepActions).toBeUndefined()
            expect(document.facts.some((fact) => fact.factId.startsWith('action:'))).toBe(false)
            expect(verifyDocumentAgainstInputsV2(document, request, deps.sha256Hex)).toEqual([])
        },
    )

    it.each([false, true])(
        'only carries generated non-factual states from the same Guide layout (legacy donor=%s)',
        (legacy) => {
            const request = inputs()
            request.session!.reviewedSteps.find((step) => step.stepId === request.stepId)!.safetyNotes = []
            const material = documentMaterialV2(request, legacy)
            const donor = assembleDocumentV2(
                material,
                buildFallbackProposalV2(material),
                {
                    source: 'generated',
                    evidence: 'synthetic-fixture',
                    fallbackReason: null,
                },
                deps,
            )
            const target = buildFallbackDocumentV2(request, {
                ...deps,
                reason: 'busy',
                evidence: 'local-deterministic',
            })
            const rebound = rebindGeneratedStatesV2(request, target, [donor], deps, { states: ['pending'] })
            expect(rebound.carried).toEqual(legacy ? [] : ['pending'])
            expect(rebound.document.metadata.stepActions).toBe(1)
            expect(rebound.document.facts).toEqual(target.facts)
            expect(verifyDocumentAgainstInputsV2(rebound.document, request, deps.sha256Hex)).toEqual([])
        },
    )

    it('loads a saved future optional step field but preserves unrelated strict validation', () => {
        const request = inputs()
        const session = structuredClone(request.session!)
        Object.assign(session.reviewedSteps[0]!, { sourceText: 'Future optional source text' })
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        Object.assign(session.reviewedSteps[0]!, { surpriseField: 'Must remain invalid' })
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
    })

    it('projects a saved session for a strict bridge reader without touching correction actions', () => {
        const session = createDemoManual()
        const step = session.reviewedSteps[0]!
        step.actions = [{ actionId: 'turn', instruction: 'Turn the panel.', sourceRefs: step.sourceRefs }]
        Object.assign(step, { sourceText: 'Future source words' })
        step.correction = {
            reviewed: true,
            actions: [{ actionId: 'fix', instruction: 'Turn it back.', sourceRefs: step.sourceRefs }],
        }
        session.rawExtraction = {
            parts: session.parts,
            steps: session.reviewedSteps.map((item) => ({
                ...item,
                correction: item.correction === null ? null : { ...item.correction, reviewed: false },
            })),
            unknowns: [],
        }
        const { actions: _actions, ...oldShape } = manualStepSchema.shape
        const oldStep = z.strictObject(oldShape)
        const oldSession = z.strictObject({
            ...manualSessionSchema.shape,
            reviewedSteps: z.array(oldStep),
            rawExtraction: z.strictObject({ ...parsedManualSchema.shape, steps: z.array(oldStep) }).nullable(),
        })
        const restored = oldSession.parse(projectManualSessionExtensions(session, []))
        expect(restored.reviewedSteps).toHaveLength(2)
        expect(restored.reviewedSteps[0]).not.toHaveProperty('actions')
        expect(restored.reviewedSteps[0]).not.toHaveProperty('sourceText')
        expect(restored.rawExtraction!.steps[0]).not.toHaveProperty('actions')
        expect(restored.rawExtraction!.steps[0]).not.toHaveProperty('sourceText')
        expect(restored.reviewedSteps[0]!.correction!.actions).toHaveLength(1)
    })

    it('keeps the legacy required count and excludes unreviewed fixes in both layouts and model projections', () => {
        const session = createDemoManual()
        const step = session.reviewedSteps[0]!
        delete step.safetyNotes
        step.correction = {
            reviewed: true,
            actions: [{ actionId: 'fix', instruction: 'A reviewed fix.', sourceRefs: step.sourceRefs }],
        }
        expect(requiredManualFacts(session, step.stepId)).toHaveLength(5)
        expect(
            documentMaterialV2(
                { kind: 'guide', session, stepId: step.stepId, captureId: null, result: null, failure: null },
                false,
            ).requirements.facts,
        ).toHaveLength(5)
        step.correction.reviewed = false
        session.rawExtraction = { parts: session.parts, steps: session.reviewedSteps, unknowns: [] }
        session.reviewStatus = 'unreviewed'
        expect(requiredManualFacts(session, step.stepId).some((fact) => fact.text === 'A reviewed fix.')).toBe(false)
        expect(
            [true, false]
                .flatMap((legacy) => manualDirectionFacts(session, step.stepId, legacy))
                .some((fact) => fact.text === 'A reviewed fix.'),
        ).toBe(false)
        expect(JSON.stringify(withoutUnreviewedCorrections(session))).not.toContain('A reviewed fix.')
    })

    it('admits an action-bearing check session without weakening other strict request fields', () => {
        const session = createDemoManual()
        const step = session.reviewedSteps[0]!
        step.actions = [{ actionId: 'turn', instruction: 'Turn the panel.', sourceRefs: step.sourceRefs }]
        Object.assign(step, { sourceText: 'Future source words' })
        const request = {
            mode: 'model',
            requestId: 'check-with-actions',
            session,
            binding: {
                kind: 'capture',
                manualId: session.manualId,
                revision: session.revision,
                stepId: step.stepId,
                captureId: 'c1',
            },
            sourcePageIds: ['demo-page-1'],
            observation: { mimeType: 'image/png', width: 20, height: 16 },
        }
        expect(modelCheckMetadataSchema.safeParse(request).success).toBe(true)
        expect(modelCheckMetadataSchema.safeParse({ ...request, unknown: 1 }).success).toBe(false)
    })

    it('normalizes action count and long instructions instead of rejecting a parse', () => {
        const request = inputs()
        const step = request.session!.reviewedSteps.find((item) => item.stepId === request.stepId)!
        const instructions = Array.from({ length: 8 }, (_, index) => ({
            actionId: `a${index}`,
            instruction: `Move ${'carefully '.repeat(20)}now.`,
            sourceRefs: step.sourceRefs,
        }))
        const parsed = manualStepSchema.safeParse({ ...step, actions: instructions })
        expect(parsed.success).toBe(true)
        if (!parsed.success) return
        expect(parsed.data.actions).toHaveLength(6)
        expect(parsed.data.actions!.every((action) => action.instruction.length <= 120)).toBe(true)
        expect(parsed.data.actions![0]!.instruction).toBe(`Move ${'carefully '.repeat(11)}`.trim())
        const unicode = manualStepSchema.parse({
            ...step,
            actions: [{ ...instructions[0], instruction: 'a'.repeat(119) + '😀more' }],
        })
        expect(unicode.actions![0]!.instruction).toBe('a'.repeat(119))
        expect(manualStepSchema.safeParse({ ...step, actions: [{ ...instructions[0], instruction: 2 }] }).success).toBe(
            false,
        )
    })
})
