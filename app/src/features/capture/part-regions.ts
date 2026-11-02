import { partRegionSchema, type NormalizedBox } from '@truebuild/contracts'
import type { Rect } from '../assembly/frame-geometry'

/** A real part of the current step, located on the observation photo exactly as the response returned it. */
export type LocatedPart = { readonly partId: string; readonly name: string; readonly box: NormalizedBox }

export type PartGuidance = {
    readonly next: LocatedPart | null
    readonly target: LocatedPart | null
    // True only when both regions are valid and belong to the same step part. Never inferred from anything else.
    readonly arrow: boolean
    // Plain-text names for what is drawn, so the overlay never depends on stroke style or colour alone.
    readonly captions: readonly string[]
}

/** What a caption line is about, so the view can style the instruction apart from the legend without parsing text. */
export type GuidanceNote = { readonly kind: 'next' | 'target' | 'move'; readonly text: string }

const NO_GUIDANCE: PartGuidance = Object.freeze({ next: null, target: null, arrow: false, captions: [] })

function located(value: unknown, names: ReadonlyMap<string, string>): LocatedPart | null {
    const parsed = partRegionSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    // A part outside the current step has no validated manual name, so nothing is drawn or named for it.
    const name = names.get(parsed.data.partId)
    return name === undefined ? null : { partId: parsed.data.partId, name, box: parsed.data.region }
}

/**
 * The next-part and target regions of a check or answer, validated one by one. Absence, an invalid box or a part that
 * is not in the current step removes only that region. Nothing is synthesised, moved or paired up by guesswork.
 * `names` holds the current step's validated manual part names keyed by part id.
 */
export function partGuidance(result: unknown, names: ReadonlyMap<string, string>): PartGuidance {
    if (typeof result !== 'object' || result === null) {
        return NO_GUIDANCE
    }
    const next = located(Reflect.get(result, 'nextPartRegion'), names)
    const target = located(Reflect.get(result, 'targetRegion'), names)
    if (next === null && target === null) {
        return NO_GUIDANCE
    }
    // Two boxes around one centre give no direction, so no arrow and no "Move" instruction is claimed for them.
    const arrow =
        next !== null && target !== null && next.partId === target.partId && distinctCentres(next.box, target.box)
    return { next, target, arrow, captions: guidanceLines(next, target, arrow).map((line) => line.text) }
}

function guidanceLines(next: LocatedPart | null, target: LocatedPart | null, arrow: boolean): GuidanceNote[] {
    return [
        ...(next === null ? [] : [{ kind: 'next' as const, text: `Next part: ${next.name}` }]),
        ...(target === null ? [] : [{ kind: 'target' as const, text: `Target for ${target.name}` }]),
        ...(arrow && next !== null ? [{ kind: 'move' as const, text: `Move ${next.name} to the marked area` }] : []),
    ]
}

/** The same lines as `captions`, in the same order and words, tagged by what they describe. */
export function guidanceNotes(guidance: PartGuidance): GuidanceNote[] {
    return guidanceLines(guidance.next, guidance.target, guidance.arrow)
}

// Normalized centre distance below which two returned boxes are treated as one place (a tenth of a percent of the photo).
const COINCIDENT_CENTRE = 0.001

function distinctCentres(a: NormalizedBox, b: NormalizedBox): boolean {
    return (
        Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2)) >
        COINCIDENT_CENTRE
    )
}

export type ArrowSegment = { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }

// An edge-to-edge arrow needs at least this much clear space between the two boxes to read as a shaft and a head.
// With less (touching, overlapping or a hairline gap) the arrow runs between the two centres instead, so a valid
// pair of regions never turns into no arrow at all.
export const MIN_EDGE_GAP = 8

/** Fraction of the centre-to-centre line that lies inside a box. */
function exitFraction(box: Rect, dx: number, dy: number): number {
    const alongX = dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx)
    const alongY = dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy)
    return Math.min(alongX, alongY)
}

/**
 * A straight segment between two returned boxes, on the line between their centres. When the boxes leave a readable
 * gap it runs from the edge of `from` to the edge of `to`. When they touch, overlap or leave only a hairline, it runs
 * from the centre of `from` to the centre of `to`: still grounded in the returned boxes, which are never moved or
 * grown, and the drawn head and shaft scale to whatever length that is. Empty boxes and truly coincident centres,
 * which have no direction, return null.
 */
export function arrowSegment(from: Rect, to: Rect): ArrowSegment | null {
    if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) {
        return null
    }
    const x1 = from.x + from.width / 2
    const y1 = from.y + from.height / 2
    const dx = to.x + to.width / 2 - x1
    const dy = to.y + to.height / 2 - y1
    const distance = Math.hypot(dx, dy)
    if (!Number.isFinite(distance) || distance === 0) {
        return null
    }
    const leave = exitFraction(from, dx, dy)
    const arrive = exitFraction(to, dx, dy)
    if ((1 - leave - arrive) * distance < MIN_EDGE_GAP) {
        return { x1, y1, x2: x1 + dx, y2: y1 + dy }
    }
    return { x1: x1 + dx * leave, y1: y1 + dy * leave, x2: x1 + dx * (1 - arrive), y2: y1 + dy * (1 - arrive) }
}
