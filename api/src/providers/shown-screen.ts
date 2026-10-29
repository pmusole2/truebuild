import { MANUAL_FACT_LIMIT, SCREEN_LIMITS } from '@truebuild/contracts'
import { z } from 'zod'

/**
 * What a person was actually shown on a generated step page, as the server hands it to a check, question or overlay
 * call. It is derived only from the published, validated document the server issued and is re-verified against the
 * current manual before it is sent: the model never sees a draft, a client-supplied text or geometry that is not the
 * manual's own. Every list is bounded by the screen catalog, so this payload is finite by construction.
 */
const box = z.strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
})
const id = z.string().min(1).max(128)
const sourceRef = z.strictObject({ pageId: id, region: box.nullable() })
const shownAction = z.strictObject({
    label: z.string().min(1).max(SCREEN_LIMITS.action),
    intent: z.string().min(1).max(24),
    target: z.string().min(1).max(24),
})

export const shownBlockSchema = z.strictObject({
    /** Canonical component path in the document: `body.<i>` or `body.<i>.children.<j>`. */
    path: z.string().regex(/^body\.\d{1,2}(?:\.children\.\d)?$/u),
    type: z.string().min(1).max(32),
    /** `generated`: the model chose it and the server accepted it unchanged. `fallback`: the server wrote or changed it. */
    origin: z.enum(['generated', 'fallback']),
    emphasis: z.enum(['normal', 'strong', 'quiet']).optional(),
    tone: z.enum(['caution', 'critical']).optional(),
    /** Only wording that is closed interface copy or the manual's own words; otherwise omitted. */
    text: z.string().min(1).max(500).optional(),
    label: z.string().min(1).max(60).optional(),
    parts: z
        .array(z.strictObject({ partId: id, label: z.string().min(1).max(60), quantity: z.number().int().nullable() }))
        .max(SCREEN_LIMITS.listItems)
        .optional(),
    /** Complete manual facts this block shows, by id; their text is in the screen's `facts`. */
    factIds: z.array(z.string().min(1).max(160)).max(MANUAL_FACT_LIMIT).optional(),
    /** The figure a hero shows and the manual's own region the model chose to emphasize (never model geometry). */
    figure: z
        .strictObject({
            source: z.enum(['page', 'capture', 'part']),
            refId: id,
            fit: z.enum(['cover', 'contain']),
            region: box.nullable(),
        })
        .optional(),
    /** Manual pages and figure regions this block cites. */
    sources: z.array(sourceRef).max(SCREEN_LIMITS.citations).optional(),
})
export type ShownBlock = z.infer<typeof shownBlockSchema>

export const shownScreenSchema = z.strictObject({
    header: z
        .strictObject({ title: z.string().min(1).max(200), subtitle: z.string().min(1).max(200).nullable() })
        .optional(),
    bar: z.strictObject({ primary: shownAction, secondary: shownAction.nullable() }).optional(),
    /** Every body block, containers first then their children, in document order. */
    blocks: z.array(shownBlockSchema).max(SCREEN_LIMITS.totalNodes),
    /** Required manual facts the document did not place in its body; the app shows them in the mandatory section. */
    remainderFactIds: z.array(z.string().min(1).max(160)).max(MANUAL_FACT_LIMIT),
})
export type ShownScreen = z.infer<typeof shownScreenSchema>

/** Facts of the step that were on the shown page: manual facts and witnessed texts together (see `shownScreenSchema`). */
export const SHOWN_FACT_LIMIT = MANUAL_FACT_LIMIT + SCREEN_LIMITS.totalNodes
