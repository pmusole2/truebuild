import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
    assembleDocumentV2,
    canonicalJson,
    documentMaterialV2,
    recordedDocumentFactsV2,
    recordedProvenanceV2Schema,
    syntheticAuthorV2Schema,
    syntheticDocumentFactsV2,
    screenContextJsonV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
    type ScreenProposalV2,
} from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { buildDocumentContext, sha256 } from './context'
import { evaluateProposal } from './ground'

/**
 * Recorded generations ship as data in the app, where the server gate cannot run. Whatever is there must pass the same
 * full gate a live model answer passes (structure, mandatory witnesses, interface copy, label and intent allow-lists)
 * for the context it was recorded for, and the published document next to it must be exactly what the contracts compute
 * from its proposal, provenance and inputs (no hand edit, no invented timing or usage).
 *
 * Layout per recording `<id>`: `<id>.inputs.json` (the context), `<id>.proposal.json` (what the model returned),
 * `<id>.provenance.json` (who authored it and when) and `<id>.json` (the published document). The first recording
 * predates this layout: a published document with a sidecar, and no inputs file.
 */
const RECORDED = new URL('../../../../app/src/features/documents/recorded/', import.meta.url)
const read = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(name, RECORDED)), 'utf8'))
const names = readdirSync(RECORDED)
const isSidecar = (name: string): boolean => /\.(inputs|proposal|provenance|runtime)\.json$/u.test(name)

/** The manual-free context of the pre-layout recording (what the app builds from `homeUiState([])`). */
const LEGACY_HOME: ScreenContextInputsV2 = {
    kind: 'home',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    uiState: { library: { entries: [], soleManualId: null } },
}

const proposalOf = (document: Record<string, unknown>): ScreenProposalV2 =>
    screenProposalV2Schema.parse({
        header: document.header,
        body: document.body,
        bar: document.bar,
        overlays: document.overlays,
        states: document.states,
    })

const layout = names
    .filter((name) => name.endsWith('.proposal.json'))
    .map((name) => name.replace(/\.proposal\.json$/u, ''))
const legacy = names
    .filter((name) => name.endsWith('.json') && !isSidecar(name))
    .map((name) => name.replace(/\.json$/u, ''))
    .filter((id) => !layout.includes(id))

describe('recorded generations in the app', () => {
    it('has recordings to check', () => {
        expect(layout.length + legacy.length).toBeGreaterThan(0)
    })

    describe.each(layout)('%s', (id) => {
        const inputs = read(`${id}.inputs.json`) as ScreenContextInputsV2
        const proposal = screenProposalV2Schema.parse(read(`${id}.proposal.json`))
        const sidecar = read(`${id}.provenance.json`) as Record<string, unknown>
        const published = read(`${id}.json`) as Record<string, unknown>
        const provenance =
            sidecar.evidence === 'synthetic-fixture'
                ? null
                : recordedProvenanceV2Schema.parse({
                      fixtureId: sidecar.fixtureId,
                      model: sidecar.model,
                      effort: sidecar.effort,
                      recordedAt: sidecar.recordedAt,
                      promptVersion: sidecar.promptVersion,
                      repaired: sidecar.repaired,
                  })
        const about =
            provenance === null
                ? syntheticDocumentFactsV2(syntheticAuthorV2Schema.parse(sidecar.authoring))
                : recordedDocumentFactsV2(provenance)

        it('has a proposal the full model gate accepts unchanged for its own inputs', () => {
            const result = evaluateProposal(proposal, buildDocumentContext(inputs))
            expect(result.ok, result.ok ? '' : result.issues.join('\n')).toBe(true)
        })

        it('is published exactly as the contracts compute it from proposal, provenance and inputs', () => {
            const document = assembleDocumentV2(documentMaterialV2(inputs), proposal, about, {
                sha256Hex: sha256,
                now: () => new Date('2031-01-01T00:00:00.000Z'),
            })
            expect(canonicalJson(published)).toBe(canonicalJson(document))
            expect(screenDocumentV2Schema.safeParse(published).success).toBe(true)
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256)).toEqual([])
            expect(document.bound.contextKey).toBe(sha256(screenContextJsonV2(inputs)))
        })

        it('keeps the authoring run’s identity and claims no timing, usage or cost', () => {
            expect(published).toMatchObject({
                metadata: {
                    source: 'generated',
                    evidence: provenance === null ? 'synthetic-fixture' : 'recorded-generation',
                    ...(provenance === null ? { authoring: about.authoring } : { fixtureId: provenance.fixtureId }),
                    model: provenance?.model ?? null,
                    effort: provenance?.effort ?? null,
                    generatedAt: provenance?.recordedAt ?? about.generatedAt,
                    cacheHit: false,
                    fallbackReason: null,
                },
            })
            const metadata = (published as { metadata: { timing: object; usage: object } }).metadata
            expect(Object.values(metadata.timing).filter((value) => value !== null)).toEqual([])
            expect(Object.values(metadata.usage).filter((value) => value !== null)).toEqual([])
            expect(sidecar.tokens ?? null).toBeNull()
            expect(sidecar.timingMs ?? null).toBeNull()
        })
    })

    describe.each(legacy)('%s (published-document form, before the layout)', (id) => {
        const published = read(`${id}.json`) as Record<string, unknown> & { bound: { contextKey: string } }

        it('is bound to the manual-free context it was authored for', () => {
            expect(published.bound.contextKey).toBe(sha256(screenContextJsonV2(LEGACY_HOME)))
        })

        it('has a proposal the full model gate accepts unchanged', () => {
            const result = evaluateProposal(proposalOf(published), buildDocumentContext(LEGACY_HOME))
            expect(result.ok, result.ok ? '' : result.issues.join('\n')).toBe(true)
        })
    })
})
