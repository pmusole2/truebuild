import type * as ReactModule from 'react'
import { act, render } from '@testing-library/react-native'
import { type ComponentRef, type ReactElement, type RefObject } from 'react'
import type { View } from 'react-native'
import { usePathname } from 'expo-router'
import { MeterRootsContext, useMeterRoot, type MeterRootKind, type MeterRootSelection } from '../../ui/meter-roots'
import { MeterTriggers, NativeMeterProvider, screenOfPath, useMeterReading, type MeterReading } from './native-meter'
import type { NativeHostNode, NativeHostRoot } from './native-host-meter'
import { decodeNativeCheckpointLines } from './native-meter-log'
import { WorkflowContext, type WorkflowValue } from '../capture/workflow-context'
import { entry, runtime } from './test-support/route-harness'

// The pathname is an external store, as the router's is: a change re-renders only the components that read it.
const mockPath = {
    value: '/',
    listeners: new Set<() => void>(),
    set(next: string): void {
        this.value = next
        this.listeners.forEach((listener) => listener())
    },
}
jest.mock('expo-router', () => {
    const { useSyncExternalStore } = jest.requireActual<typeof ReactModule>('react')
    return {
        ...jest.requireActual<object>('expo-router'),
        usePathname: (): string =>
            useSyncExternalStore(
                (listener) => {
                    mockPath.listeners.add(listener)
                    return (): void => void mockPath.listeners.delete(listener)
                },
                () => mockPath.value,
            ),
    }
})

// Structural doubles of only the public host instance read port, as the meter's own tests use. They prove this wiring
// (registration, triggers, scheduling, reading); they are not a claim about the native view tree of a device.
const element = (id = '', children: NativeHostNode[] = []): NativeHostNode => ({
    nodeType: 1,
    nodeName: 'View',
    isConnected: true,
    id,
    childNodes: children,
})
const root = (node: NativeHostNode): RefObject<ComponentRef<typeof View> | null> =>
    ({
        current: { isConnected: true, ownerDocument: { documentElement: node } } satisfies NativeHostRoot,
    }) as unknown as RefObject<ComponentRef<typeof View> | null>

const tree = (): NativeHostNode =>
    element('', [
        element('truebuild-render-origin:generated', [element(), element()]),
        element('truebuild-render-origin:shell'),
    ])

function Root({
    target,
    kind,
    selection,
}: {
    target: RefObject<ComponentRef<typeof View> | null>
    kind: MeterRootKind
    selection?: MeterRootSelection
}): null {
    useMeterRoot(target, kind, selection)
    return null
}
const reading: { current: MeterReading | null } = { current: null }
function Reader(): null {
    reading.current = useMeterReading()
    return null
}

function harness(options: { enabled?: boolean; platform?: string; roots?: ReactElement }): {
    ui: ReactElement
    flush: () => Promise<void>
} {
    const queue: (() => void)[] = []
    const schedule = (run: () => void): (() => void) => {
        queue.push(run)
        return (): void => {
            const at = queue.indexOf(run)
            if (at >= 0) queue.splice(at, 1)
        }
    }
    return {
        ui: (
            <NativeMeterProvider
                enabled={options.enabled}
                platform={options.platform ?? 'ios'}
                sessionId="session-a"
                schedule={schedule}
            >
                <Reader />
                {options.roots}
                <MeterTriggers />
            </NativeMeterProvider>
        ),
        flush: async (): Promise<void> => {
            await act(async () => {
                queue.splice(0).forEach((run) => run())
            })
        },
    }
}

beforeEach(() => {
    mockPath.value = '/'
    mockPath.listeners.clear()
    reading.current = null
})

