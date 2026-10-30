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

describe('coverage denominators and exclusions', () => {
    it('keeps capability internals in all-host totals, excludes development, and audits inherited source and raw leaves', () => {
        const root = element('', [
            element('truebuild-render-origin:generated', [
                element('', [text()], 'Text'),
                element('truebuild-capability-internals:CameraView', [
                    element('', [text()]),
                    element('truebuild-capability-internals:ManualPage', [element('', [text()], 'Text')]),
                ]),
                element(
                    'truebuild-meter-exclude:development',
                    [
                        element('truebuild-render-origin:fallback', [text()]),
                        element('truebuild-capability-internals:CoachMark', [element('', [text()], 'Text')]),
                    ],
                    'RN:DebuggingOverlay',
                ),
                element('truebuild-render-origin:shell', [], 'RN:RNSScreenStackHeaderConfig'),
            ]),
        ])
        const meter = new NativeHostMeter()
        meter.registerRoot(documentRoot(root))
        const sample = meter.sample(point)
        expect(sample).toMatchObject({
            metricsVersion: 3,
            status: 'measured',
            counts: { generated: 6, fallback: 0, shell: 2, total: 8 },
            rawTextCounts: { generated: 3, fallback: 0, shell: 0, total: 3 },
            strictStatus: 'measured',
            strictCounts: { generated: 2, fallback: 0, shell: 2, total: 4 },
            strictRawTextCounts: { generated: 1, fallback: 0, shell: 0, total: 1 },
            generatedShare: 6 / 8,
            strictGeneratedShare: 2 / 4,
            exclusions: {
                development: {
                    counts: { generated: 3, fallback: 1, shell: 0, total: 4 },
                    rawTextCounts: { generated: 1, fallback: 1, shell: 0, total: 2 },
                },
                capabilityInternals: {
                    counts: { generated: 4, fallback: 0, shell: 0, total: 4 },
                    rawTextCounts: { generated: 2, fallback: 0, shell: 0, total: 2 },
                },
                byCapability: {
                    CameraView: {
                        counts: { generated: 4, fallback: 0, shell: 0, total: 4 },
                        rawTextCounts: { generated: 2, fallback: 0, shell: 0, total: 2 },
                    },
                },
            },
        })
        expect(Object.keys(sample.exclusions?.byCapability ?? {})).toEqual(['CameraView'])
        expect(sample.strictByHostType?.Text).toEqual({ generated: 1, fallback: 0, shell: 0, total: 1 })
        expect(sample.strictByHostType?.['RN:RNSScreenStackHeaderConfig']?.shell).toBe(1)
    })

    it('excludes only an actual DebuggingOverlay subtree and rejects a marker on application content', () => {
        const meter = new NativeHostMeter()
        const stop = meter.registerRoot(
            documentRoot(
                element('', [
                    element('truebuild-render-origin:generated'),
                    element('', [element(), text()], 'RN:DebuggingOverlay'),
                ]),
            ),
        )
        expect(meter.sample(point)).toMatchObject({
            counts: { generated: 1, shell: 1, total: 2 },
            exclusions: { development: { counts: { shell: 2, total: 2 }, rawTextCounts: { shell: 1, total: 1 } } },
        })
        stop()
        meter.registerRoot(documentRoot(element('truebuild-meter-exclude:development', [element()])))
        expect(meter.sample(point)).toMatchObject({ status: 'unavailable', reason: 'invalid-marker', counts: null })
    })

    it('partitions development inside capability internals without double-counting nested boundaries', () => {
        const meter = new NativeHostMeter()
        meter.registerRoot(
            documentRoot(
                element('truebuild-render-origin:generated', [
                    element('truebuild-capability-internals:CameraView', [
                        element(
                            'truebuild-meter-exclude:development',
                            [element('truebuild-capability-internals:ManualPage', [text()])],
                            'RN:DebuggingOverlay',
                        ),
                    ]),
                ]),
            ),
        )
        const sample = meter.sample(point)
        expect(sample.counts).toEqual({ generated: 2, fallback: 0, shell: 0, total: 2 })
        expect(sample.strictCounts).toEqual({ generated: 1, fallback: 0, shell: 0, total: 1 })
        expect(sample.exclusions?.development.counts.total).toBe(2)
        expect(sample.exclusions?.development.rawTextCounts.total).toBe(1)
        expect(sample.exclusions?.capabilityInternals.counts.total).toBe(1)
        expect(Object.keys(sample.exclusions?.byCapability ?? {})).toEqual(['CameraView'])
    })

    it('audits source overrides inside native internals without reading or retaining private content', () => {
        const raw = Object.defineProperties(text(), {
            textContent: {
                get: (): never => {
                    throw new Error('must not read text')
                },
            },
            nodeValue: {
                get: (): never => {
                    throw new Error('must not read text')
                },
            },
        })
        const meter = new NativeHostMeter()
        meter.registerRoot(
            documentRoot(
                element('truebuild-render-origin:generated', [
                    element('truebuild-capability-internals:PieceTile', [
                        element('truebuild-render-origin:fallback', [
                            element('private-unrelated-native-id', [raw], 'Text'),
                        ]),
                    ]),
                ]),
            ),
        )
        const sample = meter.sample(point)
        expect(sample.status).toBe('measured')
        expect(sample.counts).toEqual({ generated: 2, fallback: 2, shell: 0, total: 4 })
        expect(sample.strictCounts).toEqual(sample.counts)
        expect(sample.exclusions?.byCapability.PieceTile).toBeUndefined()
        expect(JSON.stringify(sample)).not.toContain('private-unrelated-native-id')
    })

    it.each([
        'truebuild-capability-internals',
        'truebuild-capability-internals:',
        'truebuild-capability-internals:Unknown',
        'truebuild-capability-internals:NavigationHeader',
        'truebuild-meter-exclude',
        'truebuild-meter-exclude:',
        'truebuild-meter-exclude:production',
        'truebuild-render-origin:invented',
        'truebuild-render-orign:generated',
    ])('fails closed for reserved marker %s even inside a development exclusion', (id) => {
        const meter = new NativeHostMeter()
        meter.registerRoot(
            documentRoot(
                element('', [
                    element('truebuild-render-origin:generated'),
                    element('truebuild-meter-exclude:development', [element(id)], 'RN:DebuggingOverlay'),
                ]),
            ),
        )
        expect(meter.sample(point)).toMatchObject({
            status: 'unavailable',
            reason: 'invalid-marker',
            counts: null,
            generatedShare: null,
            strictStatus: 'unavailable',
            strictCounts: null,
            strictGeneratedShare: null,
            exclusions: null,
        })
    })

    it.each([
        ['truebuild-meter-exclude:development', 'RN:DebuggingOverlay', 'RN:RNSScreenStackHeaderSubview'],
        ['truebuild-capability-internals:CameraView', 'View', 'RN:RNSScreenStackHeaderSubview'],
        ['truebuild-capability-internals:ManualPage', 'View', 'RN:RNSModalScreen'],
    ])('never hides navigation chrome beneath %s', (id, parentName, childName) => {
        const meter = new NativeHostMeter()
        meter.registerRoot(documentRoot(element('', [element(id, [element('', [], childName)], parentName)])))
        expect(meter.sample(point)).toMatchObject({
            status: 'unavailable',
            reason: 'invalid-marker',
            counts: null,
            strictCounts: null,
            exclusions: null,
        })
    })

    it('retains the complete exclusion census at a zero denominator and never turns it into a percentage', () => {
        const meter = new NativeHostMeter()
        const remove = meter.registerRoot(
            documentRoot(element('truebuild-meter-exclude:development', [text()], 'RN:DebuggingOverlay')),
        )
        expect(meter.sample(point)).toMatchObject({
            status: 'unavailable',
            reason: 'empty-tree',
            counts: null,
            generatedShare: null,
            strictStatus: 'unavailable',
            strictReason: 'empty-tree',
            strictCounts: null,
            strictGeneratedShare: null,
            exclusions: { development: { counts: { shell: 1, total: 1 }, rawTextCounts: { shell: 1, total: 1 } } },
        })
        remove()
        meter.registerRoot(documentRoot(element('truebuild-capability-internals:ManualPage')))
        expect(meter.sample(point)).toMatchObject({
            status: 'measured',
            counts: { shell: 1, total: 1 },
            generatedShare: 0,
            strictStatus: 'unavailable',
            strictCounts: null,
            strictGeneratedShare: null,
            strictReason: 'empty-tree',
            exclusions: { capabilityInternals: { counts: { shell: 1, total: 1 } } },
        })
        expect(meter.summarizeSession(point.sessionId, point.platform)).toMatchObject({
            status: 'measured',
            generatedShare: 0,
            strictStatus: 'unavailable',
            strictGeneratedShare: null,
            meanRouteGeneratedShare: 0,
            meanRouteStrictGeneratedShare: null,
        })
    })

    it('still checks connectivity and traversal bounds within excluded native internals', () => {
        const excluded = element('truebuild-capability-internals:CameraView', [element()])
        const disconnected = Object.defineProperty(excluded.childNodes[0]!, 'isConnected', { value: false })
        const meter = new NativeHostMeter()
        const remove = meter.registerRoot(documentRoot(element('', [excluded])))
        expect(meter.sample(point)).toMatchObject({ status: 'unavailable', reason: 'disconnected', exclusions: null })
        remove()
        const bounded = new NativeHostMeter({ maxNodes: 2 })
        bounded.registerRoot(
            documentRoot(
                element('truebuild-meter-exclude:development', [element('', [disconnected])], 'RN:DebuggingOverlay'),
            ),
        )
        expect(bounded.sample(point)).toMatchObject({
            status: 'unavailable',
            reason: 'traversal-limit',
            exclusions: null,
        })
    })
})

