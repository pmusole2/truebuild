import type { ReactElement } from 'react'
import { Text, View } from 'react-native'
import { render } from '@testing-library/react-native'
import {
    measureRenderOriginTree,
    summarizeRenderOriginSession,
    type RenderOriginCheckpoint,
} from './render-origin-coverage'

// Synthetic trees only. These measure rendered native host elements, never provider or physical-device output.
const checkpoint: RenderOriginCheckpoint = {
    sessionId: 'synthetic-build-1',
    screen: 'guide',
    checkpointId: 'ready',
    platform: 'ios',
    evidence: 'synthetic-fixture',
}

function nestedTree(): ReactElement {
    return (
        <View testID="screen">
            <View nativeID="truebuild-render-origin:generated" testID="generated">
                <Text>Private generated text</Text>
                <View nativeID="truebuild-render-origin:fallback" testID="fallback">
                    <Text>Private fallback text</Text>
                </View>
                <View nativeID="truebuild-render-origin:shell" testID="nested-shell" />
            </View>
            <Text nativeID="ordinary-native-id">
                {'Private shell text'}
                {27}
                {false}
                {null}
            </Text>
        </View>
    )
}

it('counts every actual host element with nearest marker inheritance, without counting text or the renderer container', async () => {
    const view = await render(nestedTree())
    const result = measureRenderOriginTree(view.toJSON(), checkpoint)

    expect(result.counts).toEqual({ generated: 2, fallback: 2, shell: 3, total: 7 })
    expect(result.byHostType).toEqual({
        View: { generated: 1, fallback: 1, shell: 2, total: 4 },
        Text: { generated: 1, fallback: 1, shell: 1, total: 3 },
    })
    expect(result.rawTextCounts).toEqual({ generated: 1, fallback: 1, shell: 2, total: 4 })
    expect(result.status).toBe('measured')
    expect(result.generatedShare).toBe(2 / 7)
    expect(result.checkpoint).toEqual(checkpoint)
    expect(result.nodes).toEqual([
        { path: '$', hostType: 'View', origin: 'shell', testID: 'screen' },
        { path: '$/0', hostType: 'View', origin: 'generated', testID: 'generated' },
        { path: '$/0/0', hostType: 'Text', origin: 'generated' },
        { path: '$/0/1', hostType: 'View', origin: 'fallback', testID: 'fallback' },
        { path: '$/0/1/0', hostType: 'Text', origin: 'fallback' },
        { path: '$/0/2', hostType: 'View', origin: 'shell', testID: 'nested-shell' },
        { path: '$/1', hostType: 'Text', origin: 'shell' },
    ])
    expect(JSON.stringify(result)).not.toContain('Private')
    expect(JSON.stringify(result)).not.toContain('ordinary-native-id')
})

it('traverses the renderer container for multiple roots without treating it as a native shell host', async () => {
    const view = await render(
        <>
            <View nativeID="truebuild-render-origin:generated" />
            <View nativeID="truebuild-render-origin:fallback">
                <Text>Fallback</Text>
            </View>
        </>,
    )
    const result = measureRenderOriginTree(view.toJSON(), checkpoint)
    expect(result.counts).toEqual({ generated: 1, fallback: 2, shell: 0, total: 3 })
    expect(result.nodes).toEqual([
        { path: '$/0', hostType: 'View', origin: 'generated' },
        { path: '$/1', hostType: 'View', origin: 'fallback' },
        { path: '$/1/0', hostType: 'Text', origin: 'fallback' },
    ])
})

