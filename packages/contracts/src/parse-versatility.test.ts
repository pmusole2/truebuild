import { describe, expect, it } from 'vitest'
import {
    createDemoManual,
    manualSessionSchema,
    manualStepSchema,
    stepEvidenceRequirements,
    type ManualSession,
} from './index'
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
    it('rejects uncited quantity exemption and still blocks an unreadable printed quantity', () => {
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
        session.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason: 'The printed count is blurred.' }
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
    it('accepts a removal step with the tool it uses and leaves unstated requirements unblocked', () => {
        const session = createDemoManual()
        const removal = {
            ...session.reviewedSteps[0]!,
            stepId: 'step-remove',
            order: 3,
            title: 'Take the side panel off',
            kind: 'remove',
            requirements: null,
            parts: [
                {
                    partId: 'side-panel',
                    quantity: { state: 'known', value: 1, sourceRefs: cited },
                    quantityBasis: null,
                },
                {
                    partId: 'screwdriver',
                    quantity: { state: 'known', value: 1, sourceRefs: cited },
                    quantityBasis: null,
                },
            ],
            orientation: unknown,
            connection: unknown,
            visibleChecks: [],
            correction: null,
        }
        const parsed = manualSessionSchema.parse({
            ...session,
            parts: [
                ...session.parts,
                { partId: 'screwdriver', name: { state: 'known', value: 'Phillips screwdriver', sourceRefs: cited } },
            ],
            reviewedSteps: [...session.reviewedSteps, removal],
            rawExtraction: null,
        })
        const step = parsed.reviewedSteps[2]!
        expect(step).toMatchObject({ kind: 'remove', parts: [{ partId: 'side-panel' }, { partId: 'screwdriver' }] })
        expect(stepEvidenceRequirements(step)).toEqual({
            parts: false,
            orientation: false,
            connection: false,
            visibleChecks: false,
        })
        expect(unresolvedCriticalFacts(parsed)).toEqual([])
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

describe('unstated quantities in review', () => {
    function singleUse(name: string): ManualSession {
        const session = createDemoManual()
        session.rawExtraction = null
        session.reviewedSteps = [session.reviewedSteps[0]!]
        session.parts = [{ ...session.parts[0]!, name: { state: 'known', value: name, sourceRefs: cited } }]
        session.reviewedSteps[0]!.parts[0]!.quantity = unknown
        session.reviewedSteps[0]!.parts[0]!.quantityBasis = null
        return session
    }

    it.each(['Side panel', 'A support', 'One bracket', 'Lower frame'])(
        'allows the single-use singular name %s without manufacturing a quantity',
        (name) => {
            const session = singleUse(name)
            expect(unresolvedCriticalFacts(session)).toEqual([])
            const parsed = manualSessionSchema.safeParse(session)
            expect(parsed.success).toBe(true)
            if (parsed.success) expect(parsed.data.reviewedSteps[0]!.parts[0]!.quantity).toEqual(unknown)
        },
    )

    it.each([
        'Panels',
        'Some supports',
        'Panel and frame',
        'Two brackets',
        'Feet',
        'Panels for frame',
        'Feet for base',
        'Few brackets',
    ])('allows unstated counts regardless of the part label %s', (name) => {
        const session = singleUse(name)
        expect(unresolvedCriticalFacts(session)).toEqual([])
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
    })

    it('allows an unstated count when the part is used by more than one step', () => {
        const session = singleUse('Side panel')
        session.reviewedSteps.push({ ...structuredClone(session.reviewedSteps[0]!), stepId: 'second', order: 2 })
        expect(unresolvedCriticalFacts(session)).toEqual([])
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
    })

    it.each(['Manual shows 1 or 2.', 'The count is blurred.', 'The manual does not specify whether one or two.'])(
        'keeps a truly ambiguous singular count blocked: %s',
        (reason) => {
            const session = singleUse('Side panel')
            session.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason }
            expect(unresolvedCriticalFacts(session).some((issue) => issue.includes('quantity'))).toBe(true)
            expect(manualSessionSchema.safeParse(session).success).toBe(false)
        },
    )
})

it.each([
    [
        'Bolts',
        'Step 1 text lists Bolts without installed count; diagram shows two stacks plus repeated zoom view and four mounting holes, cannot establish required count without double-counting.',
    ],
    [
        'Washers',
        'Step 1 text lists Washers without installed count; diagram shows two stacks plus repeated zoom view, cannot establish required count.',
    ],
    ['Batteries', 'Manual says batteries plural without count and diagram shows no clear distinct count.'],
    ['Batteries', 'Earlier quantity unknown and manual gives no count; diagram shows no clear distinct count.'],
    ['Bolts', 'Installed count not printed; diagram shows two stacks.'],
    ['Bolts', 'Installed count not printed; two stacks visible.'],
])('allows %s with no printed count, without entering a number', (name, reason) => {
    const session = createDemoManual()
    session.rawExtraction = null
    session.reviewedSteps = [session.reviewedSteps[0]!]
    session.parts[0]!.name = { state: 'known', value: name, sourceRefs: cited }
    session.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason }
    expect(unresolvedCriticalFacts(session)).toEqual([])
    expect(manualSessionSchema.safeParse(session).success).toBe(true)
    expect(session.reviewedSteps[0]!.parts[0]!.quantity.state).toBe('unknown')
})

it.each([
    'The manual prints 4; this count is not confirmed.',
    'The count is not printed clearly; it reads 3 or 5.',
    'Count is missing; the figure shows either 2 or 4 screws.',
    'The count is not stated; the figure shows 4 screws.',
    'The count is not stated; it could be one or two.',
    'The count is not stated; it may vary.',
    'The count is not stated; possibly 3.',
    'The count is not stated; the figure shows four screws.',
    'The count is not stated; 4 bolts visible in diagram.',
    'Count not stated; screws shown as 4 in diagram.',
    'Count not stated; printing is unclear.',
    'The count is not stated; the number is printed as 4 but it is hard to read.',
    'Manual does not state a count for the bolts; a total of 6 appears in the table.',
    'Installed count not printed; manual states four bolts.',
    'Installed count not printed; the count reads four.',
    'Installed count not printed; the printed count is four.',
])('keeps a printed but unconfirmed count blocked: %s', (reason) => {
    const session = createDemoManual()
    session.reviewedSteps[0]!.parts[0]!.quantity = {
        state: 'unknown',
        reason,
    }
    expect(unresolvedCriticalFacts(session).some((issue) => issue.includes('quantity'))).toBe(true)
    expect(manualSessionSchema.safeParse(session).success).toBe(false)
})
