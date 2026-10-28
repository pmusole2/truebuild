import { describe, expect, it } from 'vitest'
import { arrowSegment, guidanceNotes, MIN_EDGE_GAP, partGuidance } from './part-regions'

// Synthetic geometry and part names only: no recorded or live model output backs any value here.
const NAMES = new Map([
    ['divider', 'Wooden divider'],
    ['side-panel', 'Side panel'],
])
const NEXT_BOX = { x: 0.1, y: 0.2, width: 0.2, height: 0.3 }
const TARGET_BOX = { x: 0.6, y: 0.5, width: 0.25, height: 0.3 }
const next = (partId = 'divider', region: unknown = NEXT_BOX): { nextPartRegion: unknown } => ({
    nextPartRegion: { partId, region },
})
const target = (partId = 'divider', region: unknown = TARGET_BOX): { targetRegion: unknown } => ({
    targetRegion: { partId, region },
})

describe('absent geometry draws nothing', () => {
    it.each([
        ['null', null],
        ['a string', 'result'],
        ['an empty result', {}],
        ['a result with only an observed region', { observedRegion: NEXT_BOX }],
        ['explicitly undefined fields', { nextPartRegion: undefined, targetRegion: undefined }],
        ['null fields', { nextPartRegion: null, targetRegion: null }],
    ])('returns no boxes, arrow or caption for %s', (_name, result) => {
        expect(partGuidance(result, NAMES)).toEqual({ next: null, target: null, arrow: false, captions: [] })
    })

    it('never turns an observed region into a destination or an arrow', () => {
        const guidance = partGuidance({ ...next(), observedRegion: TARGET_BOX }, NAMES)
        expect(guidance.target).toBeNull()
        expect(guidance.arrow).toBe(false)
    })
})

describe('one field only', () => {
    it('keeps a next part alone, without an arrow or a guessed destination', () => {
        const guidance = partGuidance(next(), NAMES)
        expect(guidance.next).toEqual({ partId: 'divider', name: 'Wooden divider', box: NEXT_BOX })
        expect(guidance.target).toBeNull()
        expect(guidance.arrow).toBe(false)
        expect(guidance.captions).toEqual(['Next part: Wooden divider'])
    })

    it('keeps a target alone, without an arrow or a guessed source', () => {
        const guidance = partGuidance(target(), NAMES)
        expect(guidance.next).toBeNull()
        expect(guidance.target).toEqual({ partId: 'divider', name: 'Wooden divider', box: TARGET_BOX })
        expect(guidance.arrow).toBe(false)
        expect(guidance.captions).toEqual(['Target for Wooden divider'])
    })
})

describe('matching pair', () => {
    it('draws both boxes and one arrow when both regions are real and share a part', () => {
        const guidance = partGuidance({ ...next(), ...target() }, NAMES)
        expect(guidance.next?.box).toEqual(NEXT_BOX)
        expect(guidance.target?.box).toEqual(TARGET_BOX)
        expect(guidance.arrow).toBe(true)
        expect(guidance.captions).toEqual([
            'Next part: Wooden divider',
            'Target for Wooden divider',
            'Move Wooden divider to the marked area',
        ])
    })

    it('claims no arrow and no "Move" instruction when both boxes share one centre, since that gives no direction', () => {
        const guidance = partGuidance({ ...next('divider', NEXT_BOX), ...target('divider', NEXT_BOX) }, NAMES)
        expect(guidance.next?.box).toEqual(NEXT_BOX)
        expect(guidance.target?.box).toEqual(NEXT_BOX)
        expect(guidance.arrow).toBe(false)
        expect(guidance.captions).toEqual(['Next part: Wooden divider', 'Target for Wooden divider'])
    })

    it('returns the boxes exactly as sent, with no rounding or growth', () => {
        const exact = { x: 0.123_456_789, y: 0.2, width: 0.111_111, height: 0.3 }
        expect(partGuidance(next('divider', exact), NAMES).next?.box).toEqual(exact)
    })
})

describe('mismatched parts', () => {
    it('draws each box under its own part name and never connects them', () => {
        const guidance = partGuidance({ ...next('divider'), ...target('side-panel') }, NAMES)
        expect(guidance.next?.name).toBe('Wooden divider')
        expect(guidance.target?.name).toBe('Side panel')
        expect(guidance.arrow).toBe(false)
        expect(guidance.captions).toEqual(['Next part: Wooden divider', 'Target for Side panel'])
    })
})

