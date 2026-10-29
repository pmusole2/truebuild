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
        const root = id.match(/^truebuild-document-(?:navigation|root):(.+)$/u)
        const boundary = id.match(/^truebuild-document-content-boundary:(.+)$/u)
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
