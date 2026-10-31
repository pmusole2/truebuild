import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    canonicalJson,
    documentMaterialV2,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import template from '../documents/recorded-layouts/recorded-question-layout-sol-v1.template.json'
import runtime from '../documents/recorded-layouts/recorded-question-layout-sol-v1.runtime.json'
import full from '../documents/recorded-layouts/recorded-question-layout-sol-v1.provenance.json'
import layoutHashes from '../documents/recorded-layouts/publication-hashes.json'
import { sha256Hex } from '../documents/sha256'
import { questionLayoutDocument } from './question-layout-runtime'
import { recordedDocument } from './recorded-runtime'
import { checkContext } from './test-support/result-layout-inputs'

const inputs = (): ScreenContextInputsV2 => ({ ...checkContext(), kind: 'questions', result: null })

describe('the shipped current-Question layout record', () => {
    it('binds the raw record and minimal runtime data to the retained author attestation', () => {
        const raw = readFileSync(
            new URL('../documents/recorded-layouts/recorded-question-layout-sol-v1.template.json', import.meta.url),
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
    })

    it.each([null, 'asking', 'question-waiting'] as const)(
        'binds the actual %s context with a photo in every variant and no provider receipt',
        (activity) => {
            const current = inputs()
            current.uiState = { ...current.uiState, busy: activity === null ? null : { activity } }
            const document = recordedDocument(current)!
            expect(document.metadata).toMatchObject({
                source: 'generated',
                evidence: 'synthetic-fixture',
                authoring: runtime.authoring,
                model: null,
                effort: null,
            })
            expect(Object.values(document.metadata.timing).every((value) => value === null)).toBe(true)
            expect(Object.values(document.metadata.usage).every((value) => value === null)).toBe(true)
            expect(document.bound.captureId).toBe(current.captureId)
            expect(verifyDocumentAgainstInputsV2(document, current, sha256Hex)).toEqual([])
            expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['generated']))
            expect(variantsOfV2(document).map((variant) => variant.name)).toEqual([
                'ready',
                'busy',
                'pending',
                'empty',
                'error',
                'recovery',
            ])
            for (const { variant, prefix } of variantsOfV2(document)) {
                const photos: string[] = []
                visitVariantNodesV2(variant, prefix, ({ node, path }) => {
                    if (node.type === 'Image' && node.source.kind === 'capture') photos.push(path.slice(prefix.length))
                    expect(node.type).not.toBe('VerdictCard')
                })
                expect(photos).toEqual(['body.0.0'])
            }
            expect(canonicalJson(questionLayoutDocument(current))).toBe(canonicalJson(document))
        },
    )

    it('keeps current mandatory safety, geometry and form placement when another manual is bound', () => {
        const current = inputs()
        current.session!.manualId = 'another-question-manual'
        current.session!.title = 'Another current manual'
        current.session!.reviewedSteps[0]!.safetyNotes = Array.from({ length: 100 }, (_, index) => ({
            noteId: `current-note-${index}`,
            note: {
                state: 'known',
                value: `Keep clear of current connection ${index}.`,
                sourceRefs: [
                    {
                        pageId: 'demo-page-1',
                        region: { x: index / 200, y: 0.1, width: 0.004, height: 0.004 },
                    },
                ],
            },
        }))
        const document = questionLayoutDocument(current)!
        expect(document).not.toBeNull()
        expect(document.bound.manualId).toBe(current.session!.manualId)
        expect(document.facts).toEqual(documentMaterialV2(current).facts)
        expect(document.sources).toEqual(documentMaterialV2(current).sources)
        expect(verifyDocumentAgainstInputsV2(document, current, sha256Hex)).toEqual([])
        for (const { variant, prefix } of variantsOfV2(document)) {
            const nodes: ScreenNodeV2[] = []
            visitVariantNodesV2(variant, prefix, ({ node }) => nodes.push(node))
            const stated = new Set(
                nodes.flatMap((node) =>
                    node.type === 'Text' && node.content.kind === 'fact' ? [node.content.factId] : [],
                ),
            )
            expect(document.requirements.facts.every((id) => stated.has(id))).toBe(true)
        }
    })

    it.each([
        [
            'no held photo',
            (current: ScreenContextInputsV2): void => {
                current.uiState = { capture: null }
            },
        ],
        [
            'unusable photo',
            (current: ScreenContextInputsV2): void => {
                current.uiState!.capture!.reusable = false
            },
        ],
        [
            'wrong capture',
            (current: ScreenContextInputsV2): void => {
                current.captureId = 'another-capture'
            },
        ],
        [
            'no named capture',
            (current: ScreenContextInputsV2): void => {
                current.captureId = null
            },
        ],
        [
            'no step',
            (current: ScreenContextInputsV2): void => {
                current.stepId = null
            },
        ],
        [
            'unreviewed manual',
            (current: ScreenContextInputsV2): void => {
                current.session!.reviewStatus = 'unreviewed'
            },
        ],
        [
            'another kind',
            (current: ScreenContextInputsV2): void => {
                current.kind = 'guide'
            },
        ],
        [
            'a check result',
            (current: ScreenContextInputsV2): void => {
                current.result = checkContext().result
            },
        ],
    ] as const)('does not invent an authored Question for %s', (_name, edit) => {
        const current = inputs()
        edit(current)
        expect(questionLayoutDocument(current)).toBeNull()
    })
})