describe('invalid or out-of-step geometry', () => {
    it.each([
        ['negative x', { ...NEXT_BOX, x: -0.1 }],
        ['overhanging right edge', { ...NEXT_BOX, x: 0.9 }],
        ['overhanging bottom edge', { ...NEXT_BOX, y: 0.9 }],
        ['zero width', { ...NEXT_BOX, width: 0 }],
        ['zero height', { ...NEXT_BOX, height: 0 }],
        ['NaN coordinate', { ...NEXT_BOX, x: Number.NaN }],
        ['infinite coordinate', { ...NEXT_BOX, width: Number.POSITIVE_INFINITY }],
        ['string coordinate', { ...NEXT_BOX, x: '0.1' }],
        ['extra key', { ...NEXT_BOX, rotation: 12 }],
        ['missing key', { x: 0.1, y: 0.2, width: 0.2 }],
        ['not an object', 'box'],
    ])('drops a next part with %s and leaves the valid target alone', (_name, region) => {
        const guidance = partGuidance({ ...next('divider', region), ...target() }, NAMES)
        expect(guidance.next).toBeNull()
        expect(guidance.target?.box).toEqual(TARGET_BOX)
        expect(guidance.arrow).toBe(false)
        expect(guidance.captions).toEqual(['Target for Wooden divider'])
    })

    it('drops an invalid target and keeps the valid next part without an arrow', () => {
        const guidance = partGuidance({ ...next(), ...target('divider', { ...TARGET_BOX, width: 0 }) }, NAMES)
        expect(guidance.next?.box).toEqual(NEXT_BOX)
        expect(guidance.target).toBeNull()
        expect(guidance.arrow).toBe(false)
    })

    it.each(['', '   ', 'x'.repeat(129), 7, null])('drops a region with the part id %j', (partId) => {
        expect(partGuidance({ nextPartRegion: { partId, region: NEXT_BOX } }, NAMES).next).toBeNull()
    })

    it('drops a region for a part that is not in the current step, so no name is guessed', () => {
        const guidance = partGuidance({ ...next('screw-m6'), ...target('screw-m6') }, NAMES)
        expect(guidance).toEqual({ next: null, target: null, arrow: false, captions: [] })
    })

    it('keeps the in-step side when only the other side is out of step', () => {
        const guidance = partGuidance({ ...next('divider'), ...target('screw-m6') }, NAMES)
        expect(guidance.next?.partId).toBe('divider')
        expect(guidance.target).toBeNull()
        expect(guidance.arrow).toBe(false)
    })

    it('drops regions when the step lists no named parts', () => {
        expect(partGuidance({ ...next(), ...target() }, new Map()).arrow).toBe(false)
        expect(partGuidance({ ...next(), ...target() }, new Map()).next).toBeNull()
    })

    it('rejects a region record with extra keys instead of ignoring them', () => {
        expect(
            partGuidance({ nextPartRegion: { partId: 'divider', region: NEXT_BOX, label: 'Hallucinated' } }, NAMES)
                .next,
        ).toBeNull()
    })
})

describe('arrowSegment', () => {
    const from = { x: 20, y: 40, width: 60, height: 60 }

    it('runs from the source edge to the destination edge along the line between their centres', () => {
        const to = { x: 220, y: 40, width: 60, height: 60 }
        const segment = arrowSegment(from, to)
        expect(segment).not.toBeNull()
        expect(segment!.x1).toBeCloseTo(80, 6)
        expect(segment!.y1).toBeCloseTo(70, 6)
        expect(segment!.x2).toBeCloseTo(220, 6)
        expect(segment!.y2).toBeCloseTo(70, 6)
    })

    it('uses the top or bottom edge when the destination is mostly vertical', () => {
        const segment = arrowSegment(from, { x: 20, y: 240, width: 60, height: 60 })
        expect(segment!.y1).toBeCloseTo(100, 6)
        expect(segment!.y2).toBeCloseTo(240, 6)
        expect(segment!.x1).toBeCloseTo(50, 6)
    })

    it('points back toward a destination on the left or above', () => {
        const segment = arrowSegment({ x: 220, y: 240, width: 60, height: 60 }, from)
        expect(segment!.x2).toBeLessThan(segment!.x1)
        expect(segment!.y2).toBeLessThan(segment!.y1)
    })

    it('runs between the two centres when the boxes overlap, touch or leave only a hairline gap', () => {
        // Overlapping, touching, and a 5 point gap (below the readable edge gap): none is dropped and none is reversed.
        const cases = [
            { to: { x: 50, y: 60, width: 60, height: 60 }, end: { x: 80, y: 90 } },
            { to: { x: 80, y: 40, width: 60, height: 60 }, end: { x: 110, y: 70 } },
            { to: { x: 85, y: 40, width: 60, height: 60 }, end: { x: 115, y: 70 } },
        ]
        for (const { to, end } of cases) {
            const segment = arrowSegment(from, to)
            expect(segment).not.toBeNull()
            expect(segment!.x1).toBeCloseTo(50, 6)
            expect(segment!.y1).toBeCloseTo(70, 6)
            expect(segment!.x2).toBeCloseTo(end.x, 6)
            expect(segment!.y2).toBeCloseTo(end.y, 6)
        }
    })

    it('points from the first centre toward the second when one box lies inside the other', () => {
        const segment = arrowSegment({ x: 0, y: 0, width: 100, height: 100 }, { x: 60, y: 10, width: 20, height: 20 })
        expect(segment).toEqual({ x1: 50, y1: 50, x2: 70, y2: 20 })
    })

    it('keeps a finite, correctly directed segment for centres that differ by a fraction of a point', () => {
        const segment = arrowSegment(from, { ...from, x: from.x + 0.25, y: from.y - 0.25 })
        expect(segment).not.toBeNull()
        for (const value of Object.values(segment!)) expect(Number.isFinite(value)).toBe(true)
        expect(segment!.x2 - segment!.x1).toBeCloseTo(0.25, 9)
        expect(segment!.y2 - segment!.y1).toBeCloseTo(-0.25, 9)
    })

    it('draws no direction for truly coincident centres or an empty box', () => {
        expect(arrowSegment(from, from)).toBeNull()
        expect(arrowSegment(from, { x: 40, y: 50, width: 20, height: 40 })).toBeNull()
        expect(arrowSegment(from, { x: 220, y: 40, width: 0, height: 60 })).toBeNull()
        expect(arrowSegment(from, { x: 220, y: 40, width: 60, height: 0 })).toBeNull()
        expect(arrowSegment(from, { x: Number.NaN, y: 40, width: 60, height: 60 })).toBeNull()
    })
})

