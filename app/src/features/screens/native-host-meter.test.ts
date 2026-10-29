import { describe, expect, it } from 'vitest'
import type { JsonElement } from 'test-renderer'

import { measureRenderOriginTree } from '../../ui/test-support/render-origin-coverage'
import {
    NativeHostMeter,
    type NativeHostCheckpoint,
    type NativeHostNode,
    type NativeHostRoot,
} from './native-host-meter'

// Structural doubles of only the public DOM read port. No RN bridge, Fiber, global hook or native-device claim.
function element(id = '', children: NativeHostNode[] = [], nodeName = 'View'): NativeHostNode {
    return { nodeType: 1, nodeName, isConnected: true, id, childNodes: children }
}

function documentRoot(node: NativeHostNode): NativeHostRoot {
    return { isConnected: true, ownerDocument: { documentElement: node } }
}

const point: NativeHostCheckpoint = {
    sessionId: 'meter-session',
    platform: 'ios',
    screen: 'guide',
    checkpointId: 'ready',
}

const text = (): NativeHostNode => ({ nodeType: 3, nodeName: '#text', isConnected: true, childNodes: [] })

function jsonHost(type: string, nativeID: string, children: (JsonElement | string)[] = []): JsonElement {
    return { $$typeof: Symbol.for('react.test.json'), type, props: { nativeID }, children }
}

describe('native host measurement', () => {
    it('matches the shared host reducer for nested marker inheritance and counts raw text separately', () => {
        const root = element('', [
            element('truebuild-render-origin:generated', [
                element('', [text()], 'Text'),
                element('truebuild-render-origin:fallback', [element('', [text()], 'Text')]),
                element('truebuild-render-origin:shell'),
            ]),
            element('ordinary-id', [text(), text()], 'Text'),
        ])
        const meter = new NativeHostMeter({ now: (): number => 123 })
        meter.registerRoot(documentRoot(root))
        const measured = meter.sample(point)
        expect(measured).toMatchObject({
            status: 'measured',
            counts: { generated: 2, fallback: 2, shell: 3, total: 7 },
            rawTextCounts: { generated: 1, fallback: 1, shell: 2, total: 4 },
            rootCount: 1,
            sampledAt: 123,
            generatedShare: 2 / 7,
        })
        const json = jsonHost('View', '', [
            jsonHost('View', 'truebuild-render-origin:generated', [
                jsonHost('Text', '', ['raw']),
                jsonHost('View', 'truebuild-render-origin:fallback', [jsonHost('Text', '', ['raw'])]),
                jsonHost('View', 'truebuild-render-origin:shell'),
            ]),
            jsonHost('Text', 'ordinary-id', ['raw', 'raw']),
        ])
        const shared = measureRenderOriginTree(json, { ...point, evidence: 'synthetic-fixture' })
        expect(measured.counts).toEqual(shared.counts)
        expect(measured.byHostType).toEqual(shared.byHostType)
        expect(measured.rawTextCounts).toEqual(shared.rawTextCounts)
    })

    it('deduplicates registered document roots and unregisters each registration independently', () => {
        const ref = documentRoot(element('', [element('truebuild-render-origin:generated')]))
        const meter = new NativeHostMeter()
        const one = meter.registerRoot(ref)
        const two = meter.registerRoot(ref)
        expect(meter.sample(point)).toMatchObject({ rootCount: 1, counts: { generated: 1, shell: 1, total: 2 } })
        one()
        one()
        expect(meter.sample(point).rootCount).toBe(1)
        two()
        expect(meter.sample(point)).toMatchObject({ status: 'unavailable', reason: 'no-roots', generatedShare: null })
    })

    it('counts an empty document element as a real shell host and includes every independent root', () => {
        const meter = new NativeHostMeter()
        meter.registerRoot(documentRoot(element('', [], 'RootView')))
        meter.registerRoot(documentRoot(element('truebuild-render-origin:generated')))
        expect(meter.sample(point)).toMatchObject({
            status: 'measured',
            rootCount: 2,
            counts: { generated: 1, fallback: 0, shell: 1, total: 2 },
        })
    })

    it.each(['truebuild-render-origin', 'truebuild-render-origin:', 'truebuild-render-origin:unknown'])(
        'rejects malformed marker %s without retaining a partial percentage',
        (id) => {
            const meter = new NativeHostMeter()
            meter.registerRoot(documentRoot(element('', [element('truebuild-render-origin:generated'), element(id)])))
            expect(meter.sample(point)).toMatchObject({
                status: 'unavailable',
                reason: 'invalid-marker',
                counts: null,
                byHostType: null,
                rawTextCounts: null,
                generatedShare: null,
            })
        },
    )

    it('never reads or retains text, arbitrary props or unrelated ids', () => {
        const raw = Object.defineProperties(text(), {
            textContent: {
                get: (): never => {
                    throw new Error('text must not be read')
                },
            },
            nodeValue: {
                get: (): never => {
                    throw new Error('value must not be read')
                },
            },
            props: {
                get: (): never => {
                    throw new Error('props must not be read')
                },
            },
        })
        const meter = new NativeHostMeter()
        meter.registerRoot(documentRoot(element('private-unrelated-id', [raw])))
        const checkpointWithExtra = { ...point, text: 'do-not-retain-checkpoint-extra' }
        const result = meter.sample(checkpointWithExtra)
        expect(result.status).toBe('measured')
        expect(result.rawTextCounts?.total).toBe(1)
        expect(JSON.stringify(result)).not.toContain('private-unrelated-id')
        expect(JSON.stringify(result)).not.toContain('do-not-retain-checkpoint-extra')
    })
})

