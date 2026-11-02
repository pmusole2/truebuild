/** Test support: document ownership is a schema-bound identity, never inferred from a source=generated marker. */
export type OwnershipTree = {
    readonly type: unknown
    readonly props: { readonly nativeID?: unknown; readonly testID?: unknown }
    readonly children: readonly (OwnershipTree | string)[]
}

export function hostsOutsideDocuments(tree: OwnershipTree, validDocumentIds: ReadonlySet<string>): string[] {
    const failures: string[] = []
    const visit = (node: OwnershipTree, owner: boolean): void => {
        const id = typeof node.props.nativeID === 'string' ? node.props.nativeID : ''
        // nativeID is '|'-joined trusted segments (ownership marker first, render-origin last); parse per segment.
        const segments = id.split('|')
        const root =
            segments.map((s) => s.match(/^truebuild-document-(?:navigation|root):(.+)$/u)).find((m) => m !== null) ??
            null
        const boundary =
            segments.map((s) => s.match(/^truebuild-document-content-boundary:(.+)$/u)).find((m) => m !== null) ?? null
        const ownRoot = root !== null && validDocumentIds.has(root[1]!)
        const ownBoundary = boundary !== null && validDocumentIds.has(boundary[1]!)
        const nowOwned = ownRoot || ownBoundary || owner
        // RNTL's empty-type synthetic root is not a native host; every actual string host is audited.
        if (typeof node.type === 'string' && node.type !== '' && !nowOwned)
            failures.push(`${node.type}${typeof node.props.testID === 'string' ? `#${node.props.testID}` : ''}`)
        for (const child of node.children)
            if (typeof child !== 'string') visit(child, boundary === null ? nowOwned : false)
    }
    visit(tree, false)
    return failures
}
