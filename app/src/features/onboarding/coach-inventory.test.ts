import { describe, expect, it } from 'vitest'
import {
    MAX_TIPS_PER_SCREEN,
    cameraCandidates,
    guideCandidates,
    guidePrimarySentence,
    homeCandidates,
    pagesCandidates,
    quickCheckCandidates,
} from './coach-inventory'

const words = (text: string): number => text.trim().split(/\s+/u).length
const BANNED = /\b(yes|no\b|done pages|you are done)/iu

const ALL = [
    ...homeCandidates({ add: true, resume: true, more: true }),
    ...pagesCandidates({ pages: 0, open: true, canRead: false }),
    ...pagesCandidates({ pages: 2, open: true, canRead: true }),
    ...quickCheckCandidates({ state: 'asking' }),
    ...quickCheckCandidates({ state: 'blocked' }),
    ...quickCheckCandidates({ state: 'ready' }),
    ...guideCandidates({ hero: true, primaryLabel: 'Take photo', swipe: true, more: true }),
    ...cameraCandidates({ intent: 'page' }),
    ...cameraCandidates({ intent: 'part' }),
]

describe('coach copy', () => {
    it('keeps every sentence to twelve words and honest about the real controls', () => {
        for (const tip of ALL) {
            expect(words(tip.sentence), tip.sentence).toBeLessThanOrEqual(12)
            expect(tip.sentence, tip.sentence).not.toMatch(BANNED)
        }
        for (const label of ['Take photo', 'Take another photo', 'Next step', 'Finish', 'Answer questions']) {
            expect(words(guidePrimarySentence(label)!)).toBeLessThanOrEqual(12)
        }
    })

    it('never promises a Yes in Quick check or a Done in Pages', () => {
        const quick = (['asking', 'blocked', 'ready'] as const).flatMap((state) => quickCheckCandidates({ state }))
        expect(quick.map((tip) => tip.id)).toEqual([
            'quick-check-fix',
            'quick-check-skip',
            'quick-check-clearer',
            'quick-check-start',
        ])
        const pages = [0, 3].flatMap((count) => pagesCandidates({ pages: count, open: true, canRead: count > 0 }))
        expect(pages.map((tip) => tip.sentence).join(' ')).not.toMatch(/\bdone\b/iu)
    })
})

describe('coach queues', () => {
    it('never exceeds four tips on a screen, and Guide uses exactly the four', () => {
        const guide = guideCandidates({ hero: true, primaryLabel: 'Next step', swipe: true, more: true })
        expect(guide.map((tip) => tip.id)).toEqual(['guide-hero', 'guide-primary', 'guide-hero-frame', 'header-more'])
        expect(guide).toHaveLength(MAX_TIPS_PER_SCREEN)
        for (const count of [homeCandidates({ add: true, resume: true, more: true }), ALL]) {
            expect(count.length).toBeGreaterThan(0)
        }
        expect(homeCandidates({ add: true, resume: true, more: true }).length).toBeLessThanOrEqual(MAX_TIPS_PER_SCREEN)
    })

    it('Home teaches Add for an empty or multi-manual library and the sole manual resume otherwise', () => {
        expect(homeCandidates({ add: true, resume: false, more: true }).map((tip) => tip.id)).toEqual([
            'home-add',
            'header-more',
        ])
        expect(homeCandidates({ add: false, resume: true, more: true }).map((tip) => tip.id)).toEqual([
            'keep-building',
            'header-more',
        ])
        expect(homeCandidates({ add: false, resume: false, more: false })).toEqual([])
    })

    it('Pages teaches photo and choose, or read and add-page, never both groups', () => {
        expect(pagesCandidates({ pages: 0, open: true, canRead: false }).map((tip) => tip.id)).toEqual([
            'take-page-photo',
            'choose-pages',
        ])
        expect(pagesCandidates({ pages: 2, open: true, canRead: true }).map((tip) => tip.id)).toEqual([
            'read-manual',
            'add-page',
        ])
        expect(pagesCandidates({ pages: 0, open: false, canRead: false })).toEqual([])
    })

    it('Guide copy follows the live button label and skips a button that cannot be tapped', () => {
        expect(guidePrimarySentence('Take photo')).toBe('Take a photo to check your work.')
        expect(guidePrimarySentence('Next step')).toBe('Tap Next step when this looks right.')
        expect(guidePrimarySentence('Go to step 4')).toBe('Tap here to go to the step that is not done.')
        expect(guidePrimarySentence('Checking…')).toBeNull()
        expect(guidePrimarySentence(null)).toBeNull()
        const ids = guideCandidates({ hero: true, primaryLabel: null, swipe: false, more: true }).map((tip) => tip.id)
        expect(ids).toEqual(['guide-hero', 'header-more'])
    })

    it('Camera has one shutter tip whose words follow the photo intent, and none without an intent', () => {
        expect(cameraCandidates({ intent: 'page' })[0]?.sentence).toBe('Tap here when one page fills the frame.')
        expect(cameraCandidates({ intent: 'part' })[0]?.sentence).toBe('Tap here when the part fills the frame.')
        expect(cameraCandidates({ intent: null })).toEqual([])
    })
})
