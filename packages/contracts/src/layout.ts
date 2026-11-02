import { z } from 'zod'

export const LAYOUT_LIMITS = { components: 8, references: 8 } as const

const id = z.string().trim().min(1).max(128)
const ids = z.array(id).min(1).max(LAYOUT_LIMITS.references)

/**
 * Closed set of renderer components. Every field is an id or index into the current step's validated data;
 * no component carries text, style, markup, URL or code, so a model can only choose what to show, never what it says.
 */
export const layoutComponentSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('part_grid'), partIds: ids }),
    z.strictObject({ type: z.literal('orientation'), partId: id }),
    z.strictObject({ type: z.literal('connection'), partIds: ids }),
    z.strictObject({ type: z.literal('visible_checks'), checkIds: ids }),
    z.strictObject({
        type: z.literal('source_diagram'),
        sourceRefIndexes: z.array(z.number().int().min(0).max(99)).min(1).max(LAYOUT_LIMITS.references),
    }),
    z.strictObject({ type: z.literal('recovery'), actionIds: ids }),
])

export type LayoutComponent = z.infer<typeof layoutComponentSchema>

function rejectRepeats(components: readonly LayoutComponent[], ctx: z.RefinementCtx): void {
    if (new Set(components.map((component) => component.type)).size !== components.length) {
        ctx.addIssue({ code: 'custom', message: 'Each layout component may appear once' })
    }
    for (const component of components) {
        const references = Object.values(component).find(Array.isArray) ?? []
        if (new Set(references).size !== references.length) {
            ctx.addIssue({ code: 'custom', message: 'Duplicate layout reference' })
        }
    }
}

/** What the model may propose: ordered components only. Provenance is assigned by the server. */
export const proposedLayoutSchema = z
    .strictObject({ components: z.array(layoutComponentSchema).min(1).max(LAYOUT_LIMITS.components) })
    .superRefine((layout, ctx) => rejectRepeats(layout.components, ctx))

/** Public layout. `source` is set by the server after reference validation (absent only before resolution). */
export const layoutSchema = z
    .strictObject({
        source: z.enum(['model', 'fallback']).optional(),
        components: z.array(layoutComponentSchema).max(LAYOUT_LIMITS.components),
    })
    .superRefine((layout, ctx) => rejectRepeats(layout.components, ctx))

export type ProposedLayout = z.infer<typeof proposedLayoutSchema>
export type Layout = z.infer<typeof layoutSchema>
