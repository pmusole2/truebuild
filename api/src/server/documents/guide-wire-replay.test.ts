import { manualSessionSchema, screenUiStateV2Schema, type ScreenContextInputsV2 } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { wireProposalSchema } from '../../providers/document-wire'
import { buildDocumentContext } from './context'
import corpus from './fixtures/guide-wire-replay.json'
import { evaluateWire } from './ground'
import { guideQualityIssues } from './guide-quality'
import { normalizeDocumentWire } from './normalize-wire'

/** Observed responses, not replacements for a generated layout or claims of a successful live screen. */
describe('recorded sparse Guide responses', () => {
    it('preserves their surviving graph and rejects their missing instruction content through the quality floor', () => {
        const session = manualSessionSchema.parse(corpus.session)
        for (const row of corpus.cases) {
            const inputs: ScreenContextInputsV2 = {
                kind: 'guide',
                session,
                stepId: row.stepId,
                captureId: null,
                result: null,
                failure: null,
                uiState: screenUiStateV2Schema.parse(row.uiState),
                stepPieces: row.stepPieces,
            }
            const context = buildDocumentContext(inputs)
            expect(context.bound.contextKey, row.recordedResponse).toBe(row.contextHash)
            expect(row.wire.nodes).toHaveLength(row.rawNodes)
            expect(evaluateWire(row.wire, context).ok).toBe(false)
            // Neither reachability cleanup nor a duplicate-ID policy can recover content never authored by the model.
            expect(row.wire.nodes.some((node) => ['Text', 'PieceViewer', 'PiecesGrid'].includes(node.type))).toBe(false)
            const before = structuredClone(row.wire)
            const normalized = normalizeDocumentWire(row.wire, context)
            const wire = wireProposalSchema.parse(normalized.value)
            expect(wire.nodes, row.recordedResponse).toHaveLength(row.normalizedNodes)
            expect(row.wire).toEqual(before)
            expect(wire.header).toEqual(row.wire.header)
            expect(wire.bar).toEqual(row.wire.bar)
            expect(normalized.issueCodes.length).toBeGreaterThan(0)
            const evaluated = evaluateWire(normalized.value, context)
            expect(evaluated.ok, row.recordedResponse).toBe(true)
            if (!evaluated.ok) throw new Error(`Recorded strict replay failed: ${row.recordedResponse}`)
            expect(guideQualityIssues(evaluated.proposal, context), row.recordedResponse).toEqual(row.qualityIssues)
        }
    })
})
