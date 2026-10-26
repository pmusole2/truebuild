import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkResultSchema, manualSessionSchema } from './index'
import { createHeroManual, createHeroResponse, HERO_DIAGRAM_PNG_BASE64, HERO_DIAGRAM_SHA256 } from './hero'

describe('synthetic reversed-panel hero', () => {
    it('refuses reversed, passes corrected, and declines unobservable orientation', () => {
        expect(createHeroResponse('reversed')).toMatchObject({
            decision: 'refuse',
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
        })
        expect(createHeroResponse('correct').decision).toBe('pass')
        expect(createHeroResponse('uncertain').decision).toBe('cannot_verify')
        const manual = createHeroManual()
        expect(manualSessionSchema.safeParse(manual).success).toBe(true)
        expect(manual.pages[0]?.contentHash).toBe(HERO_DIAGRAM_SHA256)
        expect(createHash('sha256').update(Buffer.from(HERO_DIAGRAM_PNG_BASE64, 'base64')).digest('hex')).toBe(
            HERO_DIAGRAM_SHA256,
        )
    })
    it.each([
        { ...createHeroResponse('reversed'), decision: 'pass' },
        { ...createHeroResponse('reversed'), sourceRefs: [] },
        { ...createHeroResponse('uncertain'), decision: 'refuse' },
        { ...createHeroResponse('uncertain'), decision: 'pass', missingEvidence: [] },
    ])('rejects contradictory orientation %#', (value) => {
        expect(checkResultSchema.safeParse(value).success).toBe(false)
    })
    it('preserves old responses without an orientation assessment', () => {
        const { orientationAssessment: _, ...old } = createHeroResponse('correct')
        expect(checkResultSchema.parse(old)).toEqual(old)
    })
})
