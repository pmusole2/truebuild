import { PIECE_SPEC_LIMITS, pieceSpecSchema } from '@truebuild/contracts'
import { z } from 'zod'

const envelopeSchema = pieceSpecSchema.omit({ parts: true }).extend({
    parts: z.array(z.unknown()).min(1).max(PIECE_SPEC_LIMITS.parts),
})
const partSchema = pieceSpecSchema.shape.parts.element
type Part = z.infer<typeof partSchema>
type RecordValue = Record<string, unknown>

function object(value: unknown): value is RecordValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function point(value: unknown): value is [number, number] {
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((coordinate: unknown) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    )
}

/** Remove adjacent exact points only; nonadjacent repeats and malformed points still reach the strict validator. */
function normalizePart(value: unknown): unknown {
    if (!object(value)) return value
    const key = value.type === 'lathe' ? 'profile' : value.type === 'extrude' ? 'outline' : null
    if (key === null || !Array.isArray(value[key])) return value
    const points: unknown[] = []
    for (const current of value[key]) {
        const previous = points[points.length - 1]
        if (point(current) && point(previous) && current[0] === previous[0] && current[1] === previous[1]) continue
        points.push(current)
    }
    return { ...value, [key]: points }
}

function bounded(value: unknown, maximum: number = PIECE_SPEC_LIMITS.extent): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null
}

/**
 * Intrinsic axis-aligned bounding-box volume, before placement/rotation. A zero placeholder has zero size. Unknown or
 * malformed dimensions have no safe rank, so they disable the largest-part exception rather than disappearing from it.
 */
function sizeOf(value: unknown): number | null {
    if (!object(value)) return null
    const d = object(value.dimensions) ? value.dimensions : null
    if (value.type === 'lathe' || value.type === 'extrude') {
        const points: unknown = value.type === 'lathe' ? value.profile : value.outline
        if (!Array.isArray(points) || points.length === 0 || !points.every(point)) return null
        const first = points[0]!
        let minX = first[0],
            maxX = first[0],
            minY = first[1],
            maxY = first[1]
        for (const [x, y] of points) {
            if (
                Math.abs(x) > PIECE_SPEC_LIMITS.extent ||
                Math.abs(y) > PIECE_SPEC_LIMITS.extent ||
                (value.type === 'lathe' && x < 0)
            )
                return null
            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x)
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
        }
        if (value.type === 'lathe') return (2 * maxX) ** 2 * (maxY - minY)
        const depth = bounded(value.depth)
        const bevel =
            value.bevel == null ? 0 : bounded(value.bevel, PIECE_SPEC_LIMITS.extent * PIECE_SPEC_LIMITS.bevelRatio)
        return depth === null || bevel === null
            ? null
            : (maxX - minX + 2 * bevel) * (maxY - minY + 2 * bevel) * (depth + 2 * bevel)
    }
    if (d === null) return null
    const radius = bounded(d.radius),
        height = bounded(d.height)
    switch (value.type) {
        case 'box': {
            const width = bounded(d.width),
                depth = bounded(d.depth)
            return width === null || height === null || depth === null ? null : width * height * depth
        }
        case 'cylinder':
        case 'cone':
            return radius === null || height === null ? null : (2 * radius) ** 2 * height
        case 'sphere':
            return radius === null ? null : (2 * radius) ** 3
        case 'torus': {
            const tube = bounded(d.tube)
            return radius === null || tube === null ? null : (2 * (radius + tube)) ** 2 * (2 * tube)
        }
        case 'capsule': {
            const length = bounded(d.length)
            return radius === null || length === null ? null : (2 * radius) ** 2 * (length + 2 * radius)
        }
        default:
            return null
    }
}

export interface PieceSalvage {
    parsed: ReturnType<typeof pieceSpecSchema.safeParse>
    droppedParts: { index: number; issueCodes: string[] }[]
    originalPartCount: number | null
    retainedPartCount: number
    retention: 'all' | 'count' | 'largest' | 'rejected' | 'invalid-piece'
    salvaged: boolean
}

/** A piece retains its strict envelope and identity; only individually invalid parts may be discarded. */
export function salvagePiece(value: unknown): PieceSalvage {
    const envelope = envelopeSchema.safeParse(value)
    if (!envelope.success)
        return {
            parsed: pieceSpecSchema.safeParse(value),
            droppedParts: [],
            originalPartCount: null,
            retainedPartCount: 0,
            retention: 'invalid-piece',
            salvaged: false,
        }
    const normalized = envelope.data.parts.map(normalizePart)
    const kept: Part[] = []
    const valid: boolean[] = []
    const droppedParts: PieceSalvage['droppedParts'] = []
    for (const [index, part] of normalized.entries()) {
        const parsed = partSchema.safeParse(part)
        valid.push(parsed.success)
        if (parsed.success) kept.push(parsed.data)
        else
            droppedParts.push({
                index,
                // Part indices are original; point paths refer to the normalized geometry that was validated.
                issueCodes: parsed.error.issues
                    .slice(0, 40)
                    .map(
                        (issue) =>
                            `parts.${index}${issue.path.length === 0 ? '' : '.' + issue.path.map(String).join('.')}:${issue.code}`,
                    ),
            })
    }
    const sizes = normalized.map(sizeOf)
    const largest = sizes.every((size): size is number => size !== null) ? Math.max(...sizes) : null
    const countEnough = kept.length * 2 >= normalized.length
    const largestValid =
        largest !== null && largest > 0 && sizes.every((size, index) => size !== largest || valid[index])
    const retention: PieceSalvage['retention'] =
        kept.length === 0
            ? 'rejected'
            : droppedParts.length === 0
              ? 'all'
              : countEnough
                ? 'count'
                : largestValid
                  ? 'largest'
                  : 'rejected'
    const retained = retention !== 'rejected'
    const parsed = pieceSpecSchema.safeParse({ ...envelope.data, parts: retained ? kept : normalized })
    return {
        parsed,
        droppedParts,
        originalPartCount: normalized.length,
        retainedPartCount: parsed.success ? kept.length : 0,
        retention,
        salvaged: parsed.success && droppedParts.length > 0,
    }
}
