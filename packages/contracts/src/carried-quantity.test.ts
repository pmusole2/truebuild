import { describe, expect, it } from 'vitest'
import { createDemoManual, manualSessionSchema, parsedManualSchema, type ManualSession } from './index'
import {
    MAX_PARSE_PAGES,
    PARSE_SPLIT_MESSAGE,
    modelCheckMetadataSchema,
    selectCompactStepSourcePageIds,
    unresolvedCriticalFacts,
} from './model'

const cited = [{ pageId: 'demo-page-1', region: null }]
const unknown = { state: 'unknown' as const, reason: 'Installed count cannot be read.' }

function carriedSession(): ManualSession {
    const session = createDemoManual()
    session.rawExtraction = null
    session.reviewedSteps[1]!.parts[0]!.quantityBasis = {
        kind: 'carried_over',
        stepId: 'step-1',
        partId: 'side-panel',
        sourceRefs: cited,
    }
    return session
}

function extraction(session: ManualSession): unknown {
    return {
        parts: session.parts,
        steps: session.reviewedSteps.map((step) => ({ ...step, correction: null })),
        unknowns: [],
    }
}

describe('carried quantities (synthetic contracts)', () => {
    it('accepts a copied prior same-part quantity in extraction and stored manuals', () => {
        const session = carriedSession()
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        expect(parsedManualSchema.safeParse(extraction(session)).success).toBe(true)
        expect(unresolvedCriticalFacts(session)).toEqual([])
    })

    it('accepts a complete descending chain without changing legacy manual values', () => {
        const session = carriedSession()
        const previous = session.reviewedSteps[1]!
        session.reviewedSteps.push({ ...structuredClone(previous), stepId: 'step-3', order: 3 })
        session.reviewedSteps[2]!.parts[0]!.quantityBasis!.stepId = 'step-2'
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        expect(parsedManualSchema.safeParse(extraction(session)).success).toBe(true)
        expect(unresolvedCriticalFacts(session)).toEqual([])
        const legacy = createDemoManual()
        expect(manualSessionSchema.parse(legacy)).toEqual(legacy)
        legacy.reviewedSteps[0]!.parts[0]!.quantityBasis = null
        expect(manualSessionSchema.parse(legacy)).toEqual(legacy)
    })

    const cases: { label: string; change: (session: ManualSession) => void }[] = [
        {
            label: 'same step',
            change: (s): void => {
                s.reviewedSteps[1]!.parts[0]!.quantityBasis!.stepId = 'step-2'
            },
        },
        {
            label: 'forward step',
            change: (s): void => {
                s.reviewedSteps[0]!.order = 3
            },
        },
        {
            label: 'missing step',
            change: (s): void => {
                s.reviewedSteps[1]!.parts[0]!.quantityBasis!.stepId = 'absent'
            },
        },
        {
            label: 'different basis part',
            change: (s): void => {
                s.reviewedSteps[1]!.parts[0]!.quantityBasis!.partId = 'divider'
            },
        },
        {
            label: 'target missing same part',
            change: (s): void => {
                s.reviewedSteps[0]!.parts[0]!.partId = 'divider'
            },
        },
        {
            label: 'unknown target',
            change: (s): void => {
                s.reviewedSteps[0]!.parts[0]!.quantity = unknown
            },
        },
        {
            label: 'unknown current quantity',
            change: (s): void => {
                s.reviewedSteps[1]!.parts[0]!.quantity = unknown
            },
        },
        {
            label: 'missing numeric value',
            change: (s): void => {
                Reflect.deleteProperty(s.reviewedSteps[1]!.parts[0]!.quantity, 'value')
            },
        },
        {
            label: 'contradictory quantity',
            change: (s): void => {
                s.reviewedSteps[1]!.parts[0]!.quantity = { state: 'known', value: 2, sourceRefs: cited }
            },
        },
        {
            label: 'missing current citation',
            change: (s): void => {
                s.reviewedSteps[1]!.parts[0]!.quantity = { state: 'known', value: 1, sourceRefs: [] }
            },
        },
        {
            label: 'missing basis citation',
            change: (s): void => {
                s.reviewedSteps[1]!.parts[0]!.quantityBasis!.sourceRefs = []
            },
        },
        {
            label: 'missing reference',
            change: (s): void => {
                delete s.reviewedSteps[1]!.parts[0]!.quantityBasis!.stepId
            },
        },
    ]
    it.each(cases)('rejects $label in extraction, storage and the factual gate', ({ change }) => {
        const session = carriedSession()
        change(session)
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
        expect(parsedManualSchema.safeParse(extraction(session)).success).toBe(false)
        expect(unresolvedCriticalFacts(session).some((issue) => issue.includes('quantity'))).toBe(true)
    })

    it('rejects ambiguous target part identity even when both counts happen to match', () => {
        const session = carriedSession()
        session.reviewedSteps[0]!.parts.push(structuredClone(session.reviewedSteps[0]!.parts[0]!))
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
        expect(parsedManualSchema.safeParse(extraction(session)).success).toBe(false)
        expect(unresolvedCriticalFacts(session).some((issue) => issue.includes('quantity'))).toBe(true)
    })

    it('rejects a cycle and propagates an invalid earlier link through the whole chain', () => {
        const session = carriedSession()
        session.reviewedSteps[0]!.parts[0]!.quantityBasis = {
            kind: 'carried_over',
            stepId: 'step-2',
            partId: 'side-panel',
            sourceRefs: cited,
        }
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
        expect(parsedManualSchema.safeParse(extraction(session)).success).toBe(false)
        expect(unresolvedCriticalFacts(session).filter((issue) => issue.includes('quantity'))).toHaveLength(2)
    })

    it.each(['user_supplied', 'not_specified'] as const)('rejects non-carry references for %s', (kind) => {
        const session = carriedSession()
        session.reviewedSteps[1]!.parts[0]!.quantity = unknown
        session.reviewedSteps[1]!.parts[0]!.quantityBasis!.kind = kind
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
        expect(unresolvedCriticalFacts(session).some((issue) => issue.includes('quantity'))).toBe(true)
    })

    it('keeps an unknown supplied count without basis blocked and cited capacity-only text nonblocking', () => {
        const session = createDemoManual()
        session.reviewedSteps[0]!.parts[0]!.quantity = unknown
        expect(unresolvedCriticalFacts(session).some((issue) => issue.includes('quantity'))).toBe(true)
        session.reviewedSteps[0]!.parts[0]!.quantityBasis = { kind: 'not_specified', sourceRefs: cited }
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        expect(unresolvedCriticalFacts(session)).toEqual([])
        expect(session.reviewedSteps[0]!.parts[0]!.quantity).toEqual(unknown)
    })

    it('includes earlier quantity anchors in compact selection and enforces them in metadata', () => {
        const session = carriedSession()
        session.pages.push({ ...session.pages[0]!, pageId: 'earlier-page', assetId: 'earlier-asset' })
        session.reviewedSteps[0]!.parts[0]!.quantity = {
            state: 'known',
            value: 1,
            sourceRefs: [{ pageId: 'earlier-page', region: null }],
        }
        const stepId = 'step-2'
        expect(selectCompactStepSourcePageIds(session, stepId)).toEqual(['demo-page-1', 'earlier-page'])
        const metadata = {
            mode: 'model',
            requestId: 'check-carry',
            binding: {
                kind: 'capture',
                manualId: session.manualId,
                revision: session.revision,
                stepId,
                captureId: 'c',
            },
            session,
            sourcePageIds: ['demo-page-1'],
            observation: { width: 1, height: 1, mimeType: 'image/png' },
        }
        expect(modelCheckMetadataSchema.safeParse(metadata).success).toBe(false)
        expect(
            modelCheckMetadataSchema.safeParse({ ...metadata, sourcePageIds: ['demo-page-1', 'earlier-page'] }).success,
        ).toBe(true)
        session.pages = session.pages.slice(0, 1)
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
    })

    it('fails compact selection closed when the complete carry chain needs three pages', () => {
        const session = carriedSession()
        const previous = session.reviewedSteps[1]!
        session.reviewedSteps.push({ ...structuredClone(previous), stepId: 'step-3', order: 3 })
        session.reviewedSteps[2]!.parts[0]!.quantityBasis!.stepId = 'step-2'
        for (let index = 0; index < 2; index++) {
            const pageId = `anchor-${index}`
            session.pages.push({ ...session.pages[0]!, pageId, assetId: `asset-${index}` })
            session.reviewedSteps[index]!.parts[0]!.quantity = {
                state: 'known',
                value: 1,
                sourceRefs: [{ pageId, region: null }],
            }
        }
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        expect(selectCompactStepSourcePageIds(session, 'step-3')).toBeNull()
    })
})

it('admits eight parse pages with a static plain-language split instruction', () => {
    expect(MAX_PARSE_PAGES).toBe(8)
    expect(PARSE_SPLIT_MESSAGE).toBe(
        'Read up to 8 pages at a time. Split this manual into sections of 8 pages or fewer.',
    )
})
