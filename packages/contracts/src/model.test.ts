import { describe, expect, it } from 'vitest'

import { createDemoManual } from './index'
import {
    modelCheckMetadataSchema,
    modelParseMetadataSchema,
    modelQuestionMetadataSchema,
    modelSegmentMetadataSchema,
} from './model'

function metadata(): unknown {
    const session = createDemoManual()
    return {
        mode: 'model',
        requestId: 'request-1',
        binding: {
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: 'step-1',
            captureId: 'capture-1',
        },
        session,
        sourcePageIds: ['demo-page-1'],
        observation: { mimeType: 'image/png', width: 20, height: 16 },
    }
}

describe('model metadata admission', (): void => {
    it('accepts current reviewed context and refuses stale binding or duplicated sources', (): void => {
        const value = modelCheckMetadataSchema.parse(metadata())
        expect(
            modelCheckMetadataSchema.safeParse({ ...value, binding: { ...value.binding, revision: 2 } }).success,
        ).toBe(false)
        expect(
            modelCheckMetadataSchema.safeParse({ ...value, sourcePageIds: ['demo-page-1', 'demo-page-1'] }).success,
        ).toBe(false)
        expect(modelCheckMetadataSchema.safeParse({ ...value, extra: true }).success).toBe(false)
    })
    it('requires all current step citations and restricts part targets to the current step', (): void => {
        const value = modelCheckMetadataSchema.parse(metadata())
        value.session.pages.push({ ...value.session.pages[0]!, pageId: 'page-2', assetId: 'asset-2' })
        value.session.reviewedSteps[0]!.sourceRefs.push({ pageId: 'page-2', region: null })
        expect(modelCheckMetadataSchema.safeParse(value).success).toBe(false)
        const fresh = modelCheckMetadataSchema.parse(metadata())
        expect(
            modelQuestionMetadataSchema.safeParse({
                ...fresh,
                question: 'Which way?',
                target: { kind: 'part', partId: 'divider' },
            }).success,
        ).toBe(false)
        expect(
            modelQuestionMetadataSchema.safeParse({
                ...fresh,
                question: 'Which way?',
                target: { kind: 'part', partId: 'side-panel' },
            }).success,
        ).toBe(true)
    })
    it('rejects duplicate extraction pages and bounds segment geometry/prompt', (): void => {
        const demo = createDemoManual()
        expect(
            modelParseMetadataSchema.safeParse({
                mode: 'model',
                requestId: 'r',
                binding: { kind: 'manual', manualId: 'm', revision: 1 },
                pages: [demo.pages[0], demo.pages[0]],
            }).success,
        ).toBe(false)
        const check = modelCheckMetadataSchema.parse(metadata())
        const segment = {
            mode: 'model',
            requestId: 'r',
            binding: check.binding,
            capturedAt: '2026-01-01T00:00:00.000Z',
            prompt: 'divider',
            media: { kind: 'image', mimeType: 'image/png', width: 20, height: 16 },
        }
        expect(modelSegmentMetadataSchema.safeParse(segment).success).toBe(true)
        expect(modelSegmentMetadataSchema.safeParse({ ...segment, prompt: 'find the divider' }).success).toBe(false)
        expect(
            modelSegmentMetadataSchema.safeParse({ ...segment, media: { ...segment.media, width: 25_000_000 } })
                .success,
        ).toBe(false)
    })
})
