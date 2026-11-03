import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    BUSY_ACTIVITIES_V2,
    waitCopyV2,
    canonicalJson,
    compileLayoutTemplateV2,
    componentPathsV2,
    documentMaterialV2,
    manualSessionSchema,
    variantsOfV2,
    verdictCardFactIdsV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    variantRequirementsV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import result from '../documents/recorded-layouts/recorded-result-layout-sol-v1.template.json'
import resultRuntime from '../documents/recorded-layouts/recorded-result-layout-sol-v1.runtime.json'
import resultProvenance from '../documents/recorded-layouts/recorded-result-layout-sol-v1.provenance.json'
import answer from '../documents/recorded-layouts/recorded-answer-layout-sol-v1.template.json'
import answerRuntime from '../documents/recorded-layouts/recorded-answer-layout-sol-v1.runtime.json'
import answerProvenance from '../documents/recorded-layouts/recorded-answer-layout-sol-v1.provenance.json'
import layoutHashes from '../documents/recorded-layouts/publication-hashes.json'
import { sha256Hex } from '../documents/sha256'
import { recordedDocument } from './recorded-runtime'
import { resultLayoutDocument } from './result-layout-runtime'
import { answerContext, checkContext, largeContext, pendingCheckContext } from './test-support/result-layout-inputs'

const deps = { sha256Hex, now: (): Date => new Date('2030-01-01T00:00:00.000Z') }
const compile = (
    inputs: ScreenContextInputsV2,
    template: unknown = result,
    provenance: unknown = resultRuntime,
): ReturnType<typeof compileLayoutTemplateV2> => compileLayoutTemplateV2({ inputs, template, provenance, deps })
function nodesOf(document: NonNullable<ReturnType<typeof resultLayoutDocument>>, state = 'ready'): ScreenNodeV2[] {
    const nodes: ScreenNodeV2[] = []
    const selected = variantsOfV2(document).find((entry) => entry.name === state)!
    visitVariantNodesV2(selected.variant, selected.prefix, ({ node }) => nodes.push(node))
    return nodes
}

