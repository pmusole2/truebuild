import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    buildFallbackDocumentV2,
    createDemoManual,
    documentMaterialV2,
    photoSpineV2,
    questionResultSchema,
    screenDocumentV2Schema,
    sourceResolverV2,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenKindV2,
    type ScreenNodeV2,
} from './index'
import { createHeroResponse } from './hero'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }
const SAFETY = 'Keep fingers clear of the groove while the panel is lifted. Never put a hand under the panel.'
const LEGACY_WARNING = 'Do not release the panel until another person holds it. It can fall and cause injury.'
const DIRECTIONS = [
    ['orientation', 'Groove faces inward toward the divider.'],
    ['connection', 'Keep the panel free before seating the divider.'],
    ['check:groove-inward', 'The inward-facing groove is visible.'],
    ['correction:turn-panel', 'Turn the panel so the groove faces inward.'],
] as const
const LEGACY_DIRECTIONS = [['title', 'Stand the side panel upright'], ...DIRECTIONS] as const

function classifiedManual(): ManualSession {
    const manual = createDemoManual()
    manual.reviewedSteps[0]!.safetyNotes = [
        {
            noteId: 'n1',
            note: { state: 'known', value: SAFETY, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
        },
    ]
    return manual
}

function legacyManual(): ManualSession {
    const manual = createDemoManual()
    delete manual.reviewedSteps[0]!.safetyNotes
    return manual
}

function inputsFor(kind: ScreenKindV2, manual: ManualSession = legacyManual()): ScreenContextInputsV2 {
    return {
        kind,
        session: manual,
        stepId: 'step-1',
        captureId: ['questions', 'answer', 'result'].includes(kind) ? 'cap-1' : null,
        result:
            kind === 'answer'
                ? {
                      kind: 'question',
                      question: 'Which way?',
                      value: questionResultSchema.parse({
                          answer: 'The groove faces inward toward the divider.',
                          sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                          missingEvidence: ['A closer photo would help.'],
                      }),
                  }
                : kind === 'result'
                  ? { kind: 'check', value: createHeroResponse('reversed') }
                  : null,
        failure: null,
        uiState: {
            capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
        },
    }
}

const build = (inputs: ScreenContextInputsV2): ReturnType<typeof buildFallbackDocumentV2> =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })

