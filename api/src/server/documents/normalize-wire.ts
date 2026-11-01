import {
    buildFallbackProposalV2,
    CONTAINER_TYPES_V2,
    DOCUMENT_V2_LIMITS,
    overlayV2Schema,
    semanticIssuesV2,
    type ScreenProposalV2,
} from '@truebuild/contracts'

import type { DocumentContext } from './context'

type ObjectValue = Record<string, unknown>
interface NodeValue extends ObjectValue {
    id: string
}

const WIRE_ID = /^[A-Za-z0-9_-]{1,12}$/u
const MAX_JSON_DEPTH = 32
const MAX_JSON_VALUES = 200_000
const MAX_JSON_CHARACTERS = 2_000_000
const containers = new Set<string>(CONTAINER_TYPES_V2)

function object(value: unknown): value is ObjectValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Match the strict decoder's ID interpretation, without ever putting an unvalidated string into a log code. */
function idOf(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const id = value.trim()
    return WIRE_ID.test(id) ? id : null
}

/**
 * Provider output is JSON. Bound the copy before traversing it, including malformed/cyclic non-JSON callers. Accessors
 * and exotic objects are left to the strict gate rather than executed or coerced here. A failed copy is never repaired.
 */
function boundedCopy(value: unknown): unknown {
    let values = 0
    let characters = 0
    const active = new Set<object>()
    const copy = (input: unknown, depth: number): unknown => {
        values += 1
        if (values > MAX_JSON_VALUES || depth > MAX_JSON_DEPTH) throw new Error('normalization_limit')
        if (typeof input === 'string') {
            characters += input.length
            if (characters > MAX_JSON_CHARACTERS) throw new Error('normalization_limit')
            return input
        }
        if (input === null || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) {
            return input
        }
        if (typeof input !== 'object' || active.has(input)) throw new Error('normalization_shape')
        if (Object.getPrototypeOf(input) !== (Array.isArray(input) ? Array.prototype : Object.prototype)) {
            throw new Error('normalization_shape')
        }
        active.add(input)
        let result: unknown
        if (Array.isArray(input)) {
            if (input.length > MAX_JSON_VALUES - values) throw new Error('normalization_limit')
            const descriptors = Object.getOwnPropertyDescriptors(input)
            result = Array.from({ length: input.length }, (_, index) => {
                const descriptor = descriptors[String(index)]
                if (!descriptor || !('value' in descriptor)) throw new Error('normalization_shape')
                return copy(descriptor.value, depth + 1)
            })
        } else {
            const descriptors = Object.getOwnPropertyDescriptors(input)
            const entries = Object.entries(descriptors)
            if (entries.length > MAX_JSON_VALUES - values) throw new Error('normalization_limit')
            result = Object.fromEntries(
                entries.map(([key, descriptor]) => {
                    if (!('value' in descriptor)) throw new Error('normalization_shape')
                    characters += key.length
                    if (characters > MAX_JSON_CHARACTERS) throw new Error('normalization_limit')
                    return [key, copy(descriptor.value, depth + 1)]
                }),
            )
        }
        active.delete(input)
        return result
    }
    return copy(value, 0)
}

/**
 * A deletion-only pass over the flat provider graph, before the unchanged strict gate. First node ID and first DFS
 * reference win (body before overlays). Surviving authored payloads are copied verbatim; only references, unreachable
 * nodes, newly empty containers, invalid overlay coach marks and Home's back control may be removed. Malformed shapes
 * and over-budget inputs are returned unchanged for rejection. Issue codes contain only validated wire IDs/static rules.
 */
export function normalizeDocumentWire(
    value: unknown,
    context: DocumentContext,
): { value: unknown; issueCodes: string[] } {
    let copied: unknown
    try {
        copied = boundedCopy(value)
    } catch {
        return { value, issueCodes: ['normalization:input_not_bounded_json'] }
    }
    if (
        !object(copied) ||
        !Array.isArray(copied.nodes) ||
        copied.nodes.length > DOCUMENT_V2_LIMITS.documentNodes ||
        !Array.isArray(copied.overlays) ||
        copied.overlays.length > DOCUMENT_V2_LIMITS.overlays ||
        idOf(copied.body) === null
    ) {
        return { value, issueCodes: [] }
    }
    const byId = new Map<string, NodeValue>()
    const issues = new Set<string>()
    const add = (scope: 'nodes' | 'refs' | 'overlays', id: string, rule: string): void => {
        issues.add(`normalization.${scope}.${id}:${rule}`)
    }
    for (const node of copied.nodes) {
        if (!object(node) || idOf(node.id) === null) return { value, issueCodes: [] }
        // A leaf's unexpected children field is payload: an invalid overlay may be dropped, but a body leaf stays invalid.
        if (
            typeof node.type === 'string' &&
            containers.has(node.type) &&
            'children' in node &&
            (!Array.isArray(node.children) ||
                node.children.length > DOCUMENT_V2_LIMITS.children ||
                node.children.some((child) => idOf(child) === null))
        ) {
            return { value, issueCodes: [] }
        }
        const id = idOf(node.id)!
        if (byId.has(id)) add('nodes', id, 'duplicate_id')
        else byId.set(id, node as NodeValue)
    }
    for (const overlay of copied.overlays) {
        if (!object(overlay) || idOf(overlay.content) === null) return { value, issueCodes: [] }
    }
    const used = new Set<string>()
    const retained = new Set<string>()
    let tooDeep = false
    const visit = (id: string, depth: number): boolean => {
        const node = byId.get(id)
        if (!node) {
            add('refs', id, 'unknown_reference')
            return false
        }
        if (used.has(id)) {
            add('refs', id, 'duplicate_reference')
            return false
        }
        if (depth > DOCUMENT_V2_LIMITS.depth + 1) {
            tooDeep = true
            return false
        }
        used.add(id)
        if (typeof node.type === 'string' && containers.has(node.type) && Array.isArray(node.children)) {
            const originalLength = node.children.length
            const children = node.children.filter((child) => visit(idOf(child)!, depth + 1))
            node.children = children
            if (originalLength > 0 && children.length === 0) {
                add('nodes', id, 'empty_container')
                return false
            }
        }
        retained.add(id)
        return true
    }
    visit(idOf(copied.body)!, 1)
    let probe: ScreenProposalV2 | undefined
    copied.overlays = copied.overlays.filter((overlay) => {
        // Shape was checked above; values and node payloads remain unknown until their existing strict schema checks.
        if (!object(overlay)) return true
        const id = idOf(overlay.content)!
        const node = byId.get(id)
        if (node !== undefined && !used.has(id)) {
            const { id: _id, ...content } = node
            const parsed = overlayV2Schema.safeParse({ ...overlay, content })
            if (parsed.success) probe ??= buildFallbackProposalV2(context.material)
            if (
                !parsed.success ||
                semanticIssuesV2({ ...probe!, overlays: [parsed.data] }, context.material).some((issue) =>
                    issue.startsWith('overlays.'),
                )
            ) {
                add('overlays', id, 'invalid_coach_mark')
                return false
            }
        }
        return visit(id, 1)
    })
    if (tooDeep) return { value, issueCodes: ['normalization:graph_too_deep'] }
    copied.nodes = [...byId].flatMap(([id, node]) => {
        if (retained.has(id)) return [node]
        if (!used.has(id)) add('nodes', id, 'unreachable_node')
        return []
    })
    if (context.inputs.kind === 'home' && object(copied.header) && copied.header.back !== null) {
        if ('back' in copied.header) {
            copied.header.back = null
            issues.add('normalization.header:home_back_removed')
        }
    }
    return { value: copied, issueCodes: [...issues] }
}
