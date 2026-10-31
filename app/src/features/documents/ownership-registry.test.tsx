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

it.each([
    ['1', true, true],
    ['1', false, false],
    ['0', true, false],
] as const)('records the displayed fallback cause only for a focused fixture (%s, %s)', async (flag, focused, logs) => {
    const previous = process.env.EXPO_PUBLIC_RELEASE_FIXTURE
    process.env.EXPO_PUBLIC_RELEASE_FIXTURE = flag
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
        await render(<Claim doc={fallback} focused={focused} />)
        expect(info.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(
            logs
                ? [
                      {
                          event: 'document_fallback',
                          documentId: fallback.screenId,
                          kind: 'home',
                          state: 'ready',
                          evidence: fallback.metadata.evidence,
                          fallbackReason: fallback.metadata.fallbackReason,
                      },
                  ]
                : [],
        )
    } finally {
        info.mockRestore()
        if (previous === undefined) delete process.env.EXPO_PUBLIC_RELEASE_FIXTURE
        else process.env.EXPO_PUBLIC_RELEASE_FIXTURE = previous
    }
})
