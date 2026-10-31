import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
    assembleDocumentV2,
    canonicalJson,
    documentMaterialV2,
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
 * Compiled document files are private build outputs. Tests compare source assembly with neutral fixture metadata and retained integrity pins.
 */
const RECORDED = new URL('../../../../app/src/features/documents/recorded/', import.meta.url)
const read = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(name, RECORDED)), 'utf8'))
const names = readdirSync(RECORDED)
// Canonical publication oracles. Historical originals, intentional revisions and new families retain separate archives.
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
    'recorded-reading-notice',
    'recorded-reading-active',
    'recorded-home-saving',
    'recorded-home-library-single-saving',
    'recorded-home-library-multiple-saving',
    'recorded-add-empty-saving',
    'recorded-pages-saving',
    'recorded-pages-cancelled-saving',
    'recorded-reading-saving',
    'recorded-more-global',
    'recorded-judge-global',
    'recorded-camera-page',
    'recorded-camera-page-saving',
    'recorded-camera-page-allow',
    'recorded-camera-page-allow-saving',
    'recorded-camera-page-settings',
    'recorded-camera-page-settings-saving',
    'recorded-camera-page-retry',
    'recorded-camera-page-retry-saving',
].sort()

describe('recorded generations in the app', () => {
    it('checks all twenty-six expected raw source families', () => {
        expect(layout).toEqual(EXPECTED_FAMILIES)
        expect(layout).toHaveLength(26)
        expect(Object.keys(publicationHashes).sort()).toEqual(EXPECTED_FAMILIES)
    })

    describe.each(layout)('%s', (id) => {
        const inputs = read(`${id}.inputs.json`) as ScreenContextInputsV2
        const rawProposal = read(`${id}.proposal.json`)
        const proposal = screenProposalV2Schema.parse(rawProposal)
        const sidecar = read(`${id}.provenance.json`) as Record<string, unknown>
        const published = recordedDocumentForTest(id)
        const runtime = read(`${id}.runtime.json`) as Record<string, unknown>
        const authoring = syntheticAuthorV2Schema.parse(runtime.authoring)
        const about = syntheticDocumentFactsV2(authoring)

        it('has a proposal the full model gate accepts unchanged for its own inputs', () => {
            const result = evaluateProposal(proposal, buildDocumentContext(inputs))
            expect(result.ok, result.ok ? '' : result.issues.join('\n')).toBe(true)
        })

        it('is published exactly as the contracts compute it from proposal, fixture metadata and inputs', () => {
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

        it('keeps the fixture identity and claims no provider model, timing, usage or cost', () => {
            expect(published).toMatchObject({
                metadata: {
                    source: 'generated',
                    evidence: 'synthetic-fixture',
                    authoring,
                    model: null,
                    effort: null,
                    generatedAt: authoring.recordedAt,
                    cacheHit: false,
                    fallbackReason: null,
                },
            })
            const metadata = (published as { metadata: { timing: object; usage: object } }).metadata
            expect(Object.values(metadata.timing).filter((value) => value !== null)).toEqual([])
            expect(Object.values(metadata.usage).filter((value) => value !== null)).toEqual([])
            expect(sidecar).toEqual({
                fixtureId: authoring.fixtureId,
                schemaVersion: 1,
                description: expect.any(String),
            })
            expect(runtime.evidence).toBe('synthetic-fixture')
            expect(runtime.model).toBeNull()
            expect(runtime.effort).toBeNull()
            expect(runtime.rawJsonSha256).toBe(
                sha256(readFileSync(fileURLToPath(new URL(`${id}.proposal.json`, RECORDED)), 'utf8')),
            )
            expect(runtime.proposalSha256).toBe(sha256(canonicalJson(rawProposal)))
        })
    })
})
