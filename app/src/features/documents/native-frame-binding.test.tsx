import { render } from '@testing-library/react-native'
import type { ReactElement } from 'react'
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
import { NativeHostMeter } from '../screens/native-host-meter'
import { DocumentNavigationRoot, DocumentOwnershipProvider, DocumentRouteBoundary, useDocumentOwner } from './ownership'
import { screenDocumentV2Schema } from '@truebuild/contracts'
import recordedHome from './recorded/recorded-home.json'

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
const document = screenDocumentV2Schema.parse(recordedHome)
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
