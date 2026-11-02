/// <reference types="node" />
import type * as ReactModule from 'react'
import type * as ReactNative from 'react-native'
import { act, cleanup, screen, waitFor } from '@testing-library/react-native'
import { createController, createDocuments, createScreens } from './controller-factory'
import { flush, mount, press, type Mounted } from '../screens/test-support/flow'
import { deferred, source } from '../screens/test-support/route-harness'

jest.mock('expo-router/build/testing-library/mocks', () => ({}))
jest.mock('react', () => {
    const actual = jest.requireActual<typeof ReactModule>('react')
    return {
        ...actual,
        useEffectEvent: (callback: (...args: unknown[]) => unknown): ((...args: unknown[]) => unknown) => {
            const committed = actual.useRef(callback)
            actual.useLayoutEffect(() => {
                committed.current = callback
            })
            return actual.useCallback((...args: unknown[]) => committed.current(...args), [])
        },
    }
})
jest.mock('./controller-factory', () => ({
    createController: jest.fn(),
    createScreens: jest.fn(),
    createDocuments: jest.fn(),
}))
// Device key-value IO only: the real JudgeProvider/store still restores, gates and persists the preference.
jest.mock('../screens/judge-storage', () => {
    const values = new Map<string, string>()
    return {
        judgeStorage: {
            getItem: async (key: string): Promise<string | null> => values.get(key) ?? null,
            setItem: async (key: string, value: string): Promise<void> => {
                values.set(key, value)
            },
        },
    }
})
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('expo-camera', () => ({
    Camera: { getCameraPermissionsAsync: async (): Promise<unknown> => ({ granted: true, canAskAgain: true }) },
    useCameraPermissions: (): unknown[] => [{ granted: true, canAskAgain: true }, jest.fn()],
    CameraView: (props: Record<string, unknown>): ReactModule.ReactElement => {
        const React = jest.requireActual<typeof ReactModule>('react')
        const { View } = jest.requireActual<typeof ReactNative>('react-native')
        return React.createElement(View, { ...props, testID: 'hardware-preview' })
    },
}))
let mounted: Mounted | null = null
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
beforeAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
})
afterAll(() => {
    if (originalLocation === undefined) Reflect.deleteProperty(window, 'location')
    else Object.defineProperty(window, 'location', originalLocation)
})
afterEach(async () => {
    await cleanup()
    mounted?.store.dispose()
    mounted?.controller.dispose()
    mounted = null
    jest.mocked(createController).mockReset()
    jest.mocked(createDocuments).mockReset()
    jest.mocked(createScreens).mockReset()
    jest.restoreAllMocks()
})

it('composes Pages once after a four-photo import is persisted, never once per photo', async () => {
    const chosen = deferred<void>()
    mounted = await mount([], { screens: { generated: ['add', 'pages', 'camera'] }, recordings: 'off' })
    const { controller, server, storage } = mounted
    const save = jest.spyOn(storage, 'save')
    const pagesRequests = (): typeof server.requests =>
        server.requests.filter((request) => request.op === 'generate' && request.kind === 'pages')

    await press('Add a manual')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe('/add'))
    expect(controller.current?.session.pages).toHaveLength(0)
    save.mockClear()

    let importing!: Promise<void>
    await act(async () => {
        importing = controller.importPages(async () => {
            await chosen.promise
            return [source, source, source, source]
        })
    })
    await flush()
    expect(controller.getSnapshot().pending).toMatch(/^Choosing/u)
    expect(pagesRequests()).toHaveLength(0)

    await act(async () => {
        chosen.resolve()
        await importing
    })
    // One persistence of the whole selection, and exactly one Pages composition for the four pages it now holds.
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![1]).toHaveLength(4)
    expect(new Set(controller.current?.session.pages.map((page) => page.pageId)).size).toBe(4)
    await waitFor(() => expect(pagesRequests()).toHaveLength(1))
    await flush()
    expect(pagesRequests()).toHaveLength(1)
    expect(pagesRequests()[0]!.session?.pages).toHaveLength(4)
    expect(screen.queryByTestId('pages-screen')).not.toBeNull()
})
