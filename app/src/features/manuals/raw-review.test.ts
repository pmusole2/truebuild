import { manualSessionSchema, type ManualSession, type ParsedManual } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { markManualReviewed } from '../../domain/manual-session'
import { applyManualEdit } from './manual-edits'
import { confirmCorrection, copyRawStepToDraft, discardCorrection, reviewBlockers } from './raw-review'

const HASH = 'd'.repeat(64)
const NOW = '2026-10-26T12:00:00.000Z'

function session(
    raw: ParsedManual | null,
    draft: ManualSession['reviewedSteps'] = [],
    parts: ManualSession['parts'] = [],
): ManualSession {
    return manualSessionSchema.parse({
        manualId: 'manual-raw',
        title: 'Raw copy',
        updatedAt: '2026-10-26T10:00:00.000Z',
        revision: 5,
        pages: [1, 2].map((index) => ({
            pageId: `page-${index}`,
            assetId: `asset-${index}`,
            width: 800,
            height: 600,
            mimeType: 'image/jpeg',
            contentHash: HASH,
        })),
        parts,
        rawExtraction: raw,
        reviewedSteps: draft,
        reviewStatus: 'unreviewed',
    })
}

const cite = [{ pageId: 'page-1', region: null }]

// A fully-known raw step. `unknownOrientation` and `correction` vary per test.
function rawStep(
    options: { unknownOrientation?: boolean; correction?: boolean; partId?: string; partName?: string } = {},
): ParsedManual {
    const partId = options.partId ?? 'p1'
    return {
        parts: [{ partId, name: { state: 'known', value: options.partName ?? 'Side panel', sourceRefs: cite } }],
        steps: [
            {
                stepId: 's1',
                order: 1,
                title: 'Stand the panel upright',
                parts: [{ partId, quantity: { state: 'known', value: 1, sourceRefs: cite } }],
                orientation: options.unknownOrientation
                    ? { state: 'unknown', reason: 'Not confirmed from the imported manual pages.' }
                    : { state: 'known', value: { partId, description: 'Groove faces inward.' }, sourceRefs: cite },
                connection: {
                    state: 'known',
                    value: { partIds: [partId], description: 'Seat the edge.' },
                    sourceRefs: cite,
                },
                visibleChecks: [
                    { checkId: 'c1', description: { state: 'known', value: 'Groove is visible.', sourceRefs: cite } },
                ],
                sourceRefs: cite,
                correction: options.correction
                    ? {
                          reviewed: false,
                          actions: [
                              {
                                  actionId: 'a1',
                                  instruction: 'Turn the panel so the groove faces inward.',
                                  sourceRefs: cite,
                              },
                          ],
                      }
                    : null,
            },
        ],
        unknowns: ['Lower edge is not legible.'],
    }
}