describe('incomplete native root census', () => {
    it('rejects missing or disconnected registrations instead of measuring only the remaining root', () => {
        const meter = new NativeHostMeter()
        meter.registerRoot(documentRoot(element('truebuild-render-origin:generated')))
        const missing = meter.registerRoot(null)
        expect(meter.sample(point)).toMatchObject({ status: 'unavailable', reason: 'missing-root', counts: null })
        missing()
        meter.registerRoot({ isConnected: false, ownerDocument: null })
        expect(meter.sample(point)).toMatchObject({ status: 'unavailable', reason: 'disconnected', counts: null })
    })

    it('detects a node that loses connectivity during traversal and discards the complete numerator', () => {
        let connected = true
        const root = Object.defineProperty(element('', [element('truebuild-render-origin:generated')]), 'isConnected', {
            get: (): boolean => connected,
        })
        const child = root.childNodes[0]!
        Object.defineProperty(child, 'id', {
            get: (): string => {
                connected = false
                return 'truebuild-render-origin:generated'
            },
        })
        const meter = new NativeHostMeter()
        meter.registerRoot(documentRoot(root))
        expect(meter.sample(point)).toMatchObject({
            status: 'unavailable',
            reason: 'disconnected',
            generatedShare: null,
        })
    })

    it('rejects a root whose public document changes during sampling', () => {
        let document = { documentElement: element('truebuild-render-origin:generated') }
        const original = document.documentElement
        Object.defineProperty(original, 'id', {
            get: (): string => {
                document = { documentElement: element() }
                return 'truebuild-render-origin:generated'
            },
        })
        const meter = new NativeHostMeter()
        meter.registerRoot({
            isConnected: true,
            get ownerDocument(): NativeHostRoot['ownerDocument'] {
                return document
            },
        })
        expect(meter.sample(point)).toMatchObject({
            status: 'unavailable',
            reason: 'root-census-changed',
            counts: null,
        })
    })

    it('fails closed on unsupported nodes, cycles, thrown native reads and traversal overflow', () => {
        const cycle = element()
        Object.defineProperty(cycle, 'childNodes', { value: [cycle] })
        const throwing = Object.defineProperty(element(), 'childNodes', {
            get: (): never => {
                throw new Error('native')
            },
        })
        for (const root of [element('', [], 'Bad'), cycle, throwing]) {
            if (root.nodeName === 'Bad') Object.defineProperty(root, 'nodeType', { value: 8 })
            const meter = new NativeHostMeter()
            meter.registerRoot(documentRoot(root))
            expect(meter.sample(point).status).toBe('unavailable')
        }
        const bounded = new NativeHostMeter({ maxNodes: 2 })
        const ref = documentRoot(element('', [element('truebuild-render-origin:generated')]))
        const remove = bounded.registerRoot(ref)
        expect(bounded.sample(point).status).toBe('measured')
        remove()
        bounded.registerRoot(documentRoot(element('', [element(), element()])))
        expect(bounded.sample(point)).toMatchObject({ status: 'unavailable', reason: 'traversal-limit', counts: null })
    })
})

