import { describe, expect, it } from 'vitest'
import { STEP_EXAMPLES, VERDICT_EXAMPLES } from './examples'

describe('preview examples', () => {
    it('cover all three verdicts so every result variant is reviewed', () => {
        expect(VERDICT_EXAMPLES.map((example) => example.verdict).sort()).toEqual(['cannot_verify', 'pass', 'refuse'])
    })

    it('cover every step state so the progress list is reviewed in full', () => {
        expect(new Set(STEP_EXAMPLES.map((step) => step.state))).toEqual(
            new Set(['done', 'current', 'upcoming', 'blocked']),
        )
    })
})
