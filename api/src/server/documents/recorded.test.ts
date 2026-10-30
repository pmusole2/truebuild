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
} from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { buildDocumentContext, sha256 } from './context'
import { evaluateProposal } from './ground'
import { recordedDocumentForTest } from '../../../../app/src/features/documents/recorded/test-support'

/** Every raw source family must pass the real model gate and publish unchanged through runtime metadata.
 * Compiled document files are private build outputs. Tests independently compare source assembly with full provenance.
 */
const RECORDED = new URL('../../../../app/src/features/documents/recorded/', import.meta.url)
const read = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(name, RECORDED)), 'utf8'))
const names = readdirSync(RECORDED)
// Canonical digests of the exact pre-packaging publications, preserved before removal of unused build artifacts.
const publicationHashes = read('publication-hashes.json') as Record<string, string>
const layout = names
    .filter((name) => name.endsWith('.proposal.json'))
    .map((name) => name.replace(/\.proposal\.json$/u, ''))
    .sort()
const EXPECTED_FAMILIES = [
    'recorded-home',
    'recorded-home-library-single',
    'recorded-home-library-multiple',
    'recorded-add-empty',
    'recorded-pages',
    'recorded-pages-cancelled',
    'recorded-reading',
    'recorded-reading-active',
    'recorded-home-saving',
    'recorded-home-library-single-saving',
    'recorded-home-library-multiple-saving',
    'recorded-add-empty-saving',
    'recorded-pages-saving',
    'recorded-pages-cancelled-saving',
    'recorded-reading-saving',
].sort()

describe('recorded generations in the app', () => {
    it('checks all fifteen expected raw source families', () => {
        expect(layout).toEqual(EXPECTED_FAMILIES)
        expect(layout).toHaveLength(15)
        expect(Object.keys(publicationHashes).sort()).toEqual(EXPECTED_FAMILIES)
    })

    describe.each(layout)('%s', (id) => {
        const inputs = read(`${id}.inputs.json`) as ScreenContextInputsV2
        const rawProposal = read(`${id}.proposal.json`)
        const proposal = screenProposalV2Schema.parse(rawProposal)
        const sidecar = read(`${id}.provenance.json`) as Record<string, unknown>
        const published = recordedDocumentForTest(id)
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
            // The authored source is the independent layout oracle, even if both publication paths share assembly.
            expect(
                canonicalJson({
                    header: published.header,
                    body: published.body,
                    bar: published.bar,
                    overlays: published.overlays,
                    states: published.states,
                }),
            ).toBe(canonicalJson(rawProposal))
            expect(sha256(canonicalJson(published))).toBe(publicationHashes[id])
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
})
