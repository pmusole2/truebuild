import { z } from 'zod'
import { canonicalJson, sourceRefSchema } from './index'
import { pieceDrawingBoxSchema } from './piece-generation'
import { extrudeBevelLimit, PIECE_SPEC_LIMITS, pieceSpecSchema } from './piece-spec'
import { parseLanguageSchema } from './reading-language'

export const STEP_MOTION_PROMPT_VERSION = 4
/** Ten percent on each side, clamped to the cited page, keeps nearby movement marks in the crop. */
export function paddedStepFigureBox(box: readonly [number, number, number, number]): [number, number, number, number] {
    const [x, y, width, height] = box
    const left = Math.max(0, x - width * 0.1)
    const top = Math.max(0, y - height * 0.1)
    return [left, top, Math.min(1, x + width * 1.1) - left, Math.min(1, y + height * 1.1) - top]
}
const id = z.string().min(1).max(128)
const coordinate = z.number().finite().min(-PIECE_SPEC_LIMITS.extent).max(PIECE_SPEC_LIMITS.extent)
const vector = z.tuple([coordinate, coordinate, coordinate])
const component = z.number().finite().min(-1).max(1)
const axis = z
    .tuple([component, component, component])
    .refine((value) => Math.abs(Math.hypot(...value) - 1) <= 0.001, { message: 'Axis must be a unit vector' })
const degrees = z.number().finite().min(-180).max(180)
const motion = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('rotate'), pivot: vector, axis, fromDeg: degrees, toDeg: degrees }),
    z.strictObject({ kind: z.literal('translate'), from: vector, to: vector }),
    z.strictObject({
        kind: z.literal('screw'),
        axis,
        travel: z.number().finite().min(-100).max(100),
        turns: z.number().finite().min(-4).max(4),
    }),
])