describe('route-balanced coverage', () => {
    it('averages weighted route shares without overweighting large routes or replayed checkpoints', () => {
        const meter = new NativeHostMeter()
        const home = { ...point, screen: 'home' }
        const stopHome = meter.registerRoot(documentRoot(element('truebuild-render-origin:generated')))
        meter.sample(home)
        meter.sample(home)
        meter.sample({ ...home, checkpointId: 'other-state' })
        stopHome()
        const stopGuide = meter.registerRoot(
            documentRoot(
                element('', [
                    element('truebuild-render-origin:generated', [
                        element('truebuild-capability-internals:CameraView', [element()]),
                    ]),
                ]),
            ),
        )
        meter.sample(point)
        const session = meter.summarizeSession(point.sessionId, point.platform)
        expect(session).toMatchObject({
            metricsVersion: 3,
            sampleCount: 3,
            counts: { generated: 5, fallback: 0, shell: 1, total: 6 },
            generatedShare: 5 / 6,
            strictCounts: { generated: 3, fallback: 0, shell: 1, total: 4 },
            strictGeneratedShare: 3 / 4,
            meanRouteGeneratedShare: (1 + 3 / 4) / 2,
            meanRouteStrictGeneratedShare: (1 + 1 / 2) / 2,
        })
        expect(
            session.routes.map((route) => [
                route.route,
                route.sampleCount,
                route.counts?.total,
                route.generatedShare,
                route.strictGeneratedShare,
            ]),
        ).toEqual([
            ['home', 2, 2, 1, 1],
            ['guide', 1, 4, 3 / 4, 1 / 2],
        ])
        expect(session.exclusions?.byCapability.CameraView?.counts.total).toBe(2)
        stopGuide()
        meter.registerRoot(documentRoot(element('truebuild-render-origin:fallback')))
        meter.sample(home)
        const replacement = meter.summarizeSession(point.sessionId, point.platform)
        expect(replacement.sampleCount).toBe(3)
        expect(replacement.meanRouteGeneratedShare).toBe((1 / 2 + 3 / 4) / 2)
        expect(replacement.meanRouteStrictGeneratedShare).toBe((1 / 2 + 1 / 2) / 2)
    })

    it('keeps failed routes in the matrix and makes every dependent mean unavailable', () => {
        const meter = new NativeHostMeter()
        meter.registerRoot(documentRoot(element('truebuild-render-origin:generated')))
        meter.sample({ ...point, screen: 'home' })
        meter.registerRoot(null)
        meter.sample(point)
        const session = meter.summarizeSession(point.sessionId, point.platform)
        expect(session).toMatchObject({
            status: 'unavailable',
            counts: null,
            generatedShare: null,
            strictStatus: 'unavailable',
            strictCounts: null,
            strictGeneratedShare: null,
            meanRouteGeneratedShare: null,
            meanRouteStrictGeneratedShare: null,
            exclusions: null,
        })
        expect(session.routes.map((route) => [route.route, route.status])).toEqual([
            ['home', 'measured'],
            ['guide', 'unavailable'],
        ])
    })
})