describe('the device host meter wiring', () => {
    it('retains different steps on the same route without logging their manual or step identifiers', async () => {
        const log = jest.spyOn(console, 'info').mockImplementation((): void => undefined)
        const first = entry('private-manual-identity')
        const { controller } = await runtime([first])
        const value: WorkflowValue = { controller, state: controller.getSnapshot(), entry: first, screens: null }
        mockPath.value = '/guide/private-manual-identity'
        const test = harness({ enabled: true, roots: <Root target={root(tree())} kind="app" /> })
        const view = await render(<WorkflowContext.Provider value={value}>{test.ui}</WorkflowContext.Provider>)
        await test.flush()
        await view.rerender(
            <WorkflowContext.Provider value={{ ...value, entry: { ...first, stepIndex: 1 } }}>
                {test.ui}
            </WorkflowContext.Provider>,
        )
        await test.flush()
        expect(reading.current?.session?.sampleCount).toBe(2)
        const emitted = log.mock.calls.map(([value]) => String(value)).join('\n')
        expect(emitted).not.toContain('private-manual-identity')
        expect(emitted).not.toContain('step-1')
        expect(emitted).not.toContain('step-2')
        log.mockRestore()
        controller.dispose()
    })

    it('recounts when a late mask changes the host tree without changing route, busy state or document', async () => {
        const { controller } = await runtime([])
        const nodes: NativeHostNode[] = []
        const heldRoot = root(element('', nodes))
        const value: WorkflowValue = { controller, state: controller.getSnapshot(), entry: undefined, screens: null }
        const test = harness({ enabled: true, roots: <Root target={heldRoot} kind="app" /> })
        const view = await render(<WorkflowContext.Provider value={value}>{test.ui}</WorkflowContext.Provider>)
        await test.flush()
        expect(reading.current?.snapshot?.latest?.counts?.total).toBe(1)
        nodes.push(element('truebuild-render-origin:generated'))
        await view.rerender(
            <WorkflowContext.Provider
                value={{
                    ...value,
                    state: {
                        ...value.state,
                        stages: {
                            captureId: 'capture-a',
                            verdictMs: 10,
                            publishedAt: 100,
                            overlay: { status: 'skipped', reason: 'not_offered' },
                            segments: { status: 'landed', elapsedMs: 20 },
                            masks: [],
                        },
                    },
                }}
            >
                {test.ui}
            </WorkflowContext.Provider>,
        )
        expect(reading.current?.snapshot?.stale).toBe(true)
        await test.flush()
        expect(reading.current?.snapshot?.latest?.counts?.total).toBe(2)
        controller.dispose()
    })

    it('replaces a registered host when the same ref object attaches to a different native view', async () => {
        const original = root(element())
        const replacement = root(element('truebuild-render-origin:generated'))
        let attach: ReturnType<typeof useMeterRoot> | undefined
        function ChangingRoot(): null {
            attach = useMeterRoot(original, 'coach')
            return null
        }
        const test = harness({ enabled: true, roots: <ChangingRoot /> })
        await render(test.ui)
        await test.flush()
        expect(typeof attach).toBe('function')
        await act(async () => {
            if (typeof attach === 'function') attach(replacement.current)
        })
        await test.flush()
        expect(reading.current?.snapshot?.latest?.counts?.generated).toBe(1)
        expect(reading.current?.snapshot?.latest?.counts?.shell).toBe(0)
    })

    it('counts the registered roots once they are mounted, naming the screen, the cause and the scope', async () => {
        const log = jest.spyOn(console, 'info').mockImplementation((): void => undefined)
        const { ui, flush } = harness({ enabled: true, roots: <Root target={root(tree())} kind="app" /> })
        await render(ui)
        await flush()
        const latest = reading.current?.snapshot?.latest
        expect(latest).toMatchObject({
            status: 'measured',
            counts: { generated: 3, fallback: 0, shell: 2, total: 5 },
            rootCount: 1,
            checkpoint: { sessionId: 'session-a', platform: 'ios', screen: 'home' },
        })
        expect(latest?.scope).toContain('registered documents')
        expect(reading.current?.snapshot?.stale).toBe(false)
        expect(reading.current?.session).toMatchObject({ status: 'measured', sampleCount: 1 })
        const events = decodeNativeCheckpointLines(log.mock.calls.map(([value]) => String(value)))
        expect(events).toContainEqual(
            expect.objectContaining({
                event: 'render_origin_checkpoint',
                evidence: 'native-public-host',
                status: 'measured',
                sampleMs: expect.any(Number),
                session: expect.objectContaining({ sampleCount: 1 }),
            }),
        )
        log.mockRestore()
    })

    it('takes a new checkpoint when the focused screen changes, keeping per-screen results apart', async () => {
        const { ui, flush } = harness({ enabled: true, roots: <Root target={root(tree())} kind="app" /> })
        await render(ui)
        await flush()
        await act(async () => mockPath.set('/guide/some-manual'))
        expect(reading.current?.snapshot?.stale).toBe(true)
        await flush()
        expect(reading.current?.snapshot?.latest?.checkpoint.screen).toBe('guide')
        expect(reading.current?.session?.screens.map((item) => item.screen).sort()).toEqual(['guide', 'home'])
    })

    it('re-counts when a sheet root appears or goes, and a root that is not reachable makes the count unavailable', async () => {
        const app = root(tree())
        const first = harness({ enabled: true, roots: <Root target={app} kind="app" /> })
        const view = await render(first.ui)
        await first.flush()
        const withSheet = harness({
            enabled: true,
            roots: (
                <>
                    <Root target={app} kind="app" />
                    <Root target={{ current: null }} kind="sheet" />
                </>
            ),
        })
        await view.unmount()
        await render(withSheet.ui)
        await withSheet.flush()
        expect(reading.current?.snapshot?.latest).toMatchObject({
            status: 'unavailable',
            reason: 'missing-root',
            counts: null,
            generatedShare: null,
        })
        expect(reading.current?.session?.status).toBe('unavailable')
    })

    it('does not exist off, on the web, or with the judge layer off, and a sample can be requested by hand', async () => {
        for (const options of [{ enabled: false }, { enabled: true, platform: 'web' }]) {
            const { ui, flush } = harness({ ...options, roots: <Root target={root(tree())} kind="app" /> })
            const view = await render(ui)
            await flush()
            expect(reading.current?.active).toBe(false)
            expect(reading.current?.snapshot).toBeNull()
            await view.unmount()
        }
        const on = harness({ enabled: true, roots: <Root target={root(tree())} kind="app" /> })
        await render(on.ui)
        await on.flush()
        const before = reading.current?.snapshot?.version
        await act(async () => reading.current?.measureNow())
        expect(reading.current?.snapshot?.stale).toBe(true)
        await on.flush()
        expect(reading.current?.snapshot?.latest?.checkpoint.checkpointId).toContain('requested')
        expect(reading.current?.snapshot?.version).toBeGreaterThan(before ?? 0)
    })

    it('keeps genuine explicit phase checkpoints distinct while logging only opaque identities', async () => {
        const log = jest.spyOn(console, 'info').mockImplementation((): void => undefined)
        const test = harness({ enabled: true, roots: <Root target={root(tree())} kind="app" /> })
        const view = await render(test.ui)
        try {
            await test.flush()
            const before = reading.current?.session?.sampleCount ?? 0
            await act(async () => reading.current?.measureNow('private-manual:private-source:pending'))
            await test.flush()
            const pending = reading.current?.snapshot?.latest?.checkpoint.checkpointId
            await act(async () => reading.current?.measureNow('private-manual:private-source:ready'))
            await test.flush()
            expect(reading.current?.snapshot?.latest?.checkpoint.checkpointId).not.toBe(pending)
            expect(reading.current?.session?.sampleCount).toBe(before + 2)
            const emitted = log.mock.calls.map(([value]) => String(value)).join('\n')
            expect(emitted).not.toContain('private-manual')
            expect(emitted).not.toContain('private-source')
            expect(emitted).toContain('requested-view-')
        } finally {
            await view.unmount()
            log.mockRestore()
        }
    })

    it('passes changing router focus metadata and emits both complete named methods', async () => {
        const log = jest.spyOn(console, 'info').mockImplementation((): void => undefined)
        const home = element('truebuild-render-origin:generated')
        const guide = element('truebuild-render-origin:fallback', [element()])
        const homeScreen = { ...element('', [home]), nodeName: 'RN:RNSScreen' }
        const guideScreen = { ...element('', [guide]), nodeName: 'RN:RNSScreen' }
        const document = element('', [homeScreen, guideScreen])
        const target = (node: NativeHostNode): RefObject<ComponentRef<typeof View> | null> =>
            ({
                current: Object.assign(node, { ownerDocument: { documentElement: document } }),
            }) as unknown as RefObject<ComponentRef<typeof View> | null>
        const homeRef = target(home)
        const guideRef = target(guide)
        function FocusedRoots(): ReactElement {
            const focused = screenOfPath(usePathname())
            return (
                <>
                    <Root target={homeRef} kind="app" selection={{ screen: 'home', focused: focused === 'home' }} />
                    <Root target={guideRef} kind="app" selection={{ screen: 'guide', focused: focused === 'guide' }} />
                </>
            )
        }
        const first = harness({ enabled: true, roots: <FocusedRoots /> })
        const view = await render(first.ui)
        await first.flush()
        expect(reading.current?.snapshot?.latest?.methods.focusedVisible).toMatchObject({
            method: 'focused-visible-native-hosts',
            counts: { generated: 1, fallback: 0, shell: 2, total: 3 },
        })
        await act(async () => mockPath.set('/guide/manual-private'))
        await first.flush()
        expect(reading.current?.snapshot?.latest?.methods.focusedVisible).toMatchObject({
            status: 'measured',
            counts: { generated: 0, fallback: 2, shell: 2, total: 4 },
        })
        const events = decodeNativeCheckpointLines(log.mock.calls.map(([value]) => String(value)))
        expect(events.at(-1)).toMatchObject({
            methods: {
                allMounted: {
                    method: 'all-mounted-native-hosts',
                    counts: { generated: 1, fallback: 2, shell: 3, total: 6 },
                },
                focusedVisible: { method: 'focused-visible-native-hosts', counts: { total: 4 } },
            },
        })
        // Full session route accounting remains in memory; logs retain exact checkpoint methods without repeating it.
        expect(reading.current?.session?.methods.focusedVisible.routes).toMatchObject([
            { route: 'home', counts: { total: 3 } },
            { route: 'guide', counts: { total: 4 } },
        ])
        expect(events.at(-1)?.session).not.toHaveProperty('methods')
        expect(events.at(-1)?.session).not.toHaveProperty('routes')
        await view.unmount()
        log.mockRestore()
    })

    it('is inert for a component that registers a root while no meter exists', async () => {
        await render(
            <MeterRootsContext.Provider value={null}>
                <Root target={root(tree())} kind="app" />
            </MeterRootsContext.Provider>,
        )
        expect(reading.current).toBeNull()
    })
})

describe('checkpoint screens are opaque route names', () => {
    it.each([
        ['/', 'home'],
        ['/guide/abc-123', 'guide'],
        ['/check/x', 'check'],
        ['/camera', 'camera'],
        ['/anything/else', 'other'],
    ])('%s is %s', (path, screen) => expect(screenOfPath(path)).toBe(screen))
})
