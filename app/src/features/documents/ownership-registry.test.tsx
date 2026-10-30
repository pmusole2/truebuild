import { render, screen } from '@testing-library/react-native'
import { View } from 'react-native'
import { componentPathsV2, type ScreenDocumentV2 } from '@truebuild/contracts'
import { DocumentNavigationRoot, DocumentOwnershipProvider, DocumentRouteBoundary, useDocumentOwner } from './ownership'
import { sharedFallbackDocument } from './fallback-v2'
import { parseNativeMeterMarkers, type NativeMeterMarkers } from '../../ui/native-meter-markers'
import type { OwnershipTree } from './ownership-audit'

const fallback = sharedFallbackDocument({
    kind: 'home',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
})
const generated: ScreenDocumentV2 = {
    ...fallback,
    screenId: 'a'.repeat(64),
    metadata: {
        ...fallback.metadata,
        source: 'generated',
        evidence: 'synthetic-fixture',
        fallbackReason: null,
        origins: Object.fromEntries(componentPathsV2(fallback).map((path) => [path, 'generated' as const])),
    },
}
function Claim({ doc, focused }: { doc: ScreenDocumentV2; focused: boolean }): React.JSX.Element {
    useDocumentOwner(doc, focused)
    return <View />
}
const tree = (second: boolean): React.JSX.Element => (
    <DocumentOwnershipProvider>
        <DocumentNavigationRoot>
            <DocumentRouteBoundary>
                <Claim doc={fallback} focused />
            </DocumentRouteBoundary>
            {second ? (
                <DocumentRouteBoundary>
                    <Claim doc={generated} focused />
                </DocumentRouteBoundary>
            ) : null}
        </DocumentNavigationRoot>
    </DocumentOwnershipProvider>
)

it('keeps each route boundary bound to its own displayed document rather than the global focused source', async () => {
    await render(tree(true))
    const walk = (node: OwnershipTree): NativeMeterMarkers[] => [
        parseNativeMeterMarkers(node.props.nativeID),
        ...node.children.flatMap((child) => (typeof child === 'string' ? [] : walk(child))),
    ]
    const boundaries = walk(screen.container as unknown as OwnershipTree)
    expect(boundaries.find((marker) => marker.documentContentBoundary === fallback.screenId)?.origin).toBe('fallback')
    expect(boundaries.find((marker) => marker.documentContentBoundary === generated.screenId)?.origin).toBe('generated')
})
it('restores the remaining real publisher when another focused document closes', async () => {
    const view = await render(tree(true))
    expect(parseNativeMeterMarkers(screen.getByTestId('document-navigation-root').props.nativeID).origin).toBe(
        'generated',
    )
    await view.rerender(tree(false))
    expect(parseNativeMeterMarkers(screen.getByTestId('document-navigation-root').props.nativeID).origin).toBe(
        'fallback',
    )
})