it('credits navigation and route boundary hosts only, then requires explicit document descendant markers', async () => {
    const view = await render(
        <View nativeID="truebuild-document-navigation:app|truebuild-render-origin:generated" testID="navigation">
            <View testID="native-screen">
                <View testID="native-header" />
                <View
                    nativeID="truebuild-document-content-boundary:guide|truebuild-render-origin:fallback"
                    testID="route"
                >
                    <View testID="safe-area">
                        <Text testID="framework-chrome">Shell chrome</Text>
                        <View nativeID="truebuild-document-root:guide|truebuild-render-origin:generated" testID="body">
                            <Text testID="document-child">Generated body</Text>
                        </View>
                    </View>
                </View>
            </View>
            <View testID="background-route" />
            <Text testID="coach">Shell coach</Text>
        </View>,
    )
    const result = measureRenderOriginTree(view.toJSON(), checkpoint)
    expect(result.counts).toEqual({ generated: 3, fallback: 1, shell: 6, total: 10 })
    expect(Object.fromEntries(result.nodes.map((node) => [node.testID, node.origin]))).toEqual({
        navigation: 'generated',
        'native-screen': 'shell',
        'native-header': 'shell',
        route: 'fallback',
        'safe-area': 'shell',
        'framework-chrome': 'shell',
        body: 'generated',
        'document-child': 'generated',
        'background-route': 'shell',
        coach: 'shell',
    })
    expect(result.rawTextCounts).toEqual({ generated: 1, fallback: 0, shell: 2, total: 3 })
})

it('keeps hidden and non-accessible supplied hosts in the denominator', async () => {
    const view = await render(
        <View nativeID="truebuild-render-origin:generated">
            <View nativeID="truebuild-render-origin:shell" style={{ display: 'none' }} accessibilityElementsHidden>
                <Text>Hidden shell</Text>
            </View>
        </View>,
    )
    expect(measureRenderOriginTree(view.toJSON(), checkpoint).counts).toEqual({
        generated: 1,
        fallback: 0,
        shell: 2,
        total: 3,
    })
})

it('treats unrelated native IDs and missing markers as shell', async () => {
    const view = await render(
        <View nativeID="generated">
            <Text nativeID="another-namespace:generated">Plain text</Text>
        </View>,
    )
    expect(measureRenderOriginTree(view.toJSON(), checkpoint).counts).toEqual({
        generated: 0,
        fallback: 0,
        shell: 2,
        total: 2,
    })
})

it.each(['truebuild-render-origin', 'truebuild-render-origin:', 'truebuild-render-origin:unknown'])(
    'rejects the malformed reserved marker %s instead of counting it as generated or shell',
    async (nativeID) => {
        const view = await render(<View nativeID={nativeID} />)
        expect(() => measureRenderOriginTree(view.toJSON(), checkpoint)).toThrow('invalid_render_origin_marker')
    },
)

it('reports an empty rendered tree as unavailable, including no raw text or phantom container node', async () => {
    const view = await render(
        <>
            {null}
            {false}
        </>,
    )
    for (const tree of [view.toJSON(), view.container.toJSON(), null]) {
        expect(measureRenderOriginTree(tree, checkpoint)).toMatchObject({
            counts: { generated: 0, fallback: 0, shell: 0, total: 0 },
            byHostType: {},
            rawTextCounts: { generated: 0, fallback: 0, shell: 0, total: 0 },
            nodes: [],
            status: 'unavailable',
            generatedShare: null,
        })
    }
})

it('returns independent measurements on repeated reads and rerenders without accumulating old host nodes', async () => {
    const view = await render(
        <View nativeID="truebuild-render-origin:generated">
            <Text>First</Text>
        </View>,
    )
    const first = measureRenderOriginTree(view.toJSON(), checkpoint)
    expect(measureRenderOriginTree(view.toJSON(), checkpoint)).toEqual(first)

    await view.rerender(<View nativeID="truebuild-render-origin:fallback" />)
    const next = measureRenderOriginTree(view.toJSON(), { ...checkpoint, checkpointId: 'fallback' })
    expect(next.counts).toEqual({ generated: 0, fallback: 1, shell: 0, total: 1 })
    expect(first.counts).toEqual({ generated: 2, fallback: 0, shell: 0, total: 2 })
    expect(next.rawTextCounts.total).toBe(0)
    expect(first.rawTextCounts.total).toBe(1)
})

