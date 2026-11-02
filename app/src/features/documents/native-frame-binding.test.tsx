import { render } from '@testing-library/react-native'
import { useRef, type ComponentRef, type ReactElement } from 'react'
import type * as MockReact from 'react'
import { View, type ViewProps as MockViewProps } from 'react-native'
import type { NativeFrameNode } from '../../ui/native-frame-origin'
import { MeterRootsContext, type MeterRootSelection, type MeterRoots } from '../../ui/meter-roots'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { DocumentRenderer } from './document-renderer'
import { sharedFallbackDocument } from './fallback-v2'
import type { FrameBindings } from './types'
import { nativeFrameOrigins } from '../../ui/native-frame-origin'
import { parseNativeMeterMarkers } from '../../ui/native-meter-markers'
import { NativeHostMeter } from '../screens/native-host-meter'
import {
    DocumentNavigationRoot,
    DocumentOwnershipProvider,
    DocumentRouteBoundary,
    useDocumentFrameOwner,
    useDocumentModalFrameBinding,
    useDocumentOwner,
} from './ownership'
import { recordedDocumentForTest } from './recorded/test-support'

/** The actual ownership components run unchanged; only RN's unavailable native public refs are structural fixtures. */
class PublicNode implements NativeFrameNode {
    readonly nodeType = 1
    readonly isConnected = true
    parentNode: PublicNode | null = null
    childNodes: PublicNode[] = []
    id = ''
    ownerDocument: { readonly documentElement: PublicNode } | null = null
    readonly commands: string[] = []
    constructor(readonly nodeName: string) {}
    append(...children: PublicNode[]): this {
        this.childNodes.push(...children)
        for (const child of children) child.parentNode = this
        return this
    }
    setNativeProps(props: { nativeID: string }): void {
        this.commands.push(props.nativeID)
    }
}
const mockPorts = new Map<string, PublicNode>()
jest.mock('react-native', () => {
    const react = jest.requireActual<typeof MockReact>('react')
    const native = jest.requireActual<object>('react-native')
    const publicView = react.forwardRef<unknown, MockViewProps>((props, ref) => {
        const key = props.testID === 'document-navigation-root' ? props.testID : props.nativeID?.split('|')[0]
        const port = key === undefined ? undefined : mockPorts.get(key)
        if (port !== undefined) port.id = props.nativeID ?? ''
        react.useImperativeHandle(ref, () => port ?? null, [port])
        return react.createElement('View', props)
    })
    return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(native), View: { value: publicView } })
})
jest.mock('expo-router', () => ({
    ...jest.requireActual<object>('expo-router'),
    useIsFocused: (): boolean => true,
    usePathname: (): string => '/camera',
}))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
const document = recordedDocumentForTest('recorded-home')
function Publisher({ focused }: { focused: boolean }): ReactElement {
    useDocumentOwner(document, focused)
    return <View nativeID="truebuild-render-origin:generated" />
}
function tree(focused: boolean): ReactElement {
    return (
        <DocumentOwnershipProvider>
            <DocumentNavigationRoot>
                <DocumentRouteBoundary>
                    <Publisher focused={focused} />
                </DocumentRouteBoundary>
            </DocumentNavigationRoot>
        </DocumentOwnershipProvider>
    )
}

it('binds real ownership-wrapper refs and releases shared frame origin when the actual publisher loses focus', async () => {
    const anchor = new PublicNode('RN:View').append(new PublicNode('RN:View'))
    anchor.childNodes[0]!.id = 'truebuild-render-origin:generated'
    const content = new PublicNode('RN:RNSScreenContentWrapper').append(anchor, new PublicNode('RN:View'))
    const screen = new PublicNode('RN:RNSScreen').append(content, new PublicNode('RN:RNSScreenStackHeaderConfig'))
    const stack = new PublicNode('RN:RNSScreenStack').append(screen)
    const navigation = new PublicNode('RN:View').append(stack)
    const outerView = new PublicNode('RN:View').append(navigation)
    const outerSafeArea = new PublicNode('RN:RNCSafeAreaProvider').append(outerView)
    const root = new PublicNode('RN:RootView').append(outerSafeArea)
    mockPorts.set('document-navigation-root', navigation)
    mockPorts.set(`truebuild-document-content-boundary:${document.screenId}`, anchor)
    const meter = new NativeHostMeter()
    meter.registerRoot({ isConnected: true, ownerDocument: { documentElement: root } })
    const point = { sessionId: 'wrapper-test', platform: 'ios' as const, screen: 'home', checkpointId: 'ready' }
    const view = await render(tree(true))
    expect(meter.sample(point).counts).toEqual({ generated: 7, fallback: 0, shell: 4, total: 11 })
    expect(content.commands.at(-1)).toContain('truebuild-render-origin:generated')
    expect(root.commands).toEqual([])
    expect(outerSafeArea.commands).toEqual([])
    expect(outerView.commands).toEqual([])
    await view.rerender(tree(false))
    expect(meter.sample(point).counts).toEqual({ generated: 5, fallback: 0, shell: 6, total: 11 })
    expect(stack.commands.at(-1)).toBe('')
    await view.unmount()
    expect(content.commands.at(-1)).toBe('')
    expect(nativeFrameOrigins.markerFor(content)).toBeUndefined()
    mockPorts.clear()
})

