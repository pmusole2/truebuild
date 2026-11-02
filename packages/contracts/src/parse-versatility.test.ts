import { describe, expect, it } from 'vitest'
import { createDemoManual, manualSessionSchema, manualStepSchema } from './index'
import { modelParseMetadataSchema, selectCompactStepSourcePageIds, unresolvedCriticalFacts } from './model'

const cited = [{ pageId: 'demo-page-1', region: null }]
const unknown = { state: 'unknown' as const, reason: 'Manual does not specify this.' }

function sessionWith(step: unknown): unknown {
    return { ...createDemoManual(), reviewedSteps: [step], rawExtraction: null }
}

describe('manual parse versatility', () => {
    it.each(['user_supplied', 'not_specified'])('accepts cited %s quantity without inventing a number', (kind) => {
        const step = createDemoManual().reviewedSteps[0]!
        const candidate = {
            ...step,
            parts: step.parts.map((part) => ({
                ...part,
                quantity: unknown,
                quantityBasis: { kind, sourceRefs: cited },
            })),
        }
        const parsed = manualSessionSchema.safeParse(sessionWith(candidate))
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(unresolvedCriticalFacts(parsed.data)).toEqual([])
            expect(parsed.data.reviewedSteps[0]!.parts[0]!.quantity).toEqual(unknown)
        }
    })
    it('rejects uncited quantity exemption and still blocks an ungrounded unknown quantity', () => {
        const step = createDemoManual().reviewedSteps[0]!
        expect(
            manualStepSchema.safeParse({
                ...step,
                parts: [
                    { ...step.parts[0], quantity: unknown, quantityBasis: { kind: 'user_supplied', sourceRefs: [] } },
                ],
            }).success,
        ).toBe(false)
        const session = createDemoManual()
        session.reviewedSteps[0]!.parts[0]!.quantity = unknown
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
        expect(unresolvedCriticalFacts(session).some((issue) => issue.includes('quantity'))).toBe(true)
    })
    it('keeps one parent with cited alternatives and requires valid unique selection', () => {
        const step = createDemoManual().reviewedSteps[0]!
        const alternatives = ['wall', 'floor'].map((alternativeId) => ({
            alternativeId,
            title: alternativeId,
            description: `Use the ${alternativeId} path.`,
            sourceRefs: cited,
        }))
        const candidate = { ...step, alternatives, selectedAlternativeId: 'wall' }
        const parsed = manualSessionSchema.parse(sessionWith(candidate))
        expect(parsed.reviewedSteps).toHaveLength(1)
        expect(unresolvedCriticalFacts(parsed)).toEqual([])
        expect(manualStepSchema.safeParse({ ...candidate, selectedAlternativeId: 'absent' }).success).toBe(false)
        expect(manualStepSchema.safeParse({ ...candidate, selectedAlternativeId: null }).success).toBe(false)
        expect(
            manualStepSchema.safeParse({ ...candidate, alternatives: [alternatives[0], alternatives[0]] }).success,
        ).toBe(false)
        expect(
            manualStepSchema.safeParse({
                ...candidate,
                alternatives: alternatives.map((alt) => ({ ...alt, sourceRefs: [] })),
            }).success,
        ).toBe(false)
        expect(manualStepSchema.safeParse({ ...step, selectedAlternativeId: 'wall' }).success).toBe(false)
    })
    it('allows cited nonassembly instructions without inapplicable assembly facts', () => {
        const step = createDemoManual().reviewedSteps[0]!
        const candidate = {
            ...step,
            kind: 'adjust',
            parts: [],
            orientation: unknown,
            connection: unknown,
            visibleChecks: [],
        }
        const parsed = manualSessionSchema.parse(sessionWith(candidate))
        expect(unresolvedCriticalFacts(parsed)).toEqual([])
        expect(
            manualSessionSchema.safeParse(
                sessionWith({
                    ...candidate,
                    kind: 'assembly',
                    requirements: { orientation: false, connection: false, visibleChecks: false },
                }),
            ).success,
        ).toBe(false)
        expect(
            manualSessionSchema.safeParse(
                sessionWith({
                    ...candidate,
                    requirements: { orientation: true, connection: false, visibleChecks: false },
                }),
            ).success,
        ).toBe(false)
        expect(
            manualSessionSchema.safeParse(
                sessionWith({ ...candidate, visibleChecks: [{ checkId: 'check', description: unknown }] }),
            ).success,
        ).toBe(false)
    })
    it('preserves legacy assembly gates, unknown names and correction review', () => {
        const session = createDemoManual()
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        session.reviewedSteps[0]!.orientation = unknown
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
        expect(unresolvedCriticalFacts(session).some((issue) => issue.includes('orientation'))).toBe(true)
        const correction = createDemoManual()
        correction.reviewedSteps[0]!.correction = {
            reviewed: false,
            actions: [{ actionId: 'fix', instruction: 'Recheck the diagram.', sourceRefs: cited }],
        }
        expect(manualSessionSchema.safeParse(correction).success).toBe(false)
    })
    it('validates new citations and includes them in compact page selection', () => {
        const session = createDemoManual()
        session.pages.push({ ...session.pages[0]!, pageId: 'page-2', assetId: 'asset-2' })
        const step = {
            ...session.reviewedSteps[0]!,
            alternatives: ['a', 'b'].map((alternativeId) => ({
                alternativeId,
                title: alternativeId,
                description: alternativeId,
                sourceRefs: [{ pageId: 'page-2', region: null }],
            })),
            selectedAlternativeId: 'a',
        }
        const candidate = manualSessionSchema.parse({ ...session, reviewedSteps: [step] })
        expect(selectCompactStepSourcePageIds(candidate, step.stepId)).toEqual(['demo-page-1', 'page-2'])
        expect(manualSessionSchema.safeParse({ ...candidate, pages: [session.pages[0]] }).success).toBe(false)
    })
    it('accepts stored page counts for explicit service admission and validates language', () => {
        const session = createDemoManual()
        const metadata = {
            mode: 'model',
            requestId: 'parse',
            binding: { kind: 'manual', manualId: 'm', revision: 1 },
            pages: session.pages,
        }
        expect(modelParseMetadataSchema.safeParse({ ...metadata, language: 'pt-BR' }).success).toBe(true)
        expect(
            modelParseMetadataSchema.safeParse({ ...metadata, language: 'translate everything to English' }).success,
        ).toBe(false)
        expect(
            modelParseMetadataSchema.safeParse({
                ...metadata,
                pages: Array.from({ length: 9 }, (_, index) => ({
                    ...session.pages[0],
                    pageId: `p${index}`,
                    assetId: `a${index}`,
                })),
            }).success,
        ).toBe(true)
    })
})

it('rejects a numeric quantity that contradicts a not-specified manual basis', () => {
    const step = createDemoManual().reviewedSteps[0]!
    const candidate = {
        ...step,
        parts: [{ ...step.parts[0]!, quantityBasis: { kind: 'not_specified', sourceRefs: cited } }],
    }
    expect(manualStepSchema.safeParse(candidate).success).toBe(false)
    expect(
        manualStepSchema.safeParse({
            ...candidate,
            parts: [{ ...candidate.parts[0], quantityBasis: { kind: 'user_supplied', sourceRefs: cited } }],
        }).success,
    ).toBe(true)
})
