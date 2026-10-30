import {
    sourceKeyV2,
    variantsOfV2,
    nodeChildrenV2,
    type DocumentSourceV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenVariantV2,
    type VariantState,
} from './document-v2'

/**
 * How one `Citation` node should be drawn so a screen offers ONE citation affordance per exact source reference.
 * `show` are the indexes this node draws as its chip or thumbnail; `repeated` are the ones a reachable page or chip
 * already offers. Together they are exactly the node's own references (nothing is removed from the document).
 */
export interface CitationPlanEntryV2 {
    show: number[]
    repeated: number[]
}

/**
 * Plans the citation affordances of one visibility snapshot. The renderer replans when a disclosure opens/closes.
 * Pass includeManualPages for a complete render plan (including duplicate manual-page openers); the default preserves
 * the citation-only query used by server tooling. Each Section.initiallyOpen must reflect its current visibility in
 * a planning-only copy; the published document and all its citation witnesses remain unchanged.
 *
 * Plans the citation affordances of one variant. The document is not touched: every `Citation` node stays in the tree
 * as the mandatory citation witness the validator requires, and a renderer may draw only `show` (an empty `show` means
 * draw nothing visible for that node while it remains a witness).
 *
 * "Exact source reference" is `sourceKeyV2`: the page and the exact region. A page-level reference and a region of the
 * same page are different references. Visible nodes are planned first, then each unopened section or overlay in its
 * own visibility group. A group inherits only the affordances reachable when its ancestors open, never those of a
 * still-closed sibling or child. Within each group:
 * - a `ManualPage` is always drawn and already shows that page of the manual, so it claims its references wherever it
 *   stands, before any chip of the group is chosen (a chip ahead of it would offer the same source twice). A figure
 *   (`Image` of a source) is a picture, not an affordance to cite or open, so it claims nothing and never hides a chip;
 * - a `Citation` shows an index only if no manual page and no earlier chip claimed it;
 * - a reference no reachable ancestor mentions is shown at its first mention in the group, so opening a section never
 *   leaves it empty merely because another unopened section holds that source.
 */
export function citationPlanV2(
    variant: ScreenVariantV2,
    prefix: string,
    sources: readonly DocumentSourceV2[],
    options: { readonly includeManualPages?: boolean; readonly lowPriorityPaths?: ReadonlySet<string> } = {},
): Record<string, CitationPlanEntryV2> {
    const keyOf = (index: number): string => {
        const source = sources[index]
        return source === undefined ? `#${index}` : sourceKeyV2(source)
    }
    interface Group {
        parent: Group | null
        nodes: { node: ScreenNodeV2; path: string }[]
        claimed: Set<string>
    }
    const groups: Group[] = []
    // Record keys in canonical document order, independently of the visibility order used to choose their chips.
    const plan: Record<string, CitationPlanEntryV2> = {}
    const group = (parent: Group | null): Group => {
        const created: Group = { parent, nodes: [], claimed: new Set() }
        groups.push(created)
        return created
    }
    const visible = group(null)
    const walk = (node: ScreenNodeV2, path: string, current: Group): void => {
        current.nodes.push({ node, path })
        if (node.type === 'Citation' || (options.includeManualPages && node.type === 'ManualPage'))
            plan[path] = { show: [], repeated: [] }
        const children = node.type === 'Section' && node.collapsible && !node.initiallyOpen ? group(current) : current
        nodeChildrenV2(node).forEach((child, index) => walk(child, `${path}.${index}`, children))
    }
    walk(variant.body, `${prefix}body`, visible)
    walk(variant.bar.primary, `${prefix}bar.primary`, visible)
    if (variant.bar.secondary) walk(variant.bar.secondary, `${prefix}bar.secondary`, visible)
    variant.overlays.forEach((overlay, index) => walk(overlay.content, `${prefix}overlays.${index}`, group(visible)))
    for (const current of groups) {
        const claimed = new Set(current.parent?.claimed)
        for (const { node, path } of current.nodes) {
            if (node.type !== 'ManualPage') continue
            const entry = options.includeManualPages ? plan[path]! : null
            for (const index of new Set(node.sources)) {
                const key = keyOf(index)
                if (claimed.has(key)) entry?.repeated.push(index)
                else {
                    claimed.add(key)
                    entry?.show.push(index)
                }
            }
        }
        // Native capability links are secondary to an explicit document citation of the same source.
        const citations = options.lowPriorityPaths
            ? [...current.nodes].sort(
                  (a, b) =>
                      Number(options.lowPriorityPaths!.has(a.path)) - Number(options.lowPriorityPaths!.has(b.path)),
              )
            : current.nodes
        for (const { node, path } of citations) {
            if (node.type !== 'Citation') continue
            const entry = plan[path]!
            for (const index of new Set(node.sources)) {
                const key = keyOf(index)
                if (claimed.has(key)) {
                    entry.repeated.push(index)
                } else {
                    claimed.add(key)
                    entry.show.push(index)
                }
            }
        }
        current.claimed = claimed
    }
    return plan
}

/** The plan of one variant of a published document (`{}` when the document does not carry that state). */
export function citationPlanOfV2(
    document: ScreenDocumentV2,
    name: 'ready' | VariantState,
): Record<string, CitationPlanEntryV2> {
    const selected = variantsOfV2(document).find((variant) => variant.name === name)
    return selected === undefined ? {} : citationPlanV2(selected.variant, selected.prefix, document.sources)
}
