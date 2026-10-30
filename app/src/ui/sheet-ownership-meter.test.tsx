import type { ReactElement } from 'react'
import type * as ReactModule from 'react'
import { render } from '@testing-library/react-native'
import { View, type ModalProps } from 'react-native'
import type * as NativeModule from 'react-native'
import type { JsonElement } from 'test-renderer'
import type { ScreenDocumentV2 } from '@truebuild/contracts'
import { DocumentRenderer } from '../features/documents/document-renderer'
import { DocumentOwnershipProvider, DocumentRouteBoundary, useDocumentOwner } from '../features/documents/ownership'
import { recordedDocumentForTest } from '../features/documents/recorded/test-support'
import { NativeHostMeter } from '../features/screens/native-host-meter'
import { nativeFrameOrigins, type NativeFrameNode } from './native-frame-origin'
import { parseNativeMeterMarkers } from './native-meter-markers'
import { ThemeProvider } from '../theme/theme'
import { FeedbackProvider } from './feedback'
import { BottomSheet } from './sheet'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
// Installed RN Modal does not forward nativeID; it retains iOS children until onDismiss and adds a container View.
jest.mock('react-native/Libraries/Modal/Modal', () => ({
    __esModule: true,
    default: ({ children, visible }: ModalProps): ReactElement => {
        const React = jest.requireActual<typeof ReactModule>('react')
        const Native = jest.requireActual<typeof NativeModule>('react-native')
        return React.createElement(
            Native.View,
            { testID: 'native-modal-host', accessibilityElementsHidden: !visible },
            React.createElement(Native.View, { testID: 'native-modal-container' }, children),
        )
    },
}))

const home = recordedDocumentForTest('recorded-home')
const more = recordedDocumentForTest('recorded-more-global')
const judge = recordedDocumentForTest('recorded-judge-global')
function Published({ document, focused = true }: { document: ScreenDocumentV2; focused?: boolean }): ReactElement {
    useDocumentOwner(document, focused)
    return (
        <DocumentRenderer
            document={document}
            bindings={{
                resolve: (): { enabled: boolean; reason: null; run: () => void } => ({
                    enabled: true,
                    reason: null,
                    run: (): void => undefined,
                }),
                live: null,
                session: undefined,
                pageUris: {},
                capture: null,
                marks: [],
                heroMode: 'inline',
                inspect: false,
            }}
        />
    )
}
class Host implements NativeFrameNode {
    readonly nodeType = 1
    readonly isConnected = true
    parentNode: Host | null = null
    childNodes: Host[] = []
    constructor(
        readonly nodeName: string,
        readonly id: string,
        readonly testID?: string,
    ) {}
    setNativeProps(_props: { nativeID: string }): void {
        /* Public native command; declarative id remains unchanged. */
    }
}
function tree(node: JsonElement | string, all: Host[]): Host {
    if (typeof node === 'string') return new Host('#text', '')
    const host = new Host(
        node.props.testID === 'native-modal-host' ? 'RN:ModalHostView' : node.type,
        String(node.props.nativeID ?? ''),
        node.props.testID,
    )
    all.push(host)
    host.childNodes = node.children.map((child) => tree(child, all))
    for (const child of host.childNodes) child.parentNode = host
    return host
}

it('the real published More/Judge sheets own their exclusive modal frames and restore on nested close', async () => {
    const realBind = nativeFrameOrigins.bindModal.bind(nativeFrameOrigins)
    const submissions = jest.spyOn(nativeFrameOrigins, 'bindModal')
    const content = (nested: boolean): ReactElement => (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <DocumentOwnershipProvider>
                    <DocumentRouteBoundary>
                        <Published document={home} focused={false} />
                        <BottomSheet visible title="More" documentFrame onClose={(): void => undefined}>
                            <Published document={more} />
                            <View testID="unrelated-sheet-child" />
                            <BottomSheet visible={nested} title="Judge" documentFrame onClose={(): void => undefined}>
                                <Published document={judge} />
                            </BottomSheet>
                        </BottomSheet>
                    </DocumentRouteBoundary>
                </DocumentOwnershipProvider>
            </FeedbackProvider>
        </ThemeProvider>
    )
    const view = await render(content(true))
    let releases: (() => void)[] = []
    const measure = (): ReturnType<NativeHostMeter['sample']> => {
        for (const release of releases) release()
        releases = []
        const json = view.toJSON()
        if (json === null) throw new Error('missing_sheet_tree')
        const all: Host[] = []
        const rendered = tree(json, all)
        const root = new Host('RN:RootView', '')
        root.childNodes = [rendered]
        rendered.parentNode = root
        // Replay only real React hook submissions against the corresponding public native-host fixture boundary.
        for (const anchor of all.filter((host) => host.testID === 'sheet-scrim')) {
            const id = parseNativeMeterMarkers(anchor.id).documentContentBoundary
            const call = submissions.mock.calls.findLast((item) => item[1].screenId === id)
            if (call !== undefined) releases.push(realBind(anchor, call[1], call[2]))
        }
        const meter = new NativeHostMeter()
        meter.registerRoot({ isConnected: true, ownerDocument: { documentElement: root } })
        return meter.sample({ sessionId: 'owned-modal', platform: 'ios', screen: 'home', checkpointId: 'nested' })
    }
    try {
        const opened = measure()
        expect(opened.byHostType?.['RN:ModalHostView']).toMatchObject({ generated: 2, fallback: 0, shell: 0 })
        expect(opened.byHostType?.['RN:RootView']?.shell).toBe(1)
        expect(opened.counts?.shell).toBe(2) // RootView and the deliberate unrelated raw child remain counted shell.
        expect(submissions.mock.calls.some((call) => call[1] === more && call[2].visible)).toBe(true)
        expect(submissions.mock.calls.some((call) => call[1] === judge && call[2].visible)).toBe(true)
        await view.rerender(content(false))
        const closed = measure()
        expect(closed.byHostType?.['RN:ModalHostView']).toMatchObject({ generated: 1, fallback: 0, shell: 1 })
        expect(closed.counts?.total).toBe(opened.counts?.total)
    } finally {
        for (const release of releases) release()
        await view.unmount()
        submissions.mockRestore()
    }
})

it('an unpublished document sheet cannot borrow its route document to credit a ModalHost', async () => {
    const submissions = jest.spyOn(nativeFrameOrigins, 'bindModal')
    const view = await render(
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <DocumentOwnershipProvider>
                    <DocumentRouteBoundary>
                        <Published document={home} />
                        <BottomSheet visible title="Unpublished" documentFrame onClose={(): void => undefined}>
                            <View nativeID="truebuild-render-origin:generated" />
                        </BottomSheet>
                    </DocumentRouteBoundary>
                </DocumentOwnershipProvider>
            </FeedbackProvider>
        </ThemeProvider>,
    )
    try {
        expect(submissions).not.toHaveBeenCalled()
        const json = view.toJSON()
        if (json === null) throw new Error('missing_modal_tree')
        const all: Host[] = []
        const root = tree(json, all)
        const meter = new NativeHostMeter()
        meter.registerRoot({ isConnected: true, ownerDocument: { documentElement: root } })
        expect(
            meter.sample({ sessionId: 'unowned-modal', platform: 'ios', screen: 'home', checkpointId: 'unowned' })
                .byHostType?.['RN:ModalHostView'],
        ).toMatchObject({ generated: 0, shell: 1 })
    } finally {
        await view.unmount()
        submissions.mockRestore()
    }
})