describe('copy raw step to draft', () => {
    it('leaves raw evidence byte-for-byte unchanged and copies the step and its parts as editable facts', () => {
        const raw = rawStep()
        const before = structuredClone(session(raw))

        const copied = copyRawStepToDraft(session(raw), 's1', NOW)

        expect(copied.rawExtraction).toEqual(before.rawExtraction)
        expect(copied.reviewedSteps).toHaveLength(1)
        expect(copied.reviewedSteps[0]).toMatchObject({ stepId: 's1', order: 1, title: 'Stand the panel upright' })
        expect(copied.parts).toEqual([{ partId: 'p1', name: raw.parts[0]?.name }])
        expect(copied.revision).toBe(6)
        expect(copied.reviewStatus).toBe('unreviewed')
    })

    it('makes the copied facts editable through the ordinary draft edits', () => {
        const copied = copyRawStepToDraft(session(rawStep()), 's1', NOW)

        const edited = applyManualEdit(copied, { kind: 'set-step-title', stepId: 's1', title: 'Stand it upright' })

        expect(edited.reviewedSteps[0]?.title).toBe('Stand it upright')
        expect(edited.rawExtraction).toEqual(copied.rawExtraction)
    })

    it('refuses a second copy of the same raw step and changes nothing', () => {
        const once = copyRawStepToDraft(session(rawStep()), 's1', NOW)

        expect(() => copyRawStepToDraft(once, 's1', NOW)).toThrow(/already in the draft/)
        expect(() => applyManualEdit(once, { kind: 'copy-raw-step', rawStepId: 's1' })).toThrow(/already in the draft/)
        expect(once.reviewedSteps).toHaveLength(1)
    })

    it('refuses to overwrite a draft part that shares an identity but has a different name', () => {
        const draft = manualSessionSchema.parse({
            ...session(rawStep({ partName: 'Side panel' })),
            parts: [{ partId: 'p1', name: { state: 'known', value: 'Hand-edited name', sourceRefs: cite } }],
        })

        expect(() => copyRawStepToDraft(draft, 's1', NOW)).toThrow(/different name/)
        expect(draft.parts[0]?.name).toMatchObject({ value: 'Hand-edited name' })
    })

    it('keeps the existing human-edited draft step when copying another raw step', () => {
        const existing = copyRawStepToDraft(session(rawStep()), 's1', NOW).reviewedSteps[0]
        const raw: ParsedManual = {
            ...rawStep({ partId: 'p2', partName: 'Divider' }),
            steps: [{ ...rawStep({ partId: 'p2' }).steps[0]!, stepId: 's2', order: 1 }],
        }
        // The draft registry must already hold p1, as a real earlier copy would have added it.
        const withDraft = session(raw, existing ? [existing] : [], [{ partId: 'p1', name: rawStep().parts[0]!.name }])

        const copied = copyRawStepToDraft(withDraft, 's2', NOW)

        expect(copied.reviewedSteps.map((step) => step.stepId)).toEqual(['s1', 's2'])
        expect(copied.reviewedSteps[0]).toEqual(existing)
        expect(copied.reviewedSteps[1]?.order).toBe(2)
    })
})

describe('review gates with copied facts', () => {
    it('an unknown copied fact prevents review, and the blocker names it', () => {
        const copied = copyRawStepToDraft(session(rawStep({ unknownOrientation: true })), 's1', NOW)

        expect(() => markManualReviewed(copied)).toThrow()
        expect(reviewBlockers(copied).join(' ')).toMatch(/orientation is unknown/)
    })

    it('an unconfirmed proposed correction prevents review until it is confirmed', () => {
        const copied = copyRawStepToDraft(session(rawStep({ correction: true })), 's1', NOW)

        expect(() => markManualReviewed(copied)).toThrow()
        expect(reviewBlockers(copied).join(' ')).toMatch(/confirm or discard the proposed correction/)

        const confirmed = confirmCorrection(copied, 's1', NOW)

        expect(confirmed.reviewedSteps[0]?.correction).toMatchObject({ reviewed: true })
        expect(markManualReviewed(confirmed).reviewStatus).toBe('reviewed')
    })

    it('discarding the proposal also clears the review block without confirming anything', () => {
        const copied = copyRawStepToDraft(session(rawStep({ correction: true })), 's1', NOW)

        const discarded = discardCorrection(copied, 's1', NOW)

        expect(discarded.reviewedSteps[0]?.correction).toBeNull()
        expect(discarded.reviewStatus).toBe('unreviewed')
        expect(markManualReviewed(discarded).reviewStatus).toBe('reviewed')
    })

    it('copying, confirming and discarding never mark the manual reviewed by themselves', () => {
        const copied = copyRawStepToDraft(session(rawStep({ correction: true })), 's1', NOW)
        const confirmed = confirmCorrection(copied, 's1', NOW)

        expect(copied.reviewStatus).toBe('unreviewed')
        expect(confirmed.reviewStatus).toBe('unreviewed')
    })

    it('refuses to confirm a correction that does not exist or is already confirmed', () => {
        const plain = copyRawStepToDraft(session(rawStep()), 's1', NOW)
        expect(() => confirmCorrection(plain, 's1', NOW)).toThrow(/no proposed correction/)

        const confirmed = confirmCorrection(
            copyRawStepToDraft(session(rawStep({ correction: true })), 's1', NOW),
            's1',
            NOW,
        )
        expect(() => confirmCorrection(confirmed, 's1', NOW)).toThrow(/already confirmed/)
    })
})
