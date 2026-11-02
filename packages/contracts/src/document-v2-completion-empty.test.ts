import { createHash } from 'node:crypto'

import { expect, it } from 'vitest'

import { buildFallbackDocumentV2, visitVariantNodesV2, type ScreenNodeV2 } from './index'

it('does not claim a manual or completed build in a sessionless completion document', () => {
    const document = buildFallbackDocumentV2(
        {
            kind: 'completion',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { library: { entries: [], soleManualId: null } },
        },
        {
            sha256Hex: (text: string): string => createHash('sha256').update(text).digest('hex'),
            reason: 'disabled',
            evidence: 'local-deterministic',
            now: (): Date => new Date('2026-10-30T00:00:00.000Z'),
        },
    )
    const nodes: ScreenNodeV2[] = []
    visitVariantNodesV2(document, '', ({ node }) => nodes.push(node))
    expect(document.header.title).toEqual({ kind: 'literal', text: 'Your build' })
    expect(document.header.subtitle).toBeNull()
    expect(nodes).not.toContainEqual(
        expect.objectContaining({ type: 'Text', content: { kind: 'bound', key: 'manual-title' } }),
    )
    expect(JSON.stringify(document.body)).not.toContain('Find your manual on Home.')
    expect(nodes.filter((node) => node.type === 'Progress')).toHaveLength(0)
    expect(nodes.filter((node) => node.type === 'Meter')).toHaveLength(0)
})
