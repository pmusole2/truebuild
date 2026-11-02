import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    documentMaterialV2,
    screenDocumentV2Schema,
    syntheticAuthorV2Schema,
    syntheticDocumentFactsV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    buildFallbackDocumentV2,
    rebindGeneratedStatesV2,
    carriedStateIssuesV2,
    verifyDocumentAgainstInputsV2,
} from './index'

const author = {
    model: 'Test fixture',
    effort: 'ultra',
    recordedAt: '2026-10-30T08:00:00.000Z',
    fixtureId: 'test-author-v1',
} as const
const inputs: ScreenContextInputsV2 = {
    kind: 'home',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    uiState: { library: { entries: [], soleManualId: null } },
}
const deps = {
    sha256Hex: (s: string): string => createHash('sha256').update(s).digest('hex'),
    now: (): Date => new Date(),
}
const make = (): ScreenDocumentV2 =>
    assembleDocumentV2(
        documentMaterialV2(inputs),
        buildFallbackProposalV2(documentMaterialV2(inputs)),
        syntheticDocumentFactsV2(author),
        deps,
    )

describe('synthetic author provenance is separate from provider inference', () => {
    it('rejects mismatched action wording through the same semantic gate used by the server', () => {
        const document = make()
        expect(document.header.actions).not.toHaveLength(0)
        document.header.actions[0]!.label = 'Add a manual'
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, deps.sha256Hex)).toContain('label_not_listed')
    })
    it.each(['forged', 'dropped'])('audits %s carried authoring identity against the actual donor', (change) => {
        const donor = make()
        const target = buildFallbackDocumentV2(inputs, { ...deps, reason: 'timeout', evidence: 'local-deterministic' })
        const { document, carried } = rebindGeneratedStatesV2(inputs, target, [donor], deps)
        expect(carried).toContain('pending')
        const altered = structuredClone(document)
        const claim = altered.metadata.carried!.pending!
        if (change === 'forged') claim.authoring!.fixtureId = 'forged-identity-v1'
        else delete claim.authoring
        expect(screenDocumentV2Schema.safeParse(altered).success).toBe(true)
        expect(carriedStateIssuesV2(altered, [donor])).toContain('carried:pending:provenance_differs')
    })
    it('keeps the actual author without crediting a Meta provider call', () => {
        const doc = screenDocumentV2Schema.parse(make())
        expect(doc.metadata).toMatchObject({
            evidence: 'synthetic-fixture',
            authoring: author,
            model: null,
            effort: null,
            generatedAt: author.recordedAt,
        })
        expect(Object.values(doc.metadata.timing).every((value) => value === null)).toBe(true)
        expect(Object.values(doc.metadata.usage).every((value) => value === null)).toBe(true)
    })
    it.each(['live', 'recorded-generation', 'local-deterministic'])(
        'rejects authoring attribution on %s evidence',
        (evidence) => {
            const doc = make()
            expect(screenDocumentV2Schema.safeParse({ ...doc, metadata: { ...doc.metadata, evidence } }).success).toBe(
                false,
            )
        },
    )
    it.each([
        { model: 'muse-wonder-1.0' },
        { effort: 'max' },
        { recordedAt: 'yesterday' },
        { fixtureId: 'arbitrary/path' },
        { tokens: 42 },
    ])('rejects unsupported author claims %j', (claim) => {
        expect(syntheticAuthorV2Schema.safeParse({ ...author, ...claim }).success).toBe(false)
    })
    it('does not allow a synthetic author to claim provider usage', () => {
        const doc = make()
        expect(
            screenDocumentV2Schema.safeParse({
                ...doc,
                metadata: { ...doc.metadata, usage: { ...doc.metadata.usage, outputTokens: 5 } },
            }).success,
        ).toBe(false)
    })
})
