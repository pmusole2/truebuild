import { z } from 'zod'
import { sourceRefSchema } from './index'
import { pieceDrawingBoxSchema } from './piece-generation'
import { PIECE_SPEC_LIMITS, pieceSpecSchema } from './piece-spec'
import { parseLanguageSchema } from './reading-language'

export const STEP_MOTION_PROMPT_VERSION = 1
const id = z.string().min(1).max(128)
const coordinate = z.number().finite().min(-PIECE_SPEC_LIMITS.extent).max(PIECE_SPEC_LIMITS.extent)
const vector = z.tuple([coordinate, coordinate, coordinate])
const component = z.number().finite().min(-1).max(1)
const axis = z
    .tuple([component, component, component])
    .refine((value) => Math.abs(Math.hypot(...value) - 1) <= 0.000001, { message: 'Axis must be a unit vector' })
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

/** Shared piece primitives, including their geometric refinements; no geometry is normalized or salvaged. */
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

/** Verbatim source text is data: it is bounded without trimming, translation or rewriting. */
export const stepMotionRequestSchema = z
    .strictObject({
        requestId: id,
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
        }),
        figureBox: pieceDrawingBoxSchema.nullable(),
    })
    .superRefine((value, context) => {
        if (!value.sourceRefs.some((ref) => ref.pageId === value.page.pageId))
            context.addIssue({ code: 'custom', message: 'The figure page must be cited by this step' })
        if (
            value.figureBox !== null &&
            !value.sourceRefs.some((ref) => {
                const box = ref.region
                return (
                    ref.pageId === value.page.pageId &&
                    box !== null &&
                    [box.x, box.y, box.width, box.height].every(
                        (coordinate, index) => coordinate === value.figureBox![index],
                    )
                )
            })
        )
            context.addIssue({ code: 'custom', message: 'A figure crop must match a cited source region' })
        if (value.page.width * value.page.height > 24_000_000)
            context.addIssue({ code: 'custom', message: 'Page pixel limit' })
        if (new Set(value.parts.map((part) => part.id)).size !== value.parts.length)
            context.addIssue({ code: 'custom', message: 'Part ids must be unique' })
    })
export type StepMotionRequest = z.infer<typeof stepMotionRequestSchema>
