import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    documentMaterialV2,
    recordedDocumentFactsV2,
    recordedProvenanceV2Schema,
    screenDocumentV2Schema,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
} from './index'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2031-01-01T00:00:00.000Z') }

/** The first-launch Home: no manual, an empty library (what `homeUiState([])` builds in the app). */
const FIRST_LAUNCH_HOME: ScreenContextInputsV2 = {
    kind: 'home',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    uiState: { library: { entries: [], soleManualId: null } },
}

/**
 * Synthetic, unit-test-only provenance. It exists to exercise the mechanics and is never exported or shipped; real
 * records carry the provenance of the run that actually authored them (see the sidecar next to each recording).
 */
const PROVENANCE = {
    fixtureId: 'unit-test-only-home',
    model: 'muse-wonder-1.0',
    effort: 'max',
    recordedAt: '2026-10-30T06:06:51Z',
    promptVersion: 0,
    repaired: false,
} as const

function published(provenance: unknown = PROVENANCE): ScreenDocumentV2 {
    const material = documentMaterialV2(FIRST_LAUNCH_HOME)
    return assembleDocumentV2(
        material,
        buildFallbackProposalV2(material),
        recordedDocumentFactsV2(recordedProvenanceV2Schema.parse(provenance)),
        deps,
    )
}
const issues = (document: unknown): string => {
    const parsed = screenDocumentV2Schema.safeParse(document)
    return parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join(' | ')
}
const edit = (change: (metadata: Record<string, unknown>) => void): ScreenDocumentV2 => {
    const document = structuredClone(published()) as unknown as { metadata: Record<string, unknown> }
    change(document.metadata)
    return document as unknown as ScreenDocumentV2
}

describe('recorded provenance is a closed record of the run that really authored the proposal', () => {
    it('accepts the documented models and efforts and keeps every field it was given', () => {
        for (const model of ['muse-spark-1.3', 'muse-wonder-1.0']) {
            for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
                expect(recordedProvenanceV2Schema.parse({ ...PROVENANCE, model, effort })).toMatchObject({
                    model,
                    effort,
                })
            }
        }
        expect(recordedProvenanceV2Schema.parse(PROVENANCE)).toEqual(PROVENANCE)
    })

    it.each([
        ['an undocumented model', { model: 'muse-wonder-2.0' }],
        ['an undocumented effort', { effort: 'ultra' }],
        ['a model left out', { model: undefined }],
        ['an effort left out', { effort: undefined }],
        ['a date that is not a UTC instant', { recordedAt: 'yesterday' }],
        ['a date left out', { recordedAt: undefined }],
        ['a fixture id with a space', { fixtureId: 'recorded home' }],
        ['a fixture id with capitals', { fixtureId: 'Recorded-Home' }],
        ['a fixture id that is too short', { fixtureId: 'ab' }],
        ['whether it was repaired left out', { repaired: undefined }],
        ['a negative prompt version', { promptVersion: -1 }],
        ['timing it invented', { timing: { totalMs: 1 } }],
        ['usage it invented', { usage: { inputTokens: 1 } }],
    ])('rejects %s', (_label, patch) => {
        expect(recordedProvenanceV2Schema.safeParse({ ...PROVENANCE, ...patch }).success).toBe(false)
    })
})

