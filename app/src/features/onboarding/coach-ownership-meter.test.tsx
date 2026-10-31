import type { ReactElement } from 'react'
import type * as ReactModule from 'react'
import { render } from '@testing-library/react-native'
import { Platform, View, type ModalProps } from 'react-native'
import type * as NativeModule from 'react-native'
import type { JsonElement } from 'test-renderer'
import { variantsOfV2, visitVariantNodesV2, type ScreenDocumentV2 } from '@truebuild/contracts'
import { DocumentRenderer } from '../documents/document-renderer'
import { DocumentOwnershipProvider, DocumentRouteBoundary, useDocumentOwner } from '../documents/ownership'
import { recordedDocumentForTest } from '../documents/recorded/test-support'
import { sharedFallbackDocument } from '../documents/fallback-v2'
import { NativeHostMeter } from '../screens/native-host-meter'
import { nativeFrameOrigins, type NativeFrameNode } from '../../ui/native-frame-origin'
import { parseNativeMeterMarkers } from '../../ui/native-meter-markers'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { CoachRootOverlay } from './coach-overlay'
import type { ActiveStep, CoachCandidate } from './coach-types'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('react-native-screens', () => ({
    ...jest.requireActual('react-native-screens'),
    FullWindowOverlay: ({ children }: { children: ReactModule.ReactNode }): ReactModule.ReactNode => children,
}))
// The actual Android RN Modal ignores nativeID and inserts one SDK View around its content.
jest.mock('react-native/Libraries/Modal/Modal', () => ({
    __esModule: true,
    default: ({ children }: ModalProps): ReactElement => {
        const React = jest.requireActual<typeof ReactModule>('react')
        const Native = jest.requireActual<typeof NativeModule>('react-native')
        return React.createElement(
            Native.View,
            { testID: 'sdk-coach-modal' },
            React.createElement(Native.View, { testID: 'sdk-coach-container' }, children),
        )
    },
}))
const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!
afterEach(() => {
    Object.defineProperty(Platform, 'OS', originalPlatform)
    jest.restoreAllMocks()
})
const generated = recordedDocumentForTest('recorded-home')
const fallback = sharedFallbackDocument({
    kind: 'home',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
})
const controls = {
    next: (): void => undefined,
    skip: (): void => undefined,
    activate: (): void => undefined,
    defer: (): void => undefined,
}
function candidate(document: ScreenDocumentV2): CoachCandidate {
    let found: CoachCandidate | undefined
    const ready = variantsOfV2(document)[0]!
    visitVariantNodesV2(ready.variant, ready.prefix, ({ node, path }) => {
        if (node.type === 'CoachMark' && found === undefined)
            found = {
                id: node.targetId,
                kind: 'control',
                heading: node.heading,
                sentence: node.body,
                textOrigin: document.metadata.origins[path],
                documentId: document.screenId,
                documentState: 'ready',
                documentPath: path,
            }
    })
    if (found === undefined) throw new Error('actual_coach_mark_required')
    return found
}
function Published({ document, publish }: { document: ScreenDocumentV2; publish: boolean }): ReactElement {
    useDocumentOwner(document, publish)
    return (
        <DocumentRenderer
            document={document}
            bindings={{
                resolve: (): { enabled: boolean; reason: null; run: () => void } => ({
                    enabled: true,
                    reason: null,
                    run: controls.next,
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
function content(document: ScreenDocumentV2, shown: CoachCandidate, publish = true): ReactElement {
    const active: ActiveStep = {
        token: 1,
        screen: 'home',
        host: 'root',
        candidate: shown,
        rect: { x: 20, y: 30, width: 100, height: 60 },
        label: 'Add manual',
        actionable: true,
        position: 1,
        total: 1,
    }
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <DocumentOwnershipProvider>
                    <View>
                        <DocumentRouteBoundary>
                            <Published document={document} publish={publish} />
                        </DocumentRouteBoundary>
                        <CoachRootOverlay active={active} controls={controls} />
                    </View>
                </DocumentOwnershipProvider>
            </FeedbackProvider>
        </ThemeProvider>
    )
}
class Host implements NativeFrameNode {
    readonly nodeType = 1
    readonly isConnected = true
    parentNode: Host | null = null
    childNodes: Host[] = []
    constructor(
        readonly nodeName: string,
        readonly id = '',
        readonly testID?: string,
    ) {}
    setNativeProps(_props: { nativeID: string }): void {
        /* Actual public command boundary; declarative id stays unchanged. */
    }
}
function tree(node: JsonElement | string, all: Host[]): Host {
    if (typeof node === 'string') return new Host('#text')
    const host = new Host(
        node.props.testID === 'sdk-coach-modal' ? 'RN:ModalHostView' : node.type,
        String(node.props.nativeID ?? ''),
        node.props.testID,
    )
    all.push(host)
    host.childNodes = node.children.map((child) => tree(child, all))
    for (const child of host.childNodes) child.parentNode = host
    return host
}
it.each([generated, fallback])(
    'binds the actual $metadata.source CoachMark Android modal frames from its published node, not supplied textOrigin',
    async (document) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
        const realBind = nativeFrameOrigins.bindModal.bind(nativeFrameOrigins)
        const submissions = jest.spyOn(nativeFrameOrigins, 'bindModal')
        const shown = {
            ...candidate(document),
            textOrigin: document === generated ? ('fallback' as const) : ('generated' as const),
        }
        const view = await render(content(document, shown))
        let release = (): void => undefined
        try {
            const submission = submissions.mock.calls.findLast((call) => call[1].screenId === document.screenId)
            expect(submission).toBeDefined()
            expect(submission![2]).toMatchObject({ visible: true, state: 'ready', originPath: shown.documentPath })
            const all: Host[] = []
            const rendered = tree(view.toJSON()!, all)
            const root = new Host('RN:RootView')
            root.childNodes = [rendered]
            rendered.parentNode = root
            const anchor = all.find((node) => node.testID === 'coach-overlay')!
            const meter = new NativeHostMeter()
            meter.registerRoot({ isConnected: true, ownerDocument: { documentElement: root } })
            const point = {
                sessionId: 'coach-frame',
                platform: 'android' as const,
                screen: 'home',
                checkpointId: 'shown',
            }
            const before = meter.sample(point)
            release = realBind(anchor, submission![1], submission![2])
            const after = meter.sample(point)
            const origin = document.metadata.origins[shown.documentPath!]!
            expect(after.byHostType?.['RN:ModalHostView']?.[origin]).toBe(1)
            expect(after.counts?.[origin]).toBe(before.counts![origin] + 2)
            expect(after.counts?.shell).toBe(before.counts!.shell - 2)
            expect(after.counts?.total).toBe(before.counts?.total)
            expect(nativeFrameOrigins.markerFor(root)).toBeUndefined()
            release()
            for (const host of all.filter((node) =>
                ['sdk-coach-modal', 'sdk-coach-container'].includes(node.testID ?? ''),
            ))
                Object.defineProperty(host, 'setNativeProps', { value: undefined })
            release = realBind(anchor, submission![1], submission![2])
            expect(meter.sample(point)).toMatchObject({
                status: 'unavailable',
                counts: null,
                reason: 'unsupported-tree',
            })
        } finally {
            release()
            await view.unmount()
        }
    },
)
it.each(['legacy', 'unpublished', 'stale', 'wrong-type', 'wrong-copy', 'wrong-target', 'wrong-state'] as const)(
    'rejects %s CoachMark frame credit',
    async (failure) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
        const submissions = jest.spyOn(nativeFrameOrigins, 'bindModal')
        const shown = { ...candidate(generated) }
        if (failure === 'legacy') {
            delete shown.documentState
            delete shown.documentPath
        }
        if (failure === 'stale') shown.documentId = 'b'.repeat(64)
        if (failure === 'wrong-type') shown.documentPath = 'body'
        if (failure === 'wrong-copy') shown.sentence += ' Old copy.'
        if (failure === 'wrong-target') shown.id = shown.id === 'header-more' ? 'home-add' : 'header-more'
        if (failure === 'wrong-state') shown.documentState = 'busy'
        const view = await render(content(generated, shown, failure !== 'unpublished'))
        try {
            expect(submissions).not.toHaveBeenCalled()
            expect(parseNativeMeterMarkers(view.getByTestId('coach-overlay').props.nativeID).origin).toBe('shell')
        } finally {
            await view.unmount()
        }
    },
)
it('keeps the iOS full-window wrapper separate from Android modal binding', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    const submissions = jest.spyOn(nativeFrameOrigins, 'bindModal')
    const view = await render(content(generated, candidate(generated)))
    try {
        expect(submissions).not.toHaveBeenCalled()
        expect(parseNativeMeterMarkers(view.getByTestId('coach-overlay').props.nativeID).documentRoot).toBe(
            generated.screenId,
        )
        expect(view.queryByTestId('sdk-coach-modal')).toBeNull()
    } finally {
        await view.unmount()
    }
})
