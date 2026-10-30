import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { screenDocumentV2Schema } from '@truebuild/contracts'
import { NativeHostMeter, type NativeHostCheckpoint } from '../features/screens/native-host-meter'
import { sharedFallbackDocument } from '../features/documents/fallback-v2'
import {
    NativeFrameOriginRegistry,
    nativeFrameOrigins,
    type NativeFrameNode,
    type NativeFrameOriginDiagnostic,
} from './native-frame-origin'

const document = screenDocumentV2Schema.parse(
    JSON.parse(readFileSync(new URL('../features/documents/recorded/recorded-home.json', import.meta.url), 'utf8')),
)
const point: NativeHostCheckpoint = { sessionId: 'frame-test', platform: 'ios', screen: 'home', checkpointId: 'ready' }

/** Public-node fixture: imperative nativeID commands do not rewrite RN's declarative .id getter. */
class Node implements NativeFrameNode {
    readonly nodeType = 1
    isConnected = true
    parentNode: Node | null = null
    childNodes: Node[] = []
    readonly commands: string[] = []
    constructor(
        public nodeName: string,
        public id = '',
    ) {}
    append(...children: Node[]): this {
        this.childNodes.push(...children)
        for (const child of children) child.parentNode = this
        return this
    }
    setNativeProps(props: { nativeID: string }): void {
        if (this.nodeName === 'RN:RootView') throw new Error('unsupported root writer')
        this.commands.push(props.nativeID)
    }
}
function fixture(): { root: Node; anchor: Node; screen: Node; wrapper: Node; header: Node; stray: Node; coach: Node } {
    const anchor = new Node(
        'RN:View',
        `truebuild-document-content-boundary:${document.screenId}|truebuild-render-origin:generated`,
    ).append(new Node('RN:View', 'truebuild-render-origin:generated'))
    const stray = new Node('RN:View')
    const header = new Node('RN:RNSScreenStackHeaderConfig')
    const wrapper = new Node('RN:RNSScreenContentWrapper').append(new Node('RN:RNSSafeAreaView').append(anchor), stray)
    const screen = new Node('RN:RNSScreen').append(wrapper, header)
    const coach = new Node('RN:RNSFullWindowOverlay').append(new Node('RN:View'))
    const navigation = new Node(
        'RN:View',
        `truebuild-document-navigation:${document.screenId}|truebuild-render-origin:generated`,
    ).append(
        new Node('RN:RNCSafeAreaProvider').append(
            new Node('RN:View').append(new Node('RN:RNSScreenStack').append(screen)),
        ),
        coach,
    )
    const root = new Node('RN:RootView').append(new Node('RN:View').append(navigation))
    return { root, anchor, screen, wrapper, header, stray, coach }
}
function measure(root: Node): ReturnType<NativeHostMeter['sample']> {
    const meter = new NativeHostMeter()
    meter.registerRoot({ isConnected: true, ownerDocument: { documentElement: root } })
    return meter.sample(point)
}