describe('a recorded document preserves the actual authoring run and invents nothing', () => {
    it('publishes the model, effort, date and fixture id of the record with no timing and no usage', () => {
        const document = published()
        expect(issues(document)).toBe('')
        expect(document.metadata).toMatchObject({
            source: 'generated',
            evidence: 'recorded-generation',
            fixtureId: 'unit-test-only-home',
            model: 'muse-wonder-1.0',
            effort: 'max',
            // The recording date, never the time the document was bound.
            generatedAt: '2026-10-30T06:06:51Z',
            fallbackReason: null,
            repaired: false,
            rejectedIssues: null,
            cacheHit: false,
        })
        expect(Object.values(document.metadata.timing).filter((value) => value !== null)).toEqual([])
        expect(Object.values(document.metadata.usage).filter((value) => value !== null)).toEqual([])
        expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['generated']))
        // A request-bound client accepts it for exactly the context it was recorded for, and for no other.
        expect(verifyDocumentAgainstInputsV2(document, FIRST_LAUNCH_HOME, sha256Hex)).toEqual([])
        expect(
            verifyDocumentAgainstInputsV2(
                document,
                { ...FIRST_LAUNCH_HOME, uiState: { library: { entries: [], soleManualId: 'x' } } },
                sha256Hex,
            ),
        ).toContain('bound_mismatch')
    })

    it('keeps the record identity out of the document identity, so the same proposal keeps one screenId', () => {
        const material = documentMaterialV2(FIRST_LAUNCH_HOME)
        const proposal = buildFallbackProposalV2(material)
        const other = assembleDocumentV2(
            material,
            proposal,
            { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
            deps,
        )
        expect(published().screenId).toBe(other.screenId)
    })

    it('does not add a fixtureId to documents that are not recordings', () => {
        const material = documentMaterialV2(FIRST_LAUNCH_HOME)
        const live = assembleDocumentV2(
            material,
            buildFallbackProposalV2(material),
            { source: 'generated', evidence: 'live', fallbackReason: null, model: 'muse-spark-1.3', effort: 'low' },
            deps,
        )
        expect('fixtureId' in live.metadata).toBe(false)
    })

    it('round-trips through JSON like any document the network or a bundle carries', () => {
        expect(screenDocumentV2Schema.safeParse(JSON.parse(JSON.stringify(published()))).success).toBe(true)
    })
})

describe('the published schema refuses a recording that claims more or less than it is', () => {
    type Metadata = Record<string, unknown>
    const section = (m: Metadata, key: 'timing' | 'usage'): Metadata => m[key] as Metadata
    it.each<[string, (m: Metadata) => void, string]>([
        [
            'no model',
            (m): void => {
                m.model = null
            },
            'names its model and effort',
        ],
        [
            'no effort',
            (m): void => {
                m.effort = null
            },
            'names its model and effort',
        ],
        [
            'no fixture id',
            (m): void => {
                delete m.fixtureId
            },
            'names its fixture',
        ],
        [
            'a null fixture id',
            (m): void => {
                m.fixtureId = null
            },
            'names its fixture',
        ],
        [
            'an invented time to provider',
            (m): void => {
                section(m, 'timing').timeToProviderMs = 5
            },
            'claims no timing or usage',
        ],
        [
            'an invented total time',
            (m): void => {
                section(m, 'timing').totalMs = 900
            },
            'claims no timing or usage',
        ],
        [
            'an invented body time',
            (m): void => {
                section(m, 'timing').bodyMs = 3
            },
            'claims no timing or usage',
        ],
        [
            'invented output tokens',
            (m): void => {
                section(m, 'usage').outputTokens = 50
            },
            'claims no timing or usage',
        ],
        [
            'a cache hit',
            (m): void => {
                m.cacheHit = true
            },
            'never a cache hit',
        ],
        [
            'a fallback source',
            (m): void => {
                m.source = 'fallback'
                m.fallbackReason = 'disabled'
            },
            'never a recording',
        ],
        [
            'a fallback reason',
            (m): void => {
                m.fallbackReason = 'timeout'
            },
            'no fallback reason',
        ],
    ])('rejects a recording with %s', (_label, change, message) => {
        expect(issues(edit(change))).toContain(message)
    })

    it.each(['live', 'synthetic-fixture', 'local-deterministic'])(
        'rejects a fixture id on %s evidence: only a recording carries one',
        (evidence) => {
            const document = edit((m) => {
                m.evidence = evidence
                if (evidence === 'local-deterministic') {
                    m.source = 'fallback'
                    m.fallbackReason = 'disabled'
                    m.model = null
                    m.effort = null
                }
                if (evidence === 'synthetic-fixture') {
                    m.model = null
                    m.effort = null
                }
            })
            expect(issues(document)).toContain('Only a recording carries a fixture identity')
        },
    )

    it('still accepts the other evidence kinds exactly as before', () => {
        const material = documentMaterialV2(FIRST_LAUNCH_HOME)
        const proposal = buildFallbackProposalV2(material)
        for (const about of [
            { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
            { source: 'generated', evidence: 'live', fallbackReason: null, model: 'muse-spark-1.3', effort: 'low' },
            { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
            { source: 'fallback', evidence: 'live', fallbackReason: 'timeout' },
        ] as const) {
            expect(issues(assembleDocumentV2(material, proposal, about, deps)), JSON.stringify(about)).toBe('')
        }
    })
})