it('aggregates fixed checkpoints by actual node totals and retains each screen minimum instead of averaging percentages', async () => {
    const view = await render(
        <View nativeID="truebuild-render-origin:generated">
            <Text>Home</Text>
        </View>,
    )
    const home = measureRenderOriginTree(view.toJSON(), { ...checkpoint, screen: 'home' })
    await view.rerender(
        <View>
            <Text nativeID="truebuild-render-origin:generated">Guide</Text>
            <View nativeID="truebuild-render-origin:fallback" />
        </View>,
    )
    const guide = measureRenderOriginTree(view.toJSON(), checkpoint)
    await view.rerender(
        <View nativeID="truebuild-render-origin:generated">
            <Text>Done</Text>
            <Text>Fine</Text>
        </View>,
    )
    const result = measureRenderOriginTree(view.toJSON(), { ...checkpoint, checkpointId: 'result' })
    const summary = summarizeRenderOriginSession([home, guide, result])

    expect(summary.session).toEqual({ sessionId: 'synthetic-build-1', platform: 'ios', evidence: 'synthetic-fixture' })
    expect(summary.sampleCount).toBe(3)
    expect(summary.counts).toEqual({ generated: 6, fallback: 1, shell: 1, total: 8 })
    expect(summary.byHostType).toEqual({
        View: { generated: 2, fallback: 1, shell: 1, total: 4 },
        Text: { generated: 4, fallback: 0, shell: 0, total: 4 },
    })
    expect(summary.rawTextCounts).toEqual({ generated: 4, fallback: 0, shell: 0, total: 4 })
    expect(summary.generatedShare).toBe(6 / 8)
    expect(summary.minimumScreenGeneratedShare).toBe(1 / 3)
    expect(summary.screens).toEqual([
        {
            screen: 'home',
            sampleCount: 1,
            counts: { generated: 2, fallback: 0, shell: 0, total: 2 },
            generatedShare: 1,
            minimumGeneratedShare: 1,
            status: 'measured',
        },
        {
            screen: 'guide',
            sampleCount: 2,
            counts: { generated: 4, fallback: 1, shell: 1, total: 6 },
            generatedShare: 4 / 6,
            minimumGeneratedShare: 1 / 3,
            status: 'measured',
        },
    ])
})

it('rejects duplicate identities even when the repeated renderer output changes', async () => {
    const view = await render(<View nativeID="truebuild-render-origin:generated" />)
    const first = measureRenderOriginTree(view.toJSON(), checkpoint)
    await view.rerender(<View />)
    const repeated = measureRenderOriginTree(view.toJSON(), checkpoint)
    expect(() => summarizeRenderOriginSession([first, repeated])).toThrow('duplicate_render_origin_checkpoint')
})

it.each([{ sessionId: 'another-session' }, { platform: 'android' as const }])(
    'rejects mixed session or platform samples: %j',
    async (change) => {
        const view = await render(<View />)
        const sample = measureRenderOriginTree(view.toJSON(), checkpoint)
        const other = measureRenderOriginTree(view.toJSON(), { ...checkpoint, ...change })
        expect(() => summarizeRenderOriginSession([sample, other])).toThrow('mixed_render_origin_session')
    },
)

it('keeps the minimum unavailable when a required checkpoint has no rendered hosts', async () => {
    const view = await render(<View nativeID="truebuild-render-origin:generated" />)
    const ready = measureRenderOriginTree(view.toJSON(), checkpoint)
    const empty = measureRenderOriginTree(null, { ...checkpoint, checkpointId: 'empty' })
    const summary = summarizeRenderOriginSession([ready, empty])
    expect(summary.generatedShare).toBe(1)
    expect(summary.minimumScreenGeneratedShare).toBeNull()
    expect(summary.screens[0]?.minimumGeneratedShare).toBeNull()
    expect(summarizeRenderOriginSession([])).toMatchObject({
        session: null,
        sampleCount: 0,
        counts: { generated: 0, fallback: 0, shell: 0, total: 0 },
        byHostType: {},
        rawTextCounts: { generated: 0, fallback: 0, shell: 0, total: 0 },
        screens: [],
        generatedShare: null,
        minimumScreenGeneratedShare: null,
        status: 'unavailable',
    })
})

it('reads composed ownership and origin markers and rejects a hidden invalid reserved segment', async () => {
    const view = await render(
        <View nativeID="truebuild-document-root:abc|truebuild-render-origin:generated">
            <Text>Generated body</Text>
        </View>,
    )
    expect(measureRenderOriginTree(view.toJSON(), checkpoint).counts).toMatchObject({ generated: 2, shell: 0 })
    await view.rerender(<View nativeID="truebuild-render-origin:generated|truebuild-document-root:" />)
    expect(() => measureRenderOriginTree(view.toJSON(), checkpoint)).toThrow('invalid_render_origin_marker')
})
