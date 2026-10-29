import {
    CONTAINER_SHAPES_V2,
    CONTAINER_TYPES_V2,
    DOCUMENT_V2_LIMITS,
    LEAF_SCHEMAS_V2,
    VARIANT_STATES,
    barV2Schema,
    headerV2Schema,
    overlayV2Schema,
    screenProposalV2Schema,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenVariantV2,
} from '@truebuild/contracts'
import { z } from 'zod'

/**
 * The provider wire format of a version 2 document. The strict provider schema is finite (no `$ref`, no recursion, a
 * bounded nesting depth), so the model returns a FLAT node table: every node has an `id` and containers list the ids
 * of their children. `decodeWireProposal` rebuilds exactly the recursive tree the model described and nothing more:
 * it never adds, drops, reorders or rewrites a node. The recursive `screenProposalV2Schema` then validates the tree.
 */
const wireId = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,12}$/u)

const wireLeaves = LEAF_SCHEMAS_V2.map((schema) => schema.extend({ id: wireId }))
const wireContainers = CONTAINER_TYPES_V2.map((type) =>
    z.strictObject({
        type: z.literal(type),
        id: wireId,
        ...CONTAINER_SHAPES_V2[type],
        children: z.array(wireId).max(DOCUMENT_V2_LIMITS.children),
    }),
)
interface WireNode {
    id: string
    type: string
    children?: string[]
    [property: string]: unknown
}
// Typed loosely on purpose: the precise per-type shape is enforced at runtime by the discriminated union.
const wireNodeSchema = z.discriminatedUnion('type', [...wireLeaves, ...wireContainers] as unknown as [
    (typeof wireLeaves)[number],
    ...(typeof wireLeaves)[number][],
]) as unknown as z.ZodType<WireNode>

const wireOverlaySchema = z.strictObject({
    kind: overlayV2Schema.shape.kind,
    anchor: overlayV2Schema.shape.anchor,
    content: wireId,
})
const wireVariantSchema = z.strictObject({
    header: headerV2Schema,
    body: wireId,
    bar: barV2Schema,
    overlays: z.array(wireOverlaySchema).max(DOCUMENT_V2_LIMITS.overlays),
})
type WireVariant = z.infer<typeof wireVariantSchema>
/** A state variant is listed once with its state name (one shared item schema keeps the provider schema small). */
const wireStateSchema = wireVariantSchema.extend({ state: z.enum(VARIANT_STATES) })

export const wireProposalSchema = z.strictObject({
    nodes: z.array(wireNodeSchema).min(1).max(DOCUMENT_V2_LIMITS.documentNodes),
    header: wireVariantSchema.shape.header,
    body: wireId,
    bar: wireVariantSchema.shape.bar,
    overlays: wireVariantSchema.shape.overlays,
    states: z.array(wireStateSchema).max(VARIANT_STATES.length),
})
export type WireProposal = z.infer<typeof wireProposalSchema>

/** Machine issue codes only: a JSON path and a static rule, never the rejected text. */
export function wireIssueCodes(error: z.ZodError, limit = 12): string[] {
    return error.issues.slice(0, limit).map((issue) => `${issue.path.map(String).join('.') || 'root'}:${issue.code}`)
}

export function decodeWireProposal(
    value: unknown,
): { ok: true; proposal: ScreenProposalV2 } | { ok: false; issues: string[] } {
    const wire = wireProposalSchema.safeParse(value)
    if (!wire.success) return { ok: false, issues: wireIssueCodes(wire.error) }
    const issues: string[] = []
    const byId = new Map<string, WireNode>()
    wire.data.nodes.forEach((node, index) => {
        if (byId.has(node.id)) issues.push(`nodes.${index}:duplicate_id`)
        else byId.set(node.id, node)
    })
    const used = new Set<string>()
    const build = (id: string, where: string, depth: number): ScreenNodeV2 | null => {
        const node = byId.get(id)
        if (node === undefined) {
            issues.push(`${where}:unknown_node`)
            return null
        }
        if (used.has(id)) {
            issues.push(`${where}:node_used_twice`)
            return null
        }
        if (depth > DOCUMENT_V2_LIMITS.depth + 1) {
            issues.push(`${where}:too_deep`)
            return null
        }
        used.add(id)
        const { id: _id, children: ids, ...rest } = node
        if (ids !== undefined) {
            const children = ids.map((child, index) => build(child, `${where}.${index}`, depth + 1))
            return { ...rest, children: children.flatMap((child) => (child === null ? [] : [child])) } as ScreenNodeV2
        }
        return rest as unknown as ScreenNodeV2
    }
    const variant = (wired: WireVariant, where: string): ScreenVariantV2 | null => {
        const body = build(wired.body, `${where}body`, 1)
        const overlays = wired.overlays.map((overlay, index) => {
            const content = build(overlay.content, `${where}overlays.${index}`, 1)
            return content === null ? null : { ...overlay, content }
        })
        if (body === null || overlays.some((overlay) => overlay === null)) return null
        return {
            header: wired.header,
            body,
            bar: wired.bar,
            // Overlays must be coach marks: the recursive proposal schema validates the decoded tree right after.
            overlays: overlays.flatMap((overlay) => (overlay === null ? [] : [overlay])) as ScreenVariantV2['overlays'],
        }
    }
    const ready = variant(wire.data, '')
    const states = Object.fromEntries(VARIANT_STATES.map((state) => [state, null])) as ScreenProposalV2['states']
    const seen = new Set<string>()
    wire.data.states.forEach((wired, index) => {
        if (seen.has(wired.state)) issues.push(`states.${index}:duplicate_state`)
        seen.add(wired.state)
        const { state: _state, ...rest } = wired
        states[wired.state] = variant(rest, `states.${wired.state}.`)
    })
    if (wire.data.nodes.length !== used.size) issues.push('nodes:orphan_node')
    if (issues.length > 0 || ready === null) return { ok: false, issues: issues.slice(0, 12) }
    const tree = screenProposalV2Schema.safeParse({ ...ready, states })
    return tree.success ? { ok: true, proposal: tree.data } : { ok: false, issues: wireIssueCodes(tree.error) }
}

/** The inverse of `decodeWireProposal`: assigns document-order ids. Used by the synthetic fixture and tests. */
export function encodeWireProposal(proposal: ScreenProposalV2): WireProposal {
    const nodes: WireNode[] = []
    const add = (node: ScreenNodeV2): string => {
        const id = `n${nodes.length + 1}`
        const slot = nodes.length
        nodes.push(undefined as unknown as WireNode)
        if ('children' in node) {
            const children = node.children.map(add)
            nodes[slot] = { ...node, id, children }
        } else {
            nodes[slot] = { ...node, id }
        }
        return id
    }
    const variant = (source: ScreenVariantV2): WireVariant => ({
        header: source.header,
        body: add(source.body),
        bar: source.bar,
        overlays: source.overlays.map((overlay) => ({
            kind: overlay.kind,
            anchor: overlay.anchor,
            content: add(overlay.content),
        })),
    })
    const ready = variant(proposal)
    const states = VARIANT_STATES.flatMap((state) => {
        const source = proposal.states[state]
        return source === null ? [] : [{ state, ...variant(source) }]
    })
    return { nodes, ...ready, states }
}