describe('focused visible method beside the mounted census', () => {
    function refAt(node: NativeHostNode, root: NativeHostNode): NativeHostRoot {
        return Object.assign(node, { ownerDocument: { documentElement: root } })
    }

    it('keeps wrapper own-host attribution without passing it to native navigation or unrelated route descendants', () => {
        const focused = element('truebuild-document-root:guide|truebuild-render-origin:generated', [element()])
        const background = element('truebuild-document-root:home|truebuild-render-origin:generated', [element()])
        const tree = element(
            '',
            [
                element('truebuild-document-navigation:app|truebuild-render-origin:generated', [
                    element(
                        '',
                        [
                            element(
                                '',
                                [
                                    element(
                                        'truebuild-document-content-boundary:home|truebuild-render-origin:fallback',
                                        [element('', [background], 'SafeAreaView')],
                                    ),
                                ],
                                'RN:RNSScreen',
                            ),
                            element(
                                '',
                                [
                                    element('', [], 'RN:RNSScreenStackHeaderConfig'),
                                    element(
                                        'truebuild-document-content-boundary:guide|truebuild-render-origin:generated',
                                        [element('', [focused], 'SafeAreaView')],
                                    ),
                                ],
                                'RN:RNSScreen',
                            ),
                        ],
                        'RN:RNSScreenStack',
                    ),
                ]),
            ],
            'RootView',
        )
        const meter = new NativeHostMeter()
        meter.registerRoot(refAt(focused, tree), { kind: 'app', screen: 'guide', focused: true })
        meter.registerRoot(refAt(background, tree), { kind: 'app', screen: 'home', focused: false })
        const sample = meter.sample(point)
        expect(sample.methods.allMounted.counts).toEqual({ generated: 6, fallback: 1, shell: 7, total: 14 })
        expect(sample.methods.focusedVisible.counts).toEqual({ generated: 4, fallback: 0, shell: 5, total: 9 })
        for (const method of Object.values(sample.methods)) {
            expect(method.byHostType?.['RN:RNSScreenStack']).toMatchObject({ generated: 0, shell: 1 })
            expect(method.byHostType?.['RN:RNSScreenStackHeaderConfig']).toMatchObject({ generated: 0, shell: 1 })
            expect(method.byHostType?.SafeAreaView?.generated).toBe(0)
        }
    })

    it('selects an iOS modal screen with a full-window coach and excludes retained closing modal content', () => {
        const body = element('truebuild-document-root:camera|truebuild-render-origin:generated')
        const previous = element('truebuild-render-origin:fallback', [element()])
        const coach = element('', [element('', [], 'Text')])
        const closing = element('truebuild-render-origin:fallback', [element()])
        const tree = element(
            '',
            [
                element('', [previous], 'RN:RNSScreen'),
                element('', [body], 'RN:RNSModalScreen'),
                element('', [coach], 'RN:RNSFullWindowOverlay'),
                element('', [closing], 'RN:RCTModalHostView'),
            ],
            'RootView',
        )
        const meter = new NativeHostMeter()
        const cameraPoint = { ...point, screen: 'camera' }
        meter.registerRoot(refAt(body, tree), { kind: 'app', screen: 'camera', focused: true })
        meter.registerRoot(refAt(previous, tree), { kind: 'app', screen: 'guide', focused: false })
        meter.registerRoot(refAt(coach, tree), { kind: 'coach', visible: true })
        meter.registerRoot(refAt(closing, tree), { kind: 'sheet', visible: false })
        const sample = meter.sample(cameraPoint)
        expect(sample.methods.allMounted.counts).toEqual({ generated: 1, fallback: 4, shell: 7, total: 12 })
        expect(sample.methods.focusedVisible).toMatchObject({
            status: 'measured',
            counts: { generated: 1, fallback: 0, shell: 5, total: 6 },
            selection: {
                boundary: 'native-screen',
                overlayRootCount: 1,
                background: { counts: { generated: 0, fallback: 4, shell: 2, total: 6 } },
            },
            byHostType: {
                'RN:RNSModalScreen': { generated: 0, shell: 1 },
                'RN:RNSFullWindowOverlay': { generated: 0, shell: 1 },
            },
        })
    })

    it('prunes mounted background screens while retaining focused screen, safe area and native header mechanics', () => {
        const focused = element('truebuild-document-root:guide|truebuild-render-origin:generated', [element()])
        const background = element('truebuild-render-origin:generated', [element(), element()])
        const tree = element(
            '',
            [
                element('', [element('', [background], 'SafeAreaView')], 'RN:RNSScreen'),
                element(
                    '',
                    [element('', [], 'RN:RNSScreenStackHeaderConfig'), element('', [focused], 'SafeAreaView')],
                    'RN:RNSScreen',
                ),
            ],
            'RootView',
        )
        const meter = new NativeHostMeter()
        meter.registerRoot(refAt(focused, tree), { kind: 'app', screen: 'guide', focused: true })
        meter.registerRoot(refAt(background, tree), { kind: 'app', screen: 'home', focused: false })
        const sample = meter.sample(point)
        expect(sample.methods.allMounted.counts).toEqual({ generated: 5, fallback: 0, shell: 6, total: 11 })
        expect(sample.methods.focusedVisible).toMatchObject({
            method: 'focused-visible-native-hosts',
            status: 'measured',
            counts: { generated: 2, fallback: 0, shell: 4, total: 6 },
            byHostType: {
                'RN:RNSScreen': { shell: 1, total: 1 },
                'RN:RNSScreenStackHeaderConfig': { shell: 1, total: 1 },
            },
            selection: {
                background: { counts: { generated: 3, shell: 2, total: 5 } },
                focusedRootCount: 1,
                overlayRootCount: 0,
            },
        })
    })

    it('unions a visible modal nested beneath a background screen without recovering its background content', () => {
        const focused = element('truebuild-render-origin:generated')
        const sheet = element('truebuild-document-root:sheet|truebuild-render-origin:fallback', [element()])
        const background = element('', [element(), element('', [sheet], 'RN:ModalHostView')])
        const tree = element(
            '',
            [element('', [focused], 'RN:RNSScreen'), element('', [background], 'RN:RNSScreen')],
            'RootView',
        )
        const meter = new NativeHostMeter()
        meter.registerRoot(refAt(focused, tree), { kind: 'app', screen: 'guide', focused: true })
        meter.registerRoot(refAt(background, tree), { kind: 'app', screen: 'home', focused: false })
        meter.registerRoot(refAt(sheet, tree), { kind: 'sheet', visible: true })
        const sample = meter.sample(point)
        expect(sample.methods.focusedVisible).toMatchObject({
            status: 'measured',
            counts: { generated: 1, fallback: 2, shell: 3, total: 6 },
            selection: { focusedRootCount: 1, overlayRootCount: 1 },
        })
        expect(meter.summarizeSession(point.sessionId, point.platform).methods.focusedVisible).toMatchObject({
            status: 'measured',
            meanRouteGeneratedShare: 1 / 6,
            minimumScreenGeneratedShare: 1 / 6,
            routes: [{ route: 'guide', counts: { total: 6 } }],
        })
    })

    it('does not union a hidden modal or a mounted camera under a background screen', () => {
        const body = element('truebuild-render-origin:generated')
        const camera = element('truebuild-render-origin:generated', [element()])
        const sheet = element('truebuild-render-origin:fallback')
        const tree = element(
            '',
            [
                element('', [body, element('', [sheet], 'RN:ModalHostView')], 'RN:RNSScreen'),
                element('', [camera], 'RN:RNSScreen'),
            ],
            'RootView',
        )
        const meter = new NativeHostMeter()
        meter.registerRoot(refAt(body, tree), { kind: 'app', screen: 'guide', focused: true })
        meter.registerRoot(refAt(camera, tree), { kind: 'app', screen: 'camera', focused: false })
        meter.registerRoot(refAt(camera, tree), { kind: 'camera' })
        meter.registerRoot(refAt(sheet, tree), { kind: 'sheet', visible: false })
        expect(meter.sample(point).methods.focusedVisible).toMatchObject({
            status: 'measured',
            counts: { generated: 1, fallback: 0, shell: 2, total: 3 },
            selection: { overlayRootCount: 0 },
        })
    })

    it('never marks navigation generated because it contains a generated document', () => {
        const body = element('truebuild-document-root:abc|truebuild-render-origin:generated')
        const tree = element(
            '',
            [element('', [element('', [], 'RN:RNSScreenStackHeaderConfig'), body], 'RN:RNSScreen')],
            'RootView',
        )
        const meter = new NativeHostMeter()
        meter.registerRoot(refAt(body, tree), { kind: 'app', screen: 'guide', focused: true })
        expect(meter.sample(point).methods.focusedVisible.counts).toEqual({
            generated: 1,
            fallback: 0,
            shell: 3,
            total: 4,
        })
    })

    it('keeps mounted counts but fails focused selection closed when focus metadata or the selected host is missing', () => {
        const meter = new NativeHostMeter()
        const tree = element('truebuild-render-origin:generated')
        const stop = meter.registerRoot(documentRoot(tree))
        expect(meter.sample(point).methods.focusedVisible).toMatchObject({
            status: 'unavailable',
            counts: null,
            reason: 'focus-unavailable',
        })
        stop()
        meter.registerRoot(refAt(element(), tree), { kind: 'app', screen: 'guide', focused: true })
        expect(meter.sample(point).methods.focusedVisible).toMatchObject({
            status: 'unavailable',
            counts: null,
            reason: 'missing-root',
        })
        expect(meter.sample(point).methods.allMounted.status).toBe('measured')
    })

    it.each([
        [true, true, 'guide'],
        [false, false, 'guide'],
        [true, false, 'other'],
    ])('fails closed on conflicting, absent, or stale router focus (%s, %s, %s)', (one, two, screen) => {
        const body = element('truebuild-render-origin:generated')
        const other = element('truebuild-render-origin:fallback')
        const tree = element('', [element('', [body], 'RN:RNSScreen'), element('', [other], 'RN:RNSScreen')])
        const meter = new NativeHostMeter()
        meter.registerRoot(refAt(body, tree), { kind: 'app', screen, focused: one })
        meter.registerRoot(refAt(other, tree), { kind: 'app', screen: 'home', focused: two })
        expect(meter.sample(point).methods.focusedVisible).toMatchObject({
            status: 'unavailable',
            reason: 'focus-unavailable',
            counts: null,
        })
    })

    it('does not claim a focused native denominator when multiple route boundaries cannot be identified', () => {
        const body = element('truebuild-render-origin:generated')
        const other = element('truebuild-render-origin:fallback')
        const tree = element('', [element('', [body], 'UnknownScreen'), element('', [other], 'UnknownScreen')])
        const meter = new NativeHostMeter()
        meter.registerRoot(refAt(body, tree), { kind: 'app', screen: 'guide', focused: true })
        meter.registerRoot(refAt(other, tree), { kind: 'app', screen: 'home', focused: false })
        expect(meter.sample(point).methods.focusedVisible).toMatchObject({
            status: 'unavailable',
            reason: 'unsupported-tree',
            counts: null,
        })
    })

    it.each([
        'truebuild-render-origin:generated|truebuild-render-origin:fallback',
        'truebuild-render-origin:generated|truebuild-render-orign:generated',
    ])('validates every background node before publishing either method (%s)', (invalid) => {
        const body = element('truebuild-render-origin:generated')
        const tree = element('', [element('', [body], 'RN:RNSScreen'), element(invalid)])
        const meter = new NativeHostMeter()
        meter.registerRoot(refAt(body, tree), { kind: 'app', screen: 'guide', focused: true })
        const sample = meter.sample(point)
        expect(sample.methods.allMounted).toMatchObject({
            status: 'unavailable',
            reason: 'invalid-marker',
            counts: null,
        })
        expect(sample.methods.focusedVisible).toMatchObject({
            status: 'unavailable',
            reason: 'invalid-marker',
            counts: null,
        })
    })
})
