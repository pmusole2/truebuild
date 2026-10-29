import { createDemoManual, type ManualStep } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { safetyKey, stepSafetyNotes } from './safety'

const base = createDemoManual().reviewedSteps[0]!
const withFacts = (overrides: Partial<ManualStep>): ManualStep => ({ ...base, ...overrides })

describe('step safety notes', () => {
    it('finds nothing in a step that states no hazard, and nothing for no step', () => {
        expect(stepSafetyNotes(undefined)).toEqual([])
        expect(stepSafetyNotes(withFacts({ title: 'Stand the side panel upright', visibleChecks: [] }))).toEqual([])
    })

    it('keeps the manual’s own sentence as written, from any known fact', () => {
        const step = withFacts({
            title: 'Fit the shelf. Two people should lift this.',
            visibleChecks: [
                {
                    checkId: 'c1',
                    description: {
                        state: 'known',
                        value: 'Never stand on the shelf. The edge is sharp.',
                        sourceRefs: base.sourceRefs,
                    },
                },
            ],
        })
        expect(stepSafetyNotes(step)).toEqual([
            'Two people should lift this.',
            'Never stand on the shelf.',
            'The edge is sharp.',
        ])
    })

    it('does not read an unknown fact, repeat a sentence or return more than three', () => {
        const step = withFacts({
            title: 'Careful. Do not overtighten. Wear gloves. It is heavy. Danger of tipping over.',
            orientation: { state: 'unknown', reason: 'Unreadable' },
        })
        const notes = stepSafetyNotes(step)
        expect(notes).toHaveLength(3)
        expect(new Set(notes.map(safetyKey)).size).toBe(3)
    })

    it('reads reviewed corrections only', () => {
        const correction = (reviewed: boolean): ManualStep['correction'] => ({
            reviewed,
            actions: [
                { actionId: 'a1', instruction: 'Unplug the lamp before you turn it.', sourceRefs: base.sourceRefs },
            ],
        })
        expect(stepSafetyNotes(withFacts({ correction: correction(false) }))).toEqual([])
        expect(stepSafetyNotes(withFacts({ correction: correction(true) }))).toEqual([
            'Unplug the lamp before you turn it.',
        ])
    })

    it('normalizes for comparison so a reworded copy of the same sentence is the same warning', () => {
        expect(safetyKey('Two people should lift this.')).toBe(safetyKey('two  people should lift THIS'))
    })

    it('never treats opposite rotations or different comparison operators as the same warning', () => {
        expect(safetyKey('Rotate -90 degrees.')).not.toBe(safetyKey('Rotate +90 degrees.'))
        expect(safetyKey('Keep the load < 5 kg.')).not.toBe(safetyKey('Keep the load > 5 kg.'))
    })
})
