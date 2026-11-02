import { DOCUMENT_V2_LIMITS, MANUAL_FACT_LIMIT, SCREEN_LIMITS } from '@truebuild/contracts'
import { z } from 'zod'

/**
 * Blocks of one projected page. A version 1 page has at most `SCREEN_LIMITS.totalNodes`; a version 2 page is a tree, and a
 * page beyond this bound is not projected (its facts still are), so the provider payload stays finite. PROVISIONAL.
 */
export const SHOWN_BLOCK_LIMIT = 160

/**
 * What a generated step page was composed to show, as the server hands it to a check, question or overlay call. It is the
 * published composition (order, layout, parts, figure, citations), NOT a claim about pixels: scrolling, a closed section
 * or the device decide what was actually in view, and a closed section is marked `collapsed`. It is derived only from the
 * published, validated document the server issued and is re-verified against the current manual before it is sent: the
 * model never sees a draft, a client-supplied text or geometry that is not the manual's own. Every list is bounded, so
 * this payload is finite by construction.
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
    /**
     * Canonical component path in the document: `body.<i>` or `body.<i>.children.<j>` (version 1), or `body` followed by
     * the child indexes (`body.0.2`, version 2).
     */
    path: z.string().regex(/^body(?:\.(?:children\.)?\d{1,2})*$/u),
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
    sources: z.array(sourceRef).max(DOCUMENT_V2_LIMITS.citationIndexes).optional(),
    /** A collapsible section that starts closed: its children were composed but are not shown until it is opened. */
    collapsed: z.literal(true).optional(),
})
export type ShownBlock = z.infer<typeof shownBlockSchema>

const shownScreenFields = {
    header: z
        .strictObject({ title: z.string().min(1).max(200), subtitle: z.string().min(1).max(200).nullable() })
        .optional(),
    bar: z.strictObject({ primary: shownAction, secondary: shownAction.nullable() }).optional(),
    /** Required manual facts the document did not place in its body; the app shows them in the mandatory section. */
    remainderFactIds: z.array(z.string().min(1).max(160)).max(MANUAL_FACT_LIMIT),
}
/** A version 1 page: at most `SCREEN_LIMITS.totalNodes` blocks, every body block in document order. */
export const shownScreenSchema = z.strictObject({
    ...shownScreenFields,
    blocks: z.array(shownBlockSchema).max(SCREEN_LIMITS.totalNodes),
})
/** A version 1 or version 2 page (a tree), bounded by `SHOWN_BLOCK_LIMIT`; what a provider call accepts. */
export const shownScreenV2Schema = z.strictObject({
    ...shownScreenFields,
    blocks: z.array(shownBlockSchema).max(SHOWN_BLOCK_LIMIT),
})
export type ShownScreen = z.infer<typeof shownScreenSchema>

/** Facts of the step that were on the shown page: manual facts and witnessed texts together (see `shownScreenSchema`). */
export const SHOWN_FACT_LIMIT = MANUAL_FACT_LIMIT + SCREEN_LIMITS.totalNodes
