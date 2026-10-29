import { describe, expect, it } from 'vitest'

import { checkResultSchema, createDemoManual } from './index'
import { overlayResultSchema } from './model'

// An isolated fixture runtime makes no model call. Its public values may say so explicitly and then carry no model,
// effort, timing or usage; every live value still has to name what produced it.
const sourceRefs = createDemoManual().reviewedSteps[0]!.sourceRefs
const uncertain = {
    decision: 'cannot_verify' as const,
    orientationAssessment: 'uncertain' as const,
    reason: 'A closer look is needed.',
    sourceRefs,
    observedRegion: null,
    missingEvidence: ['The connection needs a closer look.'],
}
const offer = { model: 'muse-wonder-1.0' as const, status: 'available' as const, token: 't'.repeat(16) }
const telemetry = {
    stage: 'verdict' as const,
    model: 'muse-spark-1.3' as const,
    effort: 'low' as const,
    timing: {
        timeToProviderMs: 1,
        paceWaitMs: 0,
        networkMs: 1,
        bodyMs: 1,
        providerMs: 2,
        parseValidateMs: 1,
        totalMs: 4,
    },
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 },
}

describe('check results from an isolated fixture runtime', (): void => {
    it('may offer the second pass of an uncertain verdict without naming a model that never ran', (): void => {
        const parsed = checkResultSchema.parse({ ...uncertain, evidence: 'synthetic-fixture', secondOpinion: offer })
        expect(parsed).not.toHaveProperty('model')
        expect(parsed.secondOpinion).toEqual(offer)
    })

    it('keeps the live requirement: an offer needs an uncertain Spark verdict and no fixture claim', (): void => {
        expect(checkResultSchema.safeParse({ ...uncertain, secondOpinion: offer }).success).toBe(false)
        expect(
            checkResultSchema.safeParse({ ...uncertain, model: 'muse-wonder-1.0', secondOpinion: offer }).success,
        ).toBe(false)
        expect(
            checkResultSchema.safeParse({ ...uncertain, model: 'muse-spark-1.3', secondOpinion: offer }).success,
        ).toBe(true)
    })

    it('never lets a fixture result claim a model or observed telemetry', (): void => {
        const fixture = { ...uncertain, evidence: 'synthetic-fixture' as const }
        expect(checkResultSchema.safeParse(fixture).success).toBe(true)
        expect(checkResultSchema.safeParse({ ...fixture, model: 'muse-spark-1.3' }).success).toBe(false)
        expect(checkResultSchema.safeParse({ ...fixture, telemetry }).success).toBe(false)
        expect(checkResultSchema.safeParse({ ...fixture, evidence: 'live' }).success).toBe(false)
    })

    it('cannot turn a decided verdict into an uncertain one to earn the offer', (): void => {
        const decided = {
            decision: 'pass' as const,
            reason: 'Looks right.',
            sourceRefs,
            observedRegion: null,
            missingEvidence: [],
            evidence: 'synthetic-fixture' as const,
        }
        expect(checkResultSchema.safeParse({ ...decided, secondOpinion: offer }).success).toBe(false)
    })
})

describe('overlay results', (): void => {
    const regions = { observedRegion: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 } }

    it('names the model and effort of a live overlay and nothing less', (): void => {
        expect(overlayResultSchema.safeParse({ model: 'muse-wonder-1.0', effort: 'max', ...regions }).success).toBe(
            true,
        )
        expect(overlayResultSchema.safeParse({ effort: 'max', ...regions }).success).toBe(false)
        expect(overlayResultSchema.safeParse({ model: 'muse-wonder-1.0', ...regions }).success).toBe(false)
        expect(overlayResultSchema.safeParse({ ...regions }).success).toBe(false)
    })

    it('says explicitly that a fixture overlay observed no model, effort or telemetry', (): void => {
        expect(overlayResultSchema.safeParse({ evidence: 'synthetic-fixture', ...regions }).success).toBe(true)
        for (const claim of [
            { model: 'muse-wonder-1.0' },
            { effort: 'max' },
            {
                telemetry: {
                    stage: 'overlay',
                    model: 'muse-wonder-1.0',
                    effort: 'max',
                    timing: telemetry.timing,
                    usage: telemetry.usage,
                },
            },
            { evidence: 'live' },
        ]) {
            expect(overlayResultSchema.safeParse({ evidence: 'synthetic-fixture', ...regions, ...claim }).success).toBe(
                false,
            )
        }
    })
})
