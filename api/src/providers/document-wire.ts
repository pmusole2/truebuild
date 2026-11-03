import {
    CONTAINER_SHAPES_V2,
    CONTAINER_TYPES_V2,
    DOCUMENT_V2_LIMITS,
    LEAF_SCHEMAS_V2,
    barV2Schema,
    headerV2Schema,
    overlayV2Schema,
    screenVariantV2Schema,
    type ScreenNodeV2,
    type ScreenVariantV2,
} from '@truebuild/contracts'
import { z } from 'zod'

/**
 * The provider wire format of a version 2 document. The strict provider schema is finite (no `$ref`, no recursion, a
 * bounded nesting depth), so the model returns a FLAT node table: every node has an `id` and containers list the ids
 * of their children. `decodeWireProposal` rebuilds exactly the recursive tree the model described and nothing more:
 * it never adds, drops, reorders or rewrites a node. The recursive `screenVariantV2Schema` then validates the tree.
 * The model authors the ready screen only: the busy, pending, empty, error, recovery and confirming states are the
 * shell's deterministic variants (`withShellStatesV2`), so the provider schema carries no state at all.
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
        children: z
            .array(wireId)
            .max(DOCUMENT_V2_LIMITS.children)
            .describe(
                'IDs of already authored nodes in this table. Never self, an ancestor, an absent ID or a shared child.',
            ),
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

export const wireProposalSchema = z.strictObject({
    nodes: z
        .array(wireNodeSchema)
        .min(1)
        .max(DOCUMENT_V2_LIMITS.documentNodes)
        .describe(
            'Complete table, leaves before their parent containers. Include real Text content (every directionFacts reference on Guide) and citations; containers alone have no content. Every referenced ID must exist exactly once and be reachable from body or one overlay.',
        ),
    ...wireVariantSchema.shape,
})
export type WireProposal = z.infer<typeof wireProposalSchema>

/** Machine issue codes only: a JSON path and a static rule, never the rejected text. */
export function wireIssueCodes(error: z.ZodError, limit = 12): string[] {
    return error.issues.slice(0, limit).map((issue) => `${issue.path.map(String).join('.') || 'root'}:${issue.code}`)
}

export function decodeWireProposal(
    value: unknown,
): { ok: true; ready: ScreenVariantV2 } | { ok: false; issues: string[] } {
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
    const body = build(wire.data.body, 'body', 1)
    const overlays = wire.data.overlays.map((overlay, index) => {
        const content = build(overlay.content, `overlays.${index}`, 1)
        return content === null ? null : { ...overlay, content }
    })
    if (wire.data.nodes.length !== used.size) issues.push('nodes:orphan_node')
    if (issues.length > 0 || body === null || overlays.some((overlay) => overlay === null)) {
        return { ok: false, issues: issues.slice(0, 12) }
    }
    // Overlays must be coach marks: the recursive variant schema validates the decoded tree right after.
    const tree = screenVariantV2Schema.safeParse({
        header: wire.data.header,
        body,
        bar: wire.data.bar,
        overlays: overlays.flatMap((overlay) => (overlay === null ? [] : [overlay])),
    })
    return tree.success ? { ok: true, ready: tree.data } : { ok: false, issues: wireIssueCodes(tree.error) }
}

/** The inverse of `decodeWireProposal` for a ready screen (any state variants are ignored): assigns document-order ids. */
export function encodeWireProposal(proposal: ScreenVariantV2): WireProposal {
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
    return {
        nodes,
        header: proposal.header,
        body: add(proposal.body),
        bar: proposal.bar,
        overlays: proposal.overlays.map((overlay) => ({
            kind: overlay.kind,
            anchor: overlay.anchor,
            content: add(overlay.content),
        })),
    }
}
