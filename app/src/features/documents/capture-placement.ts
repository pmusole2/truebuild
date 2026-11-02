import { variantsOfV2, type ScreenDocumentV2, type ScreenNodeV2 } from '@truebuild/contracts'

/** Child positions and container types own the native photo instance, independently of the document's content. */
export function capturePlacement(document: ScreenDocumentV2): string {
    return JSON.stringify(
        variantsOfV2(document).map(({ name, variant }) => {
            const paths: string[][] = []
            const visit = (node: ScreenNodeV2, parents: string[]): void => {
                const component =
                    node.type === 'Section'
                        ? `${node.type}:${node.collapsible}`
                        : node.type === 'Scroll'
                          ? `${node.type}:${node.axis}`
                          : node.type
                const path = [...parents, component]
                if (node.type === 'Image' && node.source.kind === 'capture') paths.push(path)
                if ('children' in node) node.children.forEach((child, index) => visit(child, [...path, String(index)]))
            }
            visit(variant.body, [])
            return [name, paths]
        }),
    )
}