describe('checkpoint state and summaries', () => {
    it('replaces a stable checkpoint on resample and keeps screen minima with weighted session totals', () => {
        const meter = new NativeHostMeter()
        const root = element('truebuild-render-origin:generated')
        meter.registerRoot(documentRoot(root))
        meter.sample(point)
        Object.defineProperty(root, 'id', { value: '', configurable: true })
        meter.sample(point)
        meter.sample({ ...point, screen: 'home', checkpointId: 'empty' })
        Object.defineProperty(root, 'id', { value: 'truebuild-render-origin:generated' })
        meter.sample({ ...point, checkpointId: 'result' })
        const summary = meter.summarizeSession(point.sessionId, point.platform)
        expect(summary).toMatchObject({
            status: 'measured',
            sampleCount: 3,
            counts: { generated: 1, fallback: 0, shell: 2, total: 3 },
            generatedShare: 1 / 3,
            minimumScreenGeneratedShare: 0,
        })
        expect(
            summary.screens.map((screen) => [screen.screen, screen.sampleCount, screen.minimumGeneratedShare]),
        ).toEqual([
            ['guide', 2, 0],
            ['home', 1, 0],
        ])
    })

    it('does not hide an unavailable replacement or combine another session or platform', () => {
        const meter = new NativeHostMeter()
        const remove = meter.registerRoot(documentRoot(element('truebuild-render-origin:generated')))
        meter.sample(point)
        meter.sample({ ...point, sessionId: 'other' })
        meter.sample({ ...point, platform: 'android' })
        remove()
        meter.sample(point)
        expect(meter.summarizeSession(point.sessionId, 'ios')).toMatchObject({
            status: 'unavailable',
            sampleCount: 1,
            counts: null,
            generatedShare: null,
        })
        expect(meter.summarizeSession(point.sessionId, 'android').status).toBe('measured')
        expect(meter.summarizeSession('other', 'ios').status).toBe('measured')
        expect(meter.summarizeSession('unknown', 'ios').status).toBe('unavailable')
    })

    it('clears only the requested session and platform and releases its last snapshot', () => {
        const meter = new NativeHostMeter()
        meter.registerRoot(documentRoot(element('truebuild-render-origin:generated')))
        meter.sample({ ...point, platform: 'android' })
        meter.sample(point)
        meter.clearSession(point.sessionId, point.platform)
        expect(meter.getSnapshot()).toMatchObject({ stale: true, latest: null })
        expect(meter.summarizeSession(point.sessionId, point.platform).reason).toBe('no-checkpoints')
        expect(meter.summarizeSession(point.sessionId, 'android').status).toBe('measured')
        expect(meter.sample(point).status).toBe('measured')
    })

    it('publishes stable snapshots, marks old samples stale on root changes and removes subscriptions on cleanup', () => {
        const meter = new NativeHostMeter()
        const before = meter.getSnapshot()
        expect(meter.getSnapshot()).toBe(before)
        let notifications = 0
        const unsubscribe = meter.subscribe((): void => {
            notifications++
        })
        const remove = meter.registerRoot(documentRoot(element()))
        meter.sample(point)
        expect(meter.getSnapshot().stale).toBe(false)
        meter.markStale()
        expect(meter.getSnapshot().stale).toBe(true)
        expect(notifications).toBe(3)
        unsubscribe()
        remove()
        expect(notifications).toBe(3)
        meter.dispose()
        expect(meter.getSnapshot()).toMatchObject({ latest: null, stale: true })
        expect(meter.sample(point)).toMatchObject({ status: 'unavailable', reason: 'disposed' })
    })
})
