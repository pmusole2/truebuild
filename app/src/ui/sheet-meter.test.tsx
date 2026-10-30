import type { ReactElement } from 'react'
import type * as ReactModule from 'react'
import { render } from '@testing-library/react-native'
import { Text, type ModalProps } from 'react-native'
import type * as NativeModule from 'react-native'
import type { JsonElement } from 'test-renderer'
import { NativeHostMeter, type NativeHostNode } from '../features/screens/native-host-meter'
import { MeterRootsContext, type MeterRootSelection, type MeterRoots } from './meter-roots'
import { BottomSheet } from './sheet'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
// iOS retains Modal children between visible=false and native onDismiss. Keep the real SheetFrame mounted.
jest.mock('react-native/Libraries/Modal/Modal', () => ({
    __esModule: true,
    default: ({ children }: ModalProps): ReactElement => {
        const { View } = jest.requireActual<typeof NativeModule>('react-native')
        const { createElement } = jest.requireActual<typeof ReactModule>('react')
        return createElement(View, { testID: 'retained-native-modal' }, children)
    },
}))

const host = (name: string, children: NativeHostNode[] = [], id = ''): NativeHostNode => ({
    nodeType: 1,
    nodeName: name,
    isConnected: true,
    id,
    childNodes: children,
})

// Structural public-DOM fixture derived from every retained RNTL host. This verifies registration wiring, not a device.
function publicTree(node: JsonElement | string): NativeHostNode {
    if (typeof node === 'string') return { nodeType: 3, nodeName: '#text', isConnected: true, childNodes: [] }
    const name = node.props.testID === 'retained-native-modal' ? 'RCTModalHostView' : node.type
    const nativeID: unknown = node.props.nativeID
    return host(name, node.children.map(publicTree), typeof nativeID === 'string' ? nativeID : '')
}

it('registers the real sheet visibility while retaining hidden native-modal content in all-mounted counts', async () => {
    const active = new Map<symbol, MeterRootSelection | undefined>()
    const roots: MeterRoots = {
        registerRoot: (_ref, kind, selection): (() => void) => {
            expect(kind).toBe('sheet')
            const key = Symbol()
            active.set(key, selection)
            return (): void => void active.delete(key)
        },
    }
    const sheet = (visible: boolean): ReactElement => (
        <MeterRootsContext.Provider value={roots}>
            <BottomSheet visible={visible} title="Instructions" onClose={(): void => undefined}>
                <Text>Retained sheet body</Text>
            </BottomSheet>
        </MeterRootsContext.Provider>
    )
    const view = await render(sheet(true))
    const measure = (): ReturnType<NativeHostMeter['sample']> => {
        const json = view.toJSON()
        if (json === null) throw new Error('expected_retained_sheet_tree')
        const overlay = publicTree(json)
        const body = host('View', [], 'truebuild-render-origin:generated')
        const tree = host('RootView', [host('RNSScreen', [body]), overlay])
        const document = { documentElement: tree }
        const meter = new NativeHostMeter()
        meter.registerRoot(Object.assign(body, { ownerDocument: document }), {
            kind: 'app',
            screen: 'guide',
            focused: true,
        })
        expect(active.size).toBe(1)
        meter.registerRoot(Object.assign(overlay, { ownerDocument: document }), {
            kind: 'sheet',
            ...[...active.values()][0],
        })
        return meter.sample({ sessionId: 'sheet-retained', screen: 'guide', checkpointId: 'ready', platform: 'ios' })
    }
    const open = measure()
    expect(open.methods.focusedVisible.selection?.overlayRootCount).toBe(1)
    expect(open.methods.focusedVisible.counts).toEqual(open.methods.allMounted.counts)

    await view.rerender(sheet(false))
    expect(view.getByText('Retained sheet body')).toBeTruthy()
    const closed = measure()
    expect(closed.methods.allMounted.counts).toEqual(open.methods.allMounted.counts)
    expect(closed.methods.focusedVisible).toMatchObject({
        status: 'measured',
        counts: { generated: 1, fallback: 0, shell: 2, total: 3 },
        selection: { overlayRootCount: 0 },
    })
    expect(closed.methods.focusedVisible.selection?.background.counts.total).toBe(
        (closed.methods.allMounted.counts?.total ?? 0) - 3,
    )
    await view.unmount()
    expect(active.size).toBe(0)
})