describe('arrowSegment at the width a half-width phone pane really has', () => {
    // The refusal comparison and the evidence pair give each image about 171 points at 390 points of screen, so a
    // 600 x 400 photo is 171 x 114 there. The synthetic divider boxes (next, target) leave a narrow gap at that size.
    type Box = { x: number; y: number; width: number; height: number }
    const scale = (box: Box, width: number, height: number): Box => ({
        x: box.x * width,
        y: box.y * height,
        width: box.width * width,
        height: box.height * height,
    })
    const NEXT = { x: 0.52, y: 0.58, width: 0.38, height: 0.16 }
    const TARGET = { x: 0.26, y: 0.2, width: 0.2, height: 0.62 }

    it('fits the arrow to the actual gap instead of dropping it, without moving either box', () => {
        const from = scale(NEXT, 171, 114)
        const to = scale(TARGET, 171, 114)
        const segment = arrowSegment(from, to)
        expect(segment).not.toBeNull()
        const length = Math.hypot(segment!.x2 - segment!.x1, segment!.y2 - segment!.y1)
        expect(length).toBeGreaterThanOrEqual(MIN_EDGE_GAP)
        expect(length).toBeLessThan(20)
        // It leaves the next part's edge and arrives on the target's edge, never inside or beyond either box.
        const onEdge = (x: number, y: number, box: Box): boolean => {
            const inX = x >= box.x - 1e-6 && x <= box.x + box.width + 1e-6
            const inY = y >= box.y - 1e-6 && y <= box.y + box.height + 1e-6
            const edgeX = Math.abs(x - box.x) < 1e-6 || Math.abs(x - (box.x + box.width)) < 1e-6
            const edgeY = Math.abs(y - box.y) < 1e-6 || Math.abs(y - (box.y + box.height)) < 1e-6
            return inX && inY && (edgeX || edgeY)
        }
        expect(onEdge(segment!.x1, segment!.y1, from)).toBe(true)
        expect(onEdge(segment!.x2, segment!.y2, to)).toBe(true)
        expect(segment!.x2).toBeLessThan(segment!.x1)
    })

    it('switches from the edge gap to the centre line only when the clear gap drops below the readable minimum', () => {
        const box = { x: 100, y: 40, width: 40, height: 40 }
        const just = (gap: number): ReturnType<typeof arrowSegment> =>
            arrowSegment(box, { ...box, x: box.x - box.width - gap })
        // 9 points clear: edge to edge, 9 long. 7 points clear: centre to centre, 47 long, still pointing left.
        const edge = just(MIN_EDGE_GAP + 1)!
        expect(edge.x1 - edge.x2).toBeCloseTo(MIN_EDGE_GAP + 1, 6)
        const centre = just(MIN_EDGE_GAP - 1)!
        expect(centre.x1).toBeCloseTo(120, 6)
        expect(centre.x1 - centre.x2).toBeCloseTo(40 + MIN_EDGE_GAP - 1, 6)
    })
})

describe('guidanceNotes', () => {
    it('tags the very lines partGuidance names, in the same order and words', () => {
        const guidance = partGuidance({ ...next(), ...target() }, NAMES)
        expect(guidanceNotes(guidance).map((note) => note.text)).toEqual(guidance.captions)
        expect(guidanceNotes(guidance).map((note) => note.kind)).toEqual(['next', 'target', 'move'])
    })

    it('has no move line without an arrow, and no lines without guidance', () => {
        expect(
            guidanceNotes(partGuidance({ ...next('divider'), ...target('side-panel') }, NAMES)).map((n) => n.kind),
        ).toEqual(['next', 'target'])
        expect(guidanceNotes(partGuidance(null, NAMES))).toEqual([])
    })
})

describe('a returned pair with overlapping or touching boxes', () => {
    it('keeps the arrow and the Move line, because the part and a direction are both real', () => {
        const overlapping = { x: 0.2, y: 0.25, width: 0.2, height: 0.3 }
        const guidance = partGuidance({ ...next('divider', NEXT_BOX), ...target('divider', overlapping) }, NAMES)
        expect(guidance.arrow).toBe(true)
        expect(guidance.next?.box).toEqual(NEXT_BOX)
        expect(guidance.target?.box).toEqual(overlapping)
        expect(guidance.captions).toContain('Move Wooden divider to the marked area')
    })
})