it('keeps plain native frames formed across real document cleanup/rebind with a visible sheet and then clears source credit', async () => {
    const replacement = recordedDocumentForTest('recorded-home-library-single')
    const body = new PublicNode('RN:View')
    body.id = 'truebuild-render-origin:generated'
    const anchor = new PublicNode('RN:View').append(body)
    const content = new PublicNode('RN:RNSScreenContentWrapper').append(anchor)
    const screen = new PublicNode('RN:RNSScreen').append(content, new PublicNode('RN:RNSScreenStackHeaderConfig'))
    const routePlain = new PublicNode('RN:View').append(screen)
    const stack = new PublicNode('RN:RNSScreenStack').append(routePlain)
    const navigation = new PublicNode('RN:View').append(stack)
    const sheetBody = new PublicNode('RN:View')
    sheetBody.id = 'truebuild-render-origin:generated'
    const sheetAnchor = new PublicNode('RN:View').append(sheetBody)
    const sheetPlain = new PublicNode('RN:View').append(new PublicNode('RN:RNCSafeAreaProvider').append(sheetAnchor))
    const modal = new PublicNode('RN:ModalHostView').append(sheetPlain)
    const root = new PublicNode('RN:RootView').append(navigation, modal)
    anchor.ownerDocument = sheetAnchor.ownerDocument = { documentElement: root }
    mockPorts.set('document-navigation-root', navigation)
    mockPorts.set(`truebuild-document-content-boundary:${document.screenId}`, anchor)
    mockPorts.set(`truebuild-document-content-boundary:${replacement.screenId}`, anchor)
    mockPorts.set('retention-visible-sheet', sheetAnchor)
    const meter = new NativeHostMeter()
    const releaseApp = meter.registerRoot(anchor, { kind: 'app', screen: 'home', focused: true })
    const releaseSheet = meter.registerRoot(sheetAnchor, { kind: 'sheet', visible: true })
    function VisibleSheet(): ReactElement {
        const owner = useDocumentFrameOwner()
        const ref = useRef<ComponentRef<typeof View>>(null)
        useDocumentModalFrameBinding(ref, owner, true)
        return (
            <View
                ref={ref}
                nativeID={`retention-visible-sheet|truebuild-document-content-boundary:${owner?.documentId ?? 'unowned'}|truebuild-render-origin:${owner?.origin ?? 'shell'}`}
            />
        )
    }
    function Current({ page }: { page: typeof document }): ReactElement {
        useDocumentOwner(page, true)
        return <VisibleSheet />
    }
    function Route({ page }: { page: typeof document }): ReactElement {
        return (
            <DocumentOwnershipProvider>
                <DocumentNavigationRoot>
                    <DocumentRouteBoundary>
                        <Current page={page} />
                    </DocumentRouteBoundary>
                </DocumentNavigationRoot>
            </DocumentOwnershipProvider>
        )
    }
    const point = { sessionId: 'retained-frame', platform: 'android' as const, screen: 'home', checkpointId: 'ready' }
    const view = await render(<Route page={document} />)
    try {
        const before = meter.sample(point)
        expect(before.methods.focusedVisible.status).toBe('measured')
        expect(before.methods.focusedVisible.counts).toEqual(before.methods.allMounted.counts)
        expect(before.counts).toEqual({ generated: 13, fallback: 0, shell: 1, total: 14 })
        await view.rerender(<Route page={replacement} />)
        expect(meter.sample(point).methods).toMatchObject({
            allMounted: { counts: before.counts, strictCounts: before.strictCounts },
            focusedVisible: { counts: before.counts, strictCounts: before.strictCounts },
        })
        expect(nativeFrameOrigins.markerFor(routePlain)).toContain(
            `truebuild-document-content-boundary:${replacement.screenId}`,
        )
        expect(nativeFrameOrigins.markerFor(sheetPlain)).toContain(
            `truebuild-document-content-boundary:${replacement.screenId}`,
        )
        await view.unmount()
        for (const plain of [routePlain, sheetPlain]) {
            expect(plain.commands).not.toContain('')
            expect(plain.commands.at(-1)).toMatch(/^truebuild_frame_retained_\d+$/u)
            expect(nativeFrameOrigins.markerFor(plain)).toBeUndefined()
            expect(parseNativeMeterMarkers(plain.commands.at(-1))).toEqual({
                origin: null,
                capability: null,
                development: false,
                documentRoot: null,
                documentNavigation: null,
                documentContentBoundary: null,
            })
        }
        expect(content.commands.at(-1)).toBe('')
        expect(modal.commands.at(-1)).toBe('')
    } finally {
        await view.unmount()
        releaseApp()
        releaseSheet()
        mockPorts.clear()
    }
})

