import { act, render } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { WorkflowContext, type WorkflowValue } from '../capture/workflow-context'
import { entry as flowEntry } from './test-support/route-harness'
import { nodeDigest } from './test-support/documents'
import { fixtureScreens, type FixtureServerOptions } from './test-support/fixture-server'
import { ScreenStore } from './screen-store'
import { specKey } from './screen-spec'
import { readingSpec, guidePageSpec } from './slots'
import { deferred } from './test-support/route-harness'
import { useWarmUp } from './use-screen-slot'

const mockFocus = { focused: true }
jest.mock('expo-router', () => ({
    ...jest.requireActual<object>('expo-router'),
    useIsFocused: (): boolean => mockFocus.focused,
}))

function setup(options: FixtureServerOptions): { store: ScreenStore; generates: () => string[] } {
    const server = fixtureScreens(options)
    let id = 0
    const store = new ScreenStore({
        client: server,
        mode: 'full',
        id: (): string => `w-${++id}`,
        digest: nodeDigest,
    })
    return {
        store,
        generates: () => server.requests.flatMap((request) => (request.op === 'generate' ? [request.kind] : [])),
    }
}

function Warm({ specs }: { specs: Parameters<typeof useWarmUp>[0] }): ReactElement | null {
    useWarmUp(specs)
    return null
}

const wrap = (store: ScreenStore, specs: Parameters<typeof useWarmUp>[0]): ReactElement => (
    <WorkflowContext.Provider value={{ screens: store } as unknown as WorkflowValue}>
        <Warm specs={specs} />
    </WorkflowContext.Provider>
)

const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 12; turn++) await act(async () => Promise.resolve())
}

beforeEach(() => {
    mockFocus.focused = true
})

describe('warming the next screen', () => {
    const entry = flowEntry('warm', 'unparsed')

    it('does not delete a failure adopted by the destination after the source loses focus', async () => {
        const gate = deferred<void>()
        const { store } = setup({ failing: ['reading'], gate: gate.promise })
        const spec = readingSpec(entry)
        const view = await render(wrap(store, [spec]))
        store.request(spec) // The destination adopts the same in-flight request.
        mockFocus.focused = false
        await view.rerender(wrap(store, [spec]))
        await act(async () => gate.resolve())
        await settle()
        expect(store.peek(spec)?.status).toBe('failed')
    })

    it('asks once for the screen it was given and keeps the finished document for the destination', async () => {
        const { store, generates } = setup({})
        const spec = readingSpec(entry)
        const view = await render(wrap(store, [spec]))
        await settle()
        expect(generates()).toEqual(['reading'])
        expect(store.peek(spec)?.status).toBe('ready')
        // A re-render with the same facts, and the destination's own request, share that one call.
        await view.rerender(wrap(store, [readingSpec(entry)]))
        store.request(readingSpec(entry))
        await settle()
        expect(generates()).toEqual(['reading'])
    })

    it('forgets a warm-up that failed so the destination makes its own attempt, and does not retry by itself', async () => {
        const { store, generates } = setup({ failing: ['reading'] })
        const spec = readingSpec(entry)
        await render(wrap(store, [spec]))
        await settle()
        expect(generates()).toEqual(['reading'])
        // Not a final failure left behind for the destination to inherit.
        expect(store.peek(spec)).toBeUndefined()
        expect(generates()).toHaveLength(1)
        store.request(spec)
        await settle()
        expect(generates()).toEqual(['reading', 'reading'])
    })

    it('asks for nothing while the screen is not in front, or when generation is off for that kind', async () => {
        mockFocus.focused = false
        const { store, generates } = setup({})
        await render(wrap(store, [readingSpec(entry)]))
        await settle()
        expect(generates()).toEqual([])
        const steps = new ScreenStore({
            client: fixtureScreens({}),
            mode: 'steps',
            id: (): string => 'x',
            digest: nodeDigest,
        })
        mockFocus.focused = true
        await render(wrap(steps, [readingSpec(entry)]))
        await settle()
        expect(steps.peek(readingSpec(entry))).toBeUndefined()
    })

    it('never answers a different step, revision or page content from another key', async () => {
        const reviewed = flowEntry('warm', 'reviewed', 3)
        const { store, generates } = setup({})
        const first = guidePageSpec(reviewed, 'step-1')
        await render(wrap(store, [first]))
        await settle()
        const bumped = { ...reviewed, session: { ...reviewed.session, revision: reviewed.session.revision + 1 } }
        const other = guidePageSpec(bumped, 'step-1')
        const next = guidePageSpec(reviewed, 'step-2')
        expect(new Set([specKey(first), specKey(other), specKey(next)]).size).toBe(3)
        expect(store.peek(other)).toBeUndefined()
        expect(store.peek(next)).toBeUndefined()
        expect(generates()).toEqual(['guide'])
    })
})
