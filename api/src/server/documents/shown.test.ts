import {
    assembleDocumentV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    documentMaterialV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { documentInputs } from '../../test-support/document-inputs'
import { sha256 } from './context'
import { issueShownV2 } from './shown'

const deps = { sha256Hex: sha256, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

function documentOf(source: 'generated' | 'fallback'): ScreenDocumentV2 {
    const inputs = documentInputs('guide')
    if (source === 'fallback') {
        return buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })
    }
    const material = documentMaterialV2(inputs)
    return assembleDocumentV2(
        material,
        buildFallbackProposalV2(material),
        { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
        deps,
    )
}

describe('the projection of an issued page takes every origin from the published document', () => {
    it.each(['generated', 'fallback'] as const)('attributes each block of a %s document to that origin', (source) => {
        const shown = issueShownV2(documentOf(source))
        expect(shown.blocks.length).toBeGreaterThan(1)
        expect(new Set(shown.blocks.map((block) => block.origin))).toEqual(new Set([source]))
    })

    it('has no default: a component without an origin is an error, never read as fallback', () => {
        const document = documentOf('generated')
        const { ['body.0']: _dropped, ...rest } = document.metadata.origins
        expect(() => issueShownV2({ ...document, metadata: { ...document.metadata, origins: rest } })).toThrow(
            'missing_origin:body.0',
        )
    })
})
