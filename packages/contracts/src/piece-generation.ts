import { z } from 'zod'
import { pieceIdSchema, PIECE_SPEC_LIMITS, pieceSpecSchema } from './piece-spec'

export const PIECE_GEOMETRY_PROMPT_VERSION = 9
/** Invalidates cached crops/geometry when deterministic crop selection changes, without changing the model prompt. */
export const PIECE_CROP_VERSION = 2
/** Top-left normalized drawing rectangle on the cited source page. Malformed optional hints are omitted. */
export const pieceDrawingBoxSchema = z
    .tuple([
        z.number().finite().min(0).max(1),
        z.number().finite().min(0).max(1),
        z.number().finite().positive().max(1),
        z.number().finite().positive().max(1),
    ])
    .refine(([x, y, width, height]) => x + width <= 1 && y + height <= 1)
export const optionalPieceDrawingBoxSchema = pieceDrawingBoxSchema.nullable().optional().catch(undefined)

export const PIECE_BATCH_LIMIT = 8
export const PIECE_CUTOUT_MAX_CHARS = 360_000
export const pieceCutoutSchema = z
    .string()
    .max(PIECE_CUTOUT_MAX_CHARS)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u)
const issueCode = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9_.:-]+$/u)
export const manualPieceInputSchema = z.strictObject({
    id: pieceIdSchema,
    name: z.string().trim().min(1).max(80),
    quantity: z.number().int().positive().max(100_000).nullable(),
    label: z.string().trim().min(1).max(80).nullable(),
    dimensions: z.string().trim().min(1).max(300).nullable(),
    /** Other inventory names are exclusion hints, never instructions or additional geometry requests. */
    notPartOfThisPiece: z.array(z.string().trim().min(1).max(80)).max(PIECE_SPEC_LIMITS.pieces).optional(),
    pageId: z.string().min(1).max(128).nullable(),
    drawingBox: optionalPieceDrawingBoxSchema,
    /** Broader cited step figure used as context only when no own drawing is available. */
    figureBox: optionalPieceDrawingBoxSchema,
    cutoutUri: pieceCutoutSchema.nullable().optional(),
    repair: z.strictObject({ issueCodes: z.array(issueCode).min(1).max(40) }).optional(),
})
export type ManualPieceInput = z.infer<typeof manualPieceInputSchema>
export const pieceBatchRequestSchema = z
    .strictObject({
        requestId: z.string().min(1).max(128),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
        parts: z.array(manualPieceInputSchema).min(1).max(PIECE_BATCH_LIMIT),
        pages: z
            .array(
                z.strictObject({
                    pageId: z.string().min(1).max(128),
                    width: z.number().int().positive().max(24_000_000),
                    height: z.number().int().positive().max(24_000_000),
                    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
                }),
            )
            .max(8),
    })
    .superRefine((value, context) => {
        if (new Set(value.parts.map((part) => part.id)).size !== value.parts.length)
            context.addIssue({ code: 'custom', message: 'Piece ids must be unique' })
        if (new Set(value.pages.map((page) => page.pageId)).size !== value.pages.length)
            context.addIssue({ code: 'custom', message: 'Page ids must be unique' })
        if (value.pages.some((page) => page.width * page.height > 24_000_000))
            context.addIssue({ code: 'custom', message: 'Page pixel limit' })
        if (
            value.parts.some((part) => part.pageId !== null && !value.pages.some((page) => page.pageId === part.pageId))
        )
            context.addIssue({ code: 'custom', message: 'A piece references an unavailable page' })
    })
export type PieceBatchRequest = z.infer<typeof pieceBatchRequestSchema>
export const pieceBatchResultSchema = z
    .strictObject({
        contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
        results: z
            .array(
                z.strictObject({
                    id: pieceIdSchema,
                    name: z.string().min(1).max(80),
                    status: z.enum(['passed', 'repaired', 'invalid']),
                    piece: pieceSpecSchema.nullable(),
                    cutoutUri: pieceCutoutSchema.nullable(),
                    issueCodes: z.array(issueCode).max(40),
                }),
            )
            .min(1)
            .max(PIECE_BATCH_LIMIT),
        model: z.literal('muse-wonder-1.0').nullable(),
        effort: z.literal('high').nullable(),
        durationMs: z.number().finite().nonnegative(),
    })
    .superRefine((value, context) => {
        if (new Set(value.results.map((result) => result.id)).size !== value.results.length)
            context.addIssue({ code: 'custom', message: 'Result ids must be unique' })
        for (const result of value.results) {
            const accepted = result.status !== 'invalid'
            if (accepted !== (result.piece !== null) || accepted !== (result.issueCodes.length === 0))
                context.addIssue({ code: 'custom', message: 'Piece status must match validation' })
            if (result.piece !== null && (result.piece.id !== result.id || result.piece.name !== result.name))
                context.addIssue({ code: 'custom', message: 'A piece must retain its requested identity' })
            if (accepted && (value.model !== 'muse-wonder-1.0' || value.effort !== 'high'))
                context.addIssue({ code: 'custom', message: 'A generated piece requires observed Wonder provenance' })
        }
    })
export type PieceBatchResult = z.infer<typeof pieceBatchResultSchema>