/** Shared piece primitives, including their strict geometric refinements after generated-output normalization. */
const shape = pieceSpecSchema.shape.parts.element
const plain = (max: number): z.ZodString =>
    z
        .string()
        .min(1)
        .max(max)
        .regex(/^[^\r\n<>`]+$/u)
const scene = z.strictObject({
    version: z.literal(1),
    stepId: id,
    still: z.array(shape).min(1).max(24),
    movers: z
        .array(
            z.strictObject({
                label: plain(80),
                shapes: z.array(shape).min(1).max(16),
                motion,
                actionIndex: z.number().int().min(0).max(31).nullable(),
            }),
        )
        .min(1)
        .max(3),
    caption: plain(160),
})

/**
 * All shapes describe their finished positions in one frame, with Y up. At completion every mover has the identity
 * transform. Rotate uses interpolated degrees minus toDeg about pivot. Translate uses interpolated from/to minus to.
 * Screw rotates about the mover's finished bounding-box centre and travels from -axis * travel, unwinding turns to 0.
 */
export const stepMotionSceneSchema = scene.nullable()
export type StepMotionScene = z.infer<typeof scene>
export const stepMotionResultSchema = z.strictObject({ scene: stepMotionSceneSchema })
export type StepMotionResult = z.infer<typeof stepMotionResultSchema>

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
const isFinitePoint = (value: unknown): value is [number, number] =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part))

function clampShapeBevel(shape: unknown): unknown {
    if (
        !isRecord(shape) ||
        shape.type !== 'extrude' ||
        typeof shape.bevel !== 'number' ||
        !Number.isFinite(shape.bevel)
    )
        return shape
    const { depth, outline } = shape
    if (typeof depth !== 'number' || !Array.isArray(outline) || outline.length < 3) return shape
    if (outline.length > PIECE_SPEC_LIMITS.outlinePoints || !outline.every(isFinitePoint)) return shape
    const limit = extrudeBevelLimit(depth, outline)
    return { ...shape, bevel: Math.min(Math.max(shape.bevel, 0), limit) }
}

/**
 * Clamps each extrude bevel in a generated result to its limit, so one oversized bevel does not refuse the whole scene.
 * Only bevels are touched; every other field still decides acceptance. Anything unrecognised passes through unchanged.
 */
export function clampStepMotionBevels(value: unknown): unknown {
    if (!isRecord(value)) return value
    const scene = value.scene
    if (!isRecord(scene)) return value
    const shapes = (list: unknown): unknown => (Array.isArray(list) ? list.map(clampShapeBevel) : list)
    return {
        ...value,
        scene: {
            ...scene,
            still: shapes(scene.still),
            movers: Array.isArray(scene.movers)
                ? scene.movers.map((mover: unknown) =>
                      isRecord(mover) ? { ...mover, shapes: shapes(mover.shapes) } : mover,
                  )
                : scene.movers,
        },
    }
}

/**
 * Remove only exact adjacent/closing duplicates (the polygon is unchanged), then discard otherwise bounded extrudes
 * with no area or sub-renderable depth. Malformed, crossing and unsupported shapes still fail the strict schema.
 */
export function dropDegenerateStepMotionShapes(value: unknown): unknown {
    if (!isRecord(value) || !isRecord(value.scene)) return value
    const dropped = Symbol('degenerate')
    const normalize = (candidate: unknown): unknown => {
        if (!isRecord(candidate) || candidate.type !== 'extrude') return candidate
        const { outline, depth } = candidate
        if (
            !Array.isArray(outline) ||
            outline.length < 3 ||
            outline.length > PIECE_SPEC_LIMITS.outlinePoints ||
            !outline.every(isFinitePoint) ||
            outline.some((point) => point.some((n) => Math.abs(n) > PIECE_SPEC_LIMITS.extent))
        )
            return candidate
        const points = outline.filter(
            (point, index) => index === 0 || point[0] !== outline[index - 1]![0] || point[1] !== outline[index - 1]![1],
        )
        if (points.length > 1 && points[0]![0] === points.at(-1)![0] && points[0]![1] === points.at(-1)![1])
            points.pop()
        const normalized = { ...candidate, outline: points }
        if (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0 || depth > PIECE_SPEC_LIMITS.extent)
            return normalized
        // A longest baseline is independent of the first vertex/edge. Only roundoff-sized distances count as
        // collinear: a short initial edge must never turn a thin, nonzero-area outline into a discarded shape.
        let first = points[0]!
        let second = first
        let longest = 0
        for (const a of points)
            for (const b of points) {
                const distance = Math.hypot(b[0] - a[0], b[1] - a[1])
                if (distance > longest) {
                    first = a
                    second = b
                    longest = distance
                }
            }
        const epsilon = Number.EPSILON * 16 * Math.max(1, longest, ...points.flatMap((point) => point.map(Math.abs)))
        const collinear =
            longest === 0 ||
            points.every(
                (point) =>
                    Math.abs(
                        (second[0] - first[0]) * (point[1] - first[1]) - (second[1] - first[1]) * (point[0] - first[0]),
                    ) /
                        longest <=
                    epsilon,
            )
        if (!collinear && depth >= PIECE_SPEC_LIMITS.minDimension) return normalized
        const probe = {
            ...normalized,
            depth: Math.max(depth, PIECE_SPEC_LIMITS.minDimension),
            ...(collinear
                ? {
                      outline: [
                          [0, 0],
                          [1, 0],
                          [0, 1],
                      ],
                  }
                : {}),
        }
        // Validate every other field before dropping anything, including unknown keys, positions, rotations and bevel.
        return shape.safeParse(probe).success ? dropped : normalized
    }
    const shapes = (list: unknown, limit: number): unknown =>
        Array.isArray(list) && list.length <= limit
            ? list.map(normalize).filter((candidate) => candidate !== dropped)
            : list
    return {
        ...value,
        scene: {
            ...value.scene,
            still: shapes(value.scene.still, 24),
            movers: Array.isArray(value.scene.movers)
                ? value.scene.movers.map((mover: unknown) =>
                      isRecord(mover) ? { ...mover, shapes: shapes(mover.shapes, 16) } : mover,
                  )
                : value.scene.movers,
        },
    }
}

/** Verbatim source text is data: it is bounded without trimming, translation or rewriting. */
export const stepMotionRequestSchema = z
    .strictObject({
        requestId: id,
        /** Cache-only recovery cannot dispatch, including when no completed scene exists. */
        cacheOnly: z.boolean().optional(),
        manualHash: z.string().regex(/^[a-f0-9]{64}$/u),
        stepId: id,
        readingLanguage: parseLanguageSchema,
        instructionText: z.string().min(1).max(16_000),
        sourceRefs: z
            .array(z.lazy(() => sourceRefSchema))
            .min(1)
            .max(100),
        parts: z
            .array(
                z.strictObject({
                    id,
                    name: z.string().min(1).max(200),
                    quantity: z.number().int().positive().max(100_000).nullable(),
                }),
            )
            .max(256),
        actions: z.array(z.string().min(1).max(2000)).max(32),
        orientation: z.string().min(1).max(4000).nullable(),
        connection: z.string().min(1).max(4000).nullable(),
        page: z.strictObject({
            pageId: id,
            width: z.number().int().positive().max(24_000_000),
            height: z.number().int().positive().max(24_000_000),
            mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
            /** SHA-256 of the uploaded original bytes: the server verifies it before any scene is generated. */
            contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
        }),
        figureBox: pieceDrawingBoxSchema.nullable(),
    })
    .superRefine((value, context) => {
        if (!value.sourceRefs.some((ref) => ref.pageId === value.page.pageId))
            context.addIssue({ code: 'custom', message: 'The figure page must be cited by this step' })
        const regions = value.sourceRefs.flatMap((ref) =>
            ref.pageId === value.page.pageId && ref.region !== null ? [ref.region] : [],
        )
        const matches = (candidate: readonly number[]): boolean =>
            value.figureBox !== null &&
            candidate.every((coordinate, index) => Math.abs(coordinate - value.figureBox![index]!) < 1e-9)
        const grounded =
            regions.length === 0
                ? value.figureBox === null || matches([0, 0, 1, 1])
                : regions.some((box) => {
                      const original: [number, number, number, number] = [box.x, box.y, box.width, box.height]
                      return matches(original) || matches(paddedStepFigureBox(original))
                  })
        if (!grounded)
            context.addIssue({
                code: 'custom',
                message: 'A figure crop must follow its cited source region or use an uncropped page when none exists',
            })
        if (value.page.width * value.page.height > 24_000_000)
            context.addIssue({ code: 'custom', message: 'Page pixel limit' })
        if (new Set(value.parts.map((part) => part.id)).size !== value.parts.length)
            context.addIssue({ code: 'custom', message: 'Part ids must be unique' })
    })
export type StepMotionRequest = z.infer<typeof stepMotionRequestSchema>

/** All scene evidence is cache identity; transport ids and cache-only lookup do not change its meaning. */
export function stepMotionCacheContent(request: StepMotionRequest): Omit<StepMotionRequest, 'requestId' | 'cacheOnly'> {
    const { requestId: _requestId, cacheOnly: _cacheOnly, ...content } = request
    return content
}

/** The one canonical text both sides hash for a scene's content identity: device and server must never diverge here. */
export function stepMotionCacheIdentity(
    request: StepMotionRequest,
    promptVersion = STEP_MOTION_PROMPT_VERSION,
): string {
    return canonicalJson([promptVersion, stepMotionCacheContent(request)])
}
