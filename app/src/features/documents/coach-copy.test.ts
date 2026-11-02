import { describe, expect, it } from 'vitest'
import type { CoachCandidate } from '../onboarding/coach-types'
import { applyWrittenTips } from './coach-copy'
const candidate = (id: string): CoachCandidate => ({
    id,
    kind: 'control',
    heading: `H ${id}`,
    sentence: `native ${id}`,
})
describe('document-written coach copy', () => {
    const native = [candidate('home-add'), candidate('header-more'), candidate('keep-building')]
    it('retains native candidates when no document tips exist', () => {
        expect(applyWrittenTips(native, undefined)).toBe(native)
        expect(applyWrittenTips(native, new Map())).toBe(native)
    })
    it('rewords and reorders existing targets only, preserving all remaining candidates', () => {
        const tips = new Map([
            ['header-more', { heading: 'More help', text: 'Everything else is here.' }],
            ['home-add', { heading: 'Start', text: 'Add your manual here.' }],
            ['camera-shutter', { heading: 'Not here', text: 'This screen has no shutter.' }],
        ])
        expect(applyWrittenTips(native, tips).map((tip) => [tip.id, tip.heading, tip.sentence])).toEqual([
            ['header-more', 'More help', 'Everything else is here.'],
            ['home-add', 'Start', 'Add your manual here.'],
            ['keep-building', 'H keep-building', 'native keep-building'],
        ])
    })
})
