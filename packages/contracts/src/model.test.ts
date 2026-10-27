import { describe, expect, it } from 'vitest'

import { createDemoManual } from './index'
import {
    modelCheckMetadataSchema,
    modelSecondOpinionMetadataSchema,
    selectStepSourcePageIds,
    selectCompactStepSourcePageIds,
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

it('defaults to all ordered manual pages and bounds only explicit compact citation coverage', () => {
    const session = createDemoManual()
    session.pages.push(
        { ...session.pages[0]!, pageId: 'page-2', assetId: 'asset-2' },
        { ...session.pages[0]!, pageId: 'page-3', assetId: 'asset-3' },
    )
    const part = session.parts[0]!
    if (part.name.state === 'known') part.name.sourceRefs.push({ pageId: 'page-2', region: null })
    expect(selectStepSourcePageIds(session, 'step-1')).toEqual(['demo-page-1', 'page-2', 'page-3'])
    expect(selectCompactStepSourcePageIds(session, 'step-1')).toEqual(['demo-page-1', 'page-2'])
    session.reviewedSteps[0]!.sourceRefs.push({ pageId: 'page-3', region: null })
    expect(selectCompactStepSourcePageIds(session, 'step-1')).toBeNull()
    expect(selectStepSourcePageIds(session, 'step-1')).toEqual(['demo-page-1', 'page-2', 'page-3'])
    session.reviewedSteps[0]!.sourceRefs.push({ pageId: 'absent', region: null })
    expect(selectStepSourcePageIds(session, 'step-1')).toBeNull()
})

it('requires a second-opinion token and preserves strict current-step admission', () => {
    const value = modelCheckMetadataSchema.parse(metadata())
    expect(modelSecondOpinionMetadataSchema.safeParse(value).success).toBe(false)
    expect(modelSecondOpinionMetadataSchema.safeParse({ ...value, secondOpinionToken: 'ticket' }).success).toBe(true)
    expect(
        modelSecondOpinionMetadataSchema.safeParse({ ...value, secondOpinionToken: '', model: 'muse-wonder-1.0' })
            .success,
    ).toBe(false)
    expect(
        modelSecondOpinionMetadataSchema.safeParse({
            ...value,
            binding: { ...value.binding, revision: 2 },
            secondOpinionToken: 'ticket',
        }).success,
    ).toBe(false)
})

it('keeps server model provenance Standard-only and second-opinion states coherent', async () => {
    const { checkResultSchema, parsedManualSchema, questionResultSchema } = await import('./index')
    const base = {
        decision: 'cannot_verify',
        reason: 'Uncertain',
        sourceRefs: [],
        observedRegion: null,
        missingEvidence: [],
    }
    const model = 'muse-spark-1.3'
    for (const schemaAndValue of [
        { schema: checkResultSchema, value: base },
        { schema: parsedManualSchema, value: { parts: [], steps: [], unknowns: [] } },
        { schema: questionResultSchema, value: { answer: 'Uncertain', sourceRefs: [], missingEvidence: [] } },
    ]) {
        expect(
            schemaAndValue.schema.safeParse({ ...schemaAndValue.value, model: 'muse-spark-1.3-contributor' }).success,
        ).toBe(false)
        expect(
            schemaAndValue.schema.safeParse({ ...schemaAndValue.value, model, modelNotes: ['Server note'] }).success,
        ).toBe(true)
    }
    const available = { model: 'muse-wonder-1.0', status: 'available', token: 'ticket' }
    expect(checkResultSchema.safeParse({ ...base, model, secondOpinion: available }).success).toBe(true)
    for (const bad of [
        { ...base, model: 'muse-wonder-1.0', secondOpinion: available },
        { ...base, secondOpinion: available },
        { ...base, model, decision: 'pass', sourceRefs: [{ pageId: 'page', region: null }], secondOpinion: available },
        {
            ...base,
            model,
            decision: 'refuse',
            sourceRefs: [{ pageId: 'page', region: null }],
            secondOpinion: available,
        },
        { ...base, model, secondOpinion: { model, status: 'available' } },
    ])
        expect(checkResultSchema.safeParse(bad).success).toBe(false)
    for (const status of ['completed', 'unavailable']) {
        expect(checkResultSchema.safeParse({ ...base, model, secondOpinion: { model, status } }).success).toBe(true)
        expect(
            checkResultSchema.safeParse({ ...base, model, secondOpinion: { model, status, token: 'ticket' } }).success,
        ).toBe(false)
    }
})
