import { describe, expect, it } from 'vitest'
import { plainNotice, plainPending } from './plain-copy'

describe('legacy pending copy', () => {
    it.each([
        ['Saving manual pages…', 'Saving your progress'],
        ['Saving on this device…', 'Saving your progress'],
        ['Preparing page 2 of 3…', 'Getting your photos ready'],
        ['Choosing manual pages…', 'Choosing your page photos'],
        ['A future controller operation…', 'Laying out this step'],
    ])('describes %s without inventing a save', (pending, expected) => {
        expect(plainPending(pending)).toBe(expected)
    })

    it('keeps an unknown library operation on the Home vocabulary', () => {
        expect(plainPending('A future controller operation…', 'home')).toBe('Opening your manuals')
    })

    it('describes a local save notice through the same progress copy', () => {
        expect(plainNotice('Finishing the local save.')).toBe('Saving your progress')
    })

    it('keeps specific reading, check and answer activities and the idle boundary', () => {
        expect(plainPending('Reading manual pages…')).toBe('Reading your manual. This can take a minute.')
        expect(plainPending('Reading manual pages: laying out steps…')).toBe('Laying out steps…')
        expect(plainPending('Checking frozen photo…')).toBe('Checking your photo…')
        expect(plainPending('Still checking your photo…')).toBe('Still checking your photo…')
        expect(plainPending('Freezing photo…')).toBe('Checking your photo…')
        expect(plainPending('Second opinion pending…')).toBe('Taking a closer look…')
        expect(plainPending('Still thinking about your question…')).toBe('Still thinking…')
        expect(plainPending('Asking about frozen photo…')).toBe('Asking…')
        expect(plainPending(null)).toBeNull()
    })
})
