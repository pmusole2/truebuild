import { describe, expect, it } from 'vitest'
import { isFixtureResult, secondOpinionLine } from './provenance-copy'

describe('naming a second opinion', () => {
    it('names the model of a live result and its outcome, and nothing while the offer is still open', () => {
        const live = { secondOpinion: { model: 'muse-wonder-1.0' as const, status: 'completed' as const } }
        expect(secondOpinionLine(live)).toBe('Second opinion: muse-wonder-1.0 (completed)')
        expect(
            secondOpinionLine({ secondOpinion: { model: 'muse-wonder-1.0', status: 'available', token: 't' } }),
        ).toBe(null)
        expect(secondOpinionLine({})).toBeNull()
    })

    it('never credits an offered model on a fixture result, where it is only the intended target', () => {
        const fixture = {
            evidence: 'synthetic-fixture' as const,
            secondOpinion: { model: 'muse-wonder-1.0' as const, status: 'unavailable' as const },
        }
        expect(isFixtureResult(fixture)).toBe(true)
        expect(secondOpinionLine(fixture)).toBe('Second opinion: simulated, no model call (unavailable)')
        expect(secondOpinionLine(fixture)).not.toContain('muse-')
    })
})