it('registers the canonical camera document as a focused app root and prunes its retained background route', async () => {
    const cameraDocument = sharedFallbackDocument({
        kind: 'camera',
        session: null,
        stepId: null,
        captureId: null,
        result: null,
        failure: null,
        uiState: { camera: { mode: 'build-photo', permission: 'granted' } },
    })
    const body = new PublicNode('RN:View')
    const anchor = new PublicNode('RN:View').append(body)
    const camera = new PublicNode('RN:RNSModalScreen').append(
        new PublicNode('RN:RNSScreenContentWrapper').append(anchor),
        new PublicNode('RN:RNSScreenStackHeaderConfig'),
    )
    const backgroundBody = new PublicNode('RN:View')
    const background = new PublicNode('RN:RNSScreen').append(backgroundBody)
    const navigation = new PublicNode('RN:View').append(new PublicNode('RN:RNSScreenStack').append(background, camera))
    const root = new PublicNode('RN:RootView').append(navigation)
    body.ownerDocument = backgroundBody.ownerDocument = { documentElement: root }
    mockPorts.set('document-navigation-root', navigation)
    mockPorts.set(`truebuild-document-content-boundary:${cameraDocument.screenId}`, anchor)
    mockPorts.set(`truebuild-document-root:${cameraDocument.screenId}`, body)
    const meter = new NativeHostMeter()
    const releaseBackground = meter.registerRoot(backgroundBody, { kind: 'app', screen: 'home', focused: false })
    const registrations: MeterRootSelection[] = []
    const roots: MeterRoots = {
        registerRoot: (ref, kind, selection): (() => void) => {
            if (kind === 'app') registrations.push(selection ?? {})
            return meter.registerRoot(ref, { kind, ...selection })
        },
    }
    const bindings: FrameBindings = {
        resolve: () => ({ enabled: true, reason: null, run: (): void => undefined }),
        live: null,
        session: undefined,
        pageUris: {},
        capture: null,
        marks: [],
        heroMode: 'inline',
        inspect: false,
        camera: {
            preview: <View testID="synthetic-camera-preview" />,
            capture: (): void => undefined,
            ready: true,
            permission: 'granted',
        },
    }
    function CameraDocument(): ReactElement {
        useDocumentOwner(cameraDocument, true)
        return <DocumentRenderer document={cameraDocument} bindings={bindings} />
    }
    const view = await render(
        <DocumentOwnershipProvider>
            <DocumentNavigationRoot>
                <MeterRootsContext.Provider value={roots}>
                    <ThemeProvider>
                        <FeedbackProvider reduceMotion>
                            <DocumentRouteBoundary>
                                <CameraDocument />
                            </DocumentRouteBoundary>
                        </FeedbackProvider>
                    </ThemeProvider>
                </MeterRootsContext.Provider>
            </DocumentNavigationRoot>
        </DocumentOwnershipProvider>,
    )
    expect(registrations).toEqual([{ screen: 'camera', focused: true }])
    expect(view.getByTestId('document-screen')).toBeTruthy()
    const sample = meter.sample({ sessionId: 'camera-focus', platform: 'ios', screen: 'camera', checkpointId: 'ready' })
    expect(sample.methods.focusedVisible).toMatchObject({
        status: 'measured',
        selection: { focusedRootCount: 1, boundary: 'native-screen', background: { counts: { total: 2 } } },
    })
    await view.unmount()
    releaseBackground()
    mockPorts.clear()
})