describe('authored current-result layout records', () => {
    it.each(['correct', 'reversed', 'uncertain'] as const)(
        'immediately composes the actual %s check without a prior document',
        (orientation) => {
            const document = recordedDocument(checkContext(orientation))
            expect(document?.metadata.source).toBe('generated')
            expect(document?.metadata.authoring?.model).toBe('Test fixture')
        },
    )
    it('immediately composes a held current answer without a prior document', () => {
        expect(recordedDocument(answerContext())?.metadata.source).toBe('generated')
    })

    it('the authored checking branch carries the actual held frame and manual facts without any result claim', () => {
        const inputs = pendingCheckContext()
        const document = resultLayoutDocument(inputs)!
        expect(document.metadata.source).toBe('generated')
        expect(document.bound.captureId).toBe(inputs.captureId)
        expect(document.facts).toEqual(documentMaterialV2(inputs).facts)
        expect(document.facts.some((fact) => fact.basis === 'result')).toBe(false)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        for (const variant of variantsOfV2(document)) {
            const nodes = nodesOf(document, variant.name)
            expect(nodes.some((node) => node.type === 'Image' && node.source.kind === 'capture')).toBe(true)
            expect(nodes.some((node) => node.type === 'VerdictCard')).toBe(false)
        }
    })

    it.each([
        ['result', result, resultRuntime, resultProvenance],
        ['answer', answer, answerRuntime, answerProvenance],
    ] as const)(
        'binds the %s raw bytes, canonical record, fixture identity and minimal metadata to their integrity pins',
        (kind, template, runtime, full) => {
            const raw = readFileSync(
                new URL(`../documents/recorded-layouts/recorded-${kind}-layout-sol-v1.template.json`, import.meta.url),
                'utf8',
            )
            const pin = Object.entries(layoutHashes).find(([id]) => id === full.fixtureId)?.[1]
            expect(pin).toBeDefined()
            expect(sha256Hex(raw)).toBe(pin!.rawSha256)
            expect(sha256Hex(canonicalJson(template))).toBe(pin!.templateSha256)
            expect(runtime.templateSha256).toBe(pin!.templateSha256)
            expect(runtime.authoring.fixtureId).toBe(full.fixtureId)
            expect(full).toEqual({
                fixtureId: runtime.authoring.fixtureId,
                schemaVersion: 1,
                description: expect.any(String),
            })
            expect(full.description).not.toMatch(/[\r\n]/u)
            expect(runtime.authoring.model).toBe('Test fixture')
            expect(JSON.stringify(template)).not.toMatch(/demo-page|current-photo|factId|sourceRefs|"kind":"fact"/u)
        },
    )

    it('retains exact current manual facts and distinct same-page citation geometry for different manuals', () => {
        const first = checkContext('reversed')
        const session = first.session!
        session.manualId = 'another-current-manual'
        session.title = 'Another actual manual'
        session.reviewedSteps[0]!.title = 'Only this instruction applies'
        session.reviewedSteps[0]!.safetyNotes = Array.from({ length: 4 }, (_, index) => ({
            noteId: `current-${index}`,
            note: {
                state: 'known',
                value: `Current safety instruction ${index}.`,
                sourceRefs: [
                    {
                        pageId: 'demo-page-1',
                        region: { x: index / 10, y: 0.1, width: 0.05, height: 0.05 },
                    },
                ],
            },
        }))
        const inputs = { ...first, session: manualSessionSchema.parse(session) }
        const compiled = compile(inputs)
        expect(compiled.ok).toBe(true)
        if (!compiled.ok) throw new Error(compiled.issues.join(','))
        const { document, lineage } = compiled
        expect(document.facts).toEqual(documentMaterialV2(inputs).facts)
        expect(document.sources).toEqual(documentMaterialV2(inputs).sources)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        expect(document.sources.filter((source) => source.region?.width === 0.05)).toHaveLength(4)
        expect(Object.keys(lineage).sort()).toEqual(componentPathsV2(document).sort())
        const safety = document.facts.filter((fact) => fact.kind === 'safety').map((fact) => fact.factId)
        for (const variant of variantsOfV2(document)) {
            const nodes = nodesOf(document, variant.name)
            const stated = nodes.flatMap((node) =>
                node.type === 'Text' && node.content.kind === 'fact' ? [node.content.factId] : [],
            )
            expect(stated).toEqual(expect.arrayContaining(safety))
            const cited = new Set(nodes.flatMap((node) => (node.type === 'Citation' ? node.sources : [])))
            for (const index of variantRequirementsV2(variant.name, document.requirements, document).sources)
                expect(cited.has(index)).toBe(true)
            expect(nodes.find((node) => node.type === 'Image')).toEqual({
                type: 'Image',
                source: { kind: 'capture' },
                fit: 'contain',
                ratio: 'hero',
                caption: null,
            })
        }
        expect(resultLayoutDocument(checkContext())?.facts).not.toEqual(document.facts)
    })

    it('handles zero and many safety/missing entries without inventing or dropping current claims', () => {
        const empty = resultLayoutDocument(checkContext())!
        expect(JSON.stringify(empty.body)).not.toContain('"Safety"')
        const inputs = checkContext('uncertain')
        inputs.session!.reviewedSteps[0]!.safetyNotes = Array.from({ length: 100 }, (_, index) => ({
            noteId: `note-${index}`,
            note: {
                state: 'known',
                value: `Keep clear of current connection ${index}.`,
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            },
        }))
        if (inputs.result?.kind !== 'check') throw new Error('check fixture')
        inputs.result.value.missingEvidence = Array.from(
            { length: 100 },
            (_, index) => `Current evidence ${index} is missing.`,
        )
        const compiled = compile(inputs)
        expect(compiled.ok).toBe(true)
        if (!compiled.ok) throw new Error(compiled.issues.join(','))
        const document = compiled.document
        expect(
            verdictCardFactIdsV2('check', document.facts).filter((id) => id.startsWith('result:missing:')),
        ).toHaveLength(100)
        expect(nodesOf(document).filter((node) => node.type === 'VerdictCard')).toHaveLength(1)
        expect(
            nodesOf(document).some(
                (node) =>
                    node.type === 'Text' &&
                    node.content.kind === 'fact' &&
                    node.content.factId.startsWith('result:missing:'),
            ),
        ).toBe(false)
        for (const variant of variantsOfV2(document)) {
            const nodes = nodesOf(document, variant.name)
            const safetyIds = new Set(
                document.facts.filter((fact) => fact.kind === 'safety').map((fact) => fact.factId),
            )
            expect(
                nodes.filter(
                    (node) =>
                        node.type === 'Text' && node.content.kind === 'fact' && safetyIds.has(node.content.factId),
                ),
            ).toHaveLength(100)
            if (variant.name !== 'ready') {
                expect(nodes.some((node) => node.type === 'VerdictCard')).toBe(false)
                expect(JSON.stringify(nodes)).not.toContain('result:missing:')
            }
        }
    })

    it.each(BUSY_ACTIVITIES_V2)(
        'uses actual %s activity copy while keeping old verdict claims out of its busy variant',
        (activity) => {
            const inputs = checkContext()
            const document = resultLayoutDocument({ ...inputs, uiState: { ...inputs.uiState, busy: { activity } } })!
            expect(document.states.busy?.header.title).toEqual({
                kind: 'literal',
                text: waitCopyV2('result', activity).heading,
            })
            expect(nodesOf(document, 'busy').some((node) => node.type === 'VerdictCard')).toBe(false)
        },
    )

    it('rejects changed record content, author identity and unsupported current input without a fabricated failure', () => {
        expect(compile(checkContext(), { ...result, fixtureId: 'tampered' }).ok).toBe(false)
        expect(compile(checkContext(), result, { ...resultRuntime, templateSha256: '0'.repeat(64) }).ok).toBe(false)
        expect(
            compile(checkContext(), result, {
                ...resultRuntime,
                authoring: { ...resultRuntime.authoring, fixtureId: 'tampered' },
            }).ok,
        ).toBe(false)
        expect(resultLayoutDocument({ ...checkContext(), captureId: null })).toBeNull()
        expect(resultLayoutDocument({ ...checkContext(), kind: 'guide', captureId: null, result: null })).toBeNull()
    })

    it('fits large current material with grouped safety and a single missing-evidence renderer', () => {
        const inputs = largeContext()
        const result = compile(inputs)
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error(result.issues.join(','))
        expect(verifyDocumentAgainstInputsV2(result.document, inputs, sha256Hex)).toEqual([])
        expect(result.document.facts).toEqual(documentMaterialV2(inputs).facts)
    })

    it('groups dense repeated current source geometry without losing a required source or region', () => {
        const inputs = largeContext(true)
        expect(manualSessionSchema.safeParse(inputs.session).success).toBe(true)
        const result = compile(inputs)
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error(result.issues.join(','))
        expect(result.document.sources).toEqual(documentMaterialV2(inputs).sources)
        expect(result.document.facts).toEqual(documentMaterialV2(inputs).facts)
        expect(verifyDocumentAgainstInputsV2(result.document, inputs, sha256Hex)).toEqual([])
    })
})