describe('focused questions and answers retain complete step detail', () => {
    it('Guide keeps classified direction text and its citations visible', () => {
        const inputs = inputsFor('guide', classifiedManual())
        const document = build(inputs)
        const stated = new Map<string, boolean>()
        const citations: number[] = []
        visitVariantNodesV2(document, '', ({ node, hidden }) => {
            if (node.type === 'Text' && node.content.kind === 'fact') stated.set(node.content.factId, hidden)
            if (!hidden && node.type === 'Citation') citations.push(...node.sources)
        })
        for (const [factId, text] of DIRECTIONS) {
            const fact = document.facts.find((entry) => entry.factId === factId)!
            expect(fact.text).toBe(text)
            expect(stated.get(factId)).toBe(false)
            expect(citations).toEqual(expect.arrayContaining(sourceResolverV2(document.sources)(fact.sourceRefs)))
        }
        expect(stated.get('safety:n1')).toBe(false)
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it.each(['questions', 'answer'] as const)(
        '%s keeps explicitly classified directions unabridged and cited behind one closed More detail',
        (kind) => {
            const inputs = inputsFor(kind, classifiedManual())
            const document = build(inputs)
            expect(document.requirements.facts).toEqual(
                kind === 'answer' ? ['safety:n1', 'result:answer', 'result:answer-missing:0'] : ['safety:n1'],
            )
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
            const details: Extract<ScreenNodeV2, { type: 'Section' }>[] = []
            const stated = new Map<string, boolean>()
            const fields: ScreenNodeV2[] = []
            const photos: ScreenNodeV2[] = []
            const answers: ScreenNodeV2[] = []
            visitVariantNodesV2(document, '', ({ node, hidden }) => {
                if (node.type === 'Section' && node.title?.kind === 'literal' && node.title.text === 'More detail')
                    details.push(node)
                if (node.type === 'Text' && node.content.kind === 'fact') stated.set(node.content.factId, hidden)
                if (node.type === 'TextField') fields.push(node)
                if (node.type === 'Image' && node.source.kind === 'capture' && !hidden) photos.push(node)
                if (node.type === 'VerdictCard') answers.push(node)
            })
            expect(details).toHaveLength(1)
            expect(details[0]).toMatchObject({ collapsible: true, initiallyOpen: false })
            expect(fields).toHaveLength(kind === 'questions' ? 1 : 0)
            expect(photos).toHaveLength(1)
            expect(answers).toHaveLength(kind === 'answer' ? 1 : 0)
            const detailSources: number[] = []
            visitVariantNodesV2({ ...document, body: details[0]! }, '', ({ node }) => {
                if (node.type === 'Citation') detailSources.push(...node.sources)
            })
            for (const [factId, text] of DIRECTIONS) {
                const fact = document.facts.find((entry) => entry.factId === factId)!
                expect(fact).toMatchObject({ text, basis: 'direction' })
                expect(stated.get(factId)).toBe(true)
                expect(detailSources).toEqual(
                    expect.arrayContaining(sourceResolverV2(document.sources)(fact.sourceRefs)),
                )
            }
            expect(document.facts.filter((fact) => fact.basis !== 'result')).toHaveLength(DIRECTIONS.length + 1)
            if (kind === 'answer') {
                for (const { name, variant } of variantsOfV2(document)) {
                    expect(photoSpineV2(variant), name).toBe(photoSpineV2(document))
                }
            }
        },
    )

    it.each(['questions', 'answer'] as const)('%s keeps full explicit safety visible in every variant', (kind) => {
        const inputs = inputsFor(kind, classifiedManual())
        const document = build(inputs)
        expect(document.requirements.facts).toContain('safety:n1')
        expect(document.facts.find((fact) => fact.factId === 'safety:n1')?.text).toBe(SAFETY)
        for (const { name, variant, prefix } of variantsOfV2(document)) {
            const visible: string[] = []
            visitVariantNodesV2(variant, prefix, ({ node, hidden }) => {
                if (!hidden && node.type === 'Text' && node.content.kind === 'fact') visible.push(node.content.factId)
            })
            expect(visible, name).toContain('safety:n1')
            expect(visible, name).not.toContain('orientation')
        }
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it.each(['questions', 'answer'] as const)(
        '%s keeps every legacy unclassified direction and its complete warning visible in every variant',
        (kind) => {
            const manual = legacyManual()
            const orientation = manual.reviewedSteps[0]!.orientation
            if (orientation.state !== 'known') throw new Error('The demo orientation must be known')
            orientation.value.description = LEGACY_WARNING
            const inputs = inputsFor(kind, manual)
            const document = build(inputs)
            expect(document.requirements.facts).toEqual(
                expect.arrayContaining(LEGACY_DIRECTIONS.map(([factId]) => factId)),
            )
            expect(document.facts.find((fact) => fact.factId === 'orientation')).toMatchObject({
                text: LEGACY_WARNING,
                basis: 'unclassified-step',
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            })
            for (const { name, variant, prefix } of variantsOfV2(document)) {
                const visible: string[] = []
                visitVariantNodesV2(variant, prefix, ({ node, hidden }) => {
                    if (!hidden && node.type === 'Text' && node.content.kind === 'fact')
                        visible.push(node.content.factId)
                })
                expect(visible, name).toEqual(expect.arrayContaining(LEGACY_DIRECTIONS.map(([factId]) => factId)))
            }
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        },
    )

    it.each(['guide', 'result', 'recovery'] as const)(
        '%s still requires every unclassified direction visibly',
        (kind) => {
            const document = build(inputsFor(kind))
            expect(document.requirements.facts).toEqual(
                expect.arrayContaining(LEGACY_DIRECTIONS.map(([factId]) => factId)),
            )
            for (const { name, variant, prefix } of variantsOfV2(document)) {
                const visible: string[] = []
                visitVariantNodesV2(variant, prefix, ({ node, hidden }) => {
                    if (!hidden && node.type === 'Text' && node.content.kind === 'fact')
                        visible.push(node.content.factId)
                })
                expect(visible, name).toEqual(expect.arrayContaining(LEGACY_DIRECTIONS.map(([factId]) => factId)))
            }
            expect(documentMaterialV2(inputsFor(kind)).facts).toEqual(document.facts)
        },
    )
})