describe('native document frame origin', () => {
    it('submits native marker commands for exact frame hosts without crediting unrelated descendants or coach siblings', () => {
        const tree = fixture()
        const release = nativeFrameOrigins.bind(tree.anchor, document, { focused: true })
        expect(tree.wrapper.commands.at(-1)).toContain('truebuild-render-origin:generated')
        expect(tree.header.commands.at(-1)).toContain('truebuild-render-origin:generated')
        expect(tree.stray.commands).toEqual([])
        expect(tree.coach.commands).toEqual([])
        expect(measure(tree.root)).toMatchObject({ counts: { generated: 10, shell: 5, total: 15 } })
        release()
        expect(measure(tree.root)).toMatchObject({ counts: { generated: 3, shell: 12, total: 15 } })
    })

    it('does not credit a failed native write and preserves an explicit origin or ordinary ID', () => {
        const registry = new NativeFrameOriginRegistry()
        const tree = fixture()
        tree.header.id = 'truebuild-render-origin:fallback'
        tree.wrapper.id = 'ordinary-sdk-id'
        tree.screen.setNativeProps = (): never => {
            throw new Error('unsupported')
        }
        const release = registry.bind(tree.anchor, document, { focused: true })
        expect(registry.markerFor(tree.screen)).toBeUndefined()
        expect(tree.header.commands).toEqual([])
        expect(tree.wrapper.commands.at(-1)).toContain('ordinary-sdk-id|')
        release()
        expect(tree.wrapper.commands.at(-1)).toBe('ordinary-sdk-id')
    })
    it('keeps a retained fallback route local and never lends the focused source to its sibling hosts', () => {
        const fallback = sharedFallbackDocument({
            kind: 'home',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
        })
        const tree = fixture()
        const background = new Node(
            'RN:View',
            `truebuild-document-content-boundary:${fallback.screenId}|truebuild-render-origin:fallback`,
        ).append(new Node('RN:View', 'truebuild-render-origin:fallback'))
        const retainedHeader = new Node('RN:RNSScreenStackHeaderConfig')
        const retained = new Node('RN:RNSScreen').append(
            new Node('RN:RNSScreenContentWrapper').append(background),
            retainedHeader,
        )
        tree.screen.parentNode!.append(retained)
        const first = nativeFrameOrigins.bind(tree.anchor, document, { focused: true })
        const second = nativeFrameOrigins.bind(background, fallback, { focused: false })
        expect(measure(tree.root)).toMatchObject({ counts: { generated: 10, fallback: 5, shell: 5, total: 20 } })
        expect(retainedHeader.commands.at(-1)).toContain('truebuild-render-origin:fallback')
        first()
        second()
    })

    it('restores an overlapping owner and then the original IDs when bindings unmount', () => {
        const tree = fixture()
        const registry = new NativeFrameOriginRegistry()
        const first = registry.bind(tree.anchor, document, { focused: true })
        const second = registry.bind(tree.anchor, document, { focused: true })
        first()
        expect(registry.markerFor(tree.wrapper)).toContain('truebuild-render-origin:generated')
        second()
        expect(registry.markerFor(tree.wrapper)).toBeUndefined()
        expect(tree.wrapper.commands.at(-1)).toBe('')
        second()
    })

    it.each([
        'anchor-disconnected',
        'ancestor-disconnected',
        'changed-id',
        'changed-type',
        'reparented',
        'header-removed',
    ])('fails closed when a bound host witness becomes %s', (change) => {
        const registry = new NativeFrameOriginRegistry()
        const tree = fixture()
        const release = registry.bind(tree.anchor, document, { focused: true })
        if (change === 'anchor-disconnected') tree.anchor.isConnected = false
        if (change === 'ancestor-disconnected') tree.screen.isConnected = false
        if (change === 'changed-id') tree.wrapper.id = 'new-owner-id'
        if (change === 'changed-type') tree.wrapper.nodeName = 'RN:UnknownHost'
        if (change === 'reparented') tree.anchor.parentNode = new Node('RN:View')
        if (change === 'header-removed') tree.screen.childNodes.pop()
        expect(() => registry.markerFor(tree.wrapper)).toThrow('invalid_native_frame_origin')
        release()
    })

    it('relinquishes shared frames when focus changes while preserving the retained local frame', () => {
        const registry = new NativeFrameOriginRegistry()
        const tree = fixture()
        const stack = tree.screen.parentNode!
        const focused = registry.bind(tree.anchor, document, { focused: true })
        expect(registry.markerFor(stack)).toContain('truebuild-render-origin:generated')
        focused()
        const retained = registry.bind(tree.anchor, document, { focused: false })
        expect(registry.markerFor(stack)).toBeUndefined()
        expect(registry.markerFor(tree.wrapper)).toContain('truebuild-render-origin:generated')
        retained()
    })

    it('rejects a navigation anchor supplied to the route-only bridge', () => {
        const tree = fixture()
        const nav = tree.root.childNodes[0]!.childNodes[0]!
        const registry = new NativeFrameOriginRegistry()
        const release = registry.bind(nav, document, { focused: true })
        expect(registry.markerFor(tree.root)).toBeUndefined()
        expect(registry.markerFor(tree.root.childNodes[0]!)).toBeUndefined()
        expect(tree.root.commands).toEqual([])
        expect(tree.root.childNodes[0]!.commands).toEqual([])
        release()
    })

    it('rejects unknown SDK ancestors and unowned ref anchors without any native command', () => {
        for (const change of ['unknown-ancestor', 'unowned-anchor']) {
            const registry = new NativeFrameOriginRegistry()
            const tree = fixture()
            if (change === 'unknown-ancestor') tree.wrapper.nodeName = 'RN:ArbitraryContainer'
            else tree.anchor.id = ''
            registry.bind(tree.anchor, document, { focused: true })
            expect(tree.screen.commands).toEqual([])
            expect(tree.wrapper.commands).toEqual([])
        }
    })

    it('accepts a fixture getter reflecting the submitted ID without treating it as a new owner', () => {
        const tree = fixture()
        const registry = new NativeFrameOriginRegistry()
        tree.wrapper.setNativeProps = (props: { nativeID: string }): void => {
            tree.wrapper.id = props.nativeID
        }
        const release = registry.bind(tree.anchor, document, { focused: true })
        expect(registry.markerFor(tree.wrapper)).toContain('truebuild-render-origin:generated')
        release()
        expect(tree.wrapper.id).toBe('')
        expect(registry.markerFor(tree.wrapper)).toBeUndefined()
    })

    it('keeps its local frame when a different published modal owns shared navigation', () => {
        const tree = fixture()
        const registry = new NativeFrameOriginRegistry()
        const nav = tree.root.childNodes[0]!.childNodes[0]!
        nav.id = 'truebuild-document-navigation:another-document|truebuild-render-origin:fallback'
        const release = registry.bind(tree.anchor, document, { focused: true })
        expect(registry.markerFor(tree.wrapper)).toContain('truebuild-render-origin:generated')
        expect(registry.markerFor(tree.screen.parentNode!)).toBeUndefined()
        release()
    })
    it('discards an entire meter sample if a frame witness changes after that frame was visited', () => {
        const tree = fixture()
        const release = nativeFrameOrigins.bind(tree.anchor, document, { focused: true })
        Object.defineProperty(tree.coach.childNodes[0]!, 'id', {
            get: (): string => {
                tree.anchor.parentNode = new Node('RN:View')
                return ''
            },
        })
        expect(measure(tree.root)).toMatchObject({ status: 'unavailable', counts: null })
        release()
    })

    it('reports a failed overlapping native update as unavailable instead of retaining the old source', () => {
        const tree = fixture()
        const registry = new NativeFrameOriginRegistry()
        const first = registry.bind(tree.anchor, document, { focused: true })
        tree.wrapper.setNativeProps = (): never => {
            throw new Error('failed update')
        }
        const second = registry.bind(tree.anchor, document, { focused: true })
        expect(() => registry.markerFor(tree.wrapper)).toThrow('invalid_native_frame_origin')
        second()
        first()
    })
    it('retains fail-closed custody if a native writer changes the public ID and then throws', () => {
        const tree = fixture()
        const registry = new NativeFrameOriginRegistry()
        tree.wrapper.setNativeProps = (props: { nativeID: string }): never => {
            tree.wrapper.id = props.nativeID
            throw new Error('unknown command result')
        }
        const release = registry.bind(tree.anchor, document, { focused: true })
        expect(() => registry.markerFor(tree.wrapper)).toThrow('invalid_native_frame_origin')
        release()
    })

    it('keeps failed cleanup unavailable instead of claiming restoration succeeded', () => {
        const tree = fixture()
        const registry = new NativeFrameOriginRegistry()
        const release = registry.bind(tree.anchor, document, { focused: true })
        tree.wrapper.setNativeProps = (): never => {
            throw new Error('restore failed')
        }
        release()
        expect(() => registry.markerFor(tree.wrapper)).toThrow('invalid_native_frame_origin')
    })
    it.each(['update', 'cleanup'])('never claims a %s command succeeded after a native writer disappears', (action) => {
        const tree = fixture()
        const registry = new NativeFrameOriginRegistry()
        const release = registry.bind(tree.anchor, document, { focused: true })
        Object.defineProperty(tree.wrapper, 'setNativeProps', { value: undefined })
        if (action === 'update') registry.bind(tree.anchor, document, { focused: true })
        else release()
        expect(() => registry.markerFor(tree.wrapper)).toThrow('invalid_native_frame_origin')
        release()
    })
    it('reports a nonthrowing submission without claiming a native property read-back', () => {
        const tree = fixture()
        const registry = new NativeFrameOriginRegistry()
        const diagnostics: NativeFrameOriginDiagnostic[] = []
        // Public RN setNativeProps can silently do nothing. Source ownership is independent of native application.
        tree.wrapper.setNativeProps = (): void => undefined
        const release = registry.bind(tree.anchor, document, {
            focused: true,
            diagnostic: (entry): void => {
                diagnostics.push(entry)
            },
        })
        expect(tree.wrapper.id).toBe('')
        expect(tree.wrapper.commands).toEqual([])
        expect(registry.markerFor(tree.wrapper)).toContain('truebuild-render-origin:generated')
        expect(diagnostics).toContainEqual({
            nodeName: 'RN:RNSScreenContentWrapper',
            role: 'route',
            status: 'command-submitted',
            reason: 'native-id-invocation-returned',
        })
        release()
    })
})
