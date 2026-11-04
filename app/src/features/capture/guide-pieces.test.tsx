/// <reference types="node" />
import type { PieceBatchResult } from '@truebuild/contracts'
import { createPieces } from '../pieces/piece-runtime'
import { PieceRegistry, type PieceGenerationPort } from '../pieces/piece-registry'
import type * as ReactModule from 'react'
import type * as ReactNative from 'react-native'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { createController, createDocuments, createScreens } from './controller-factory'
import { flush, mount, press, type Mounted } from '../screens/test-support/flow'
import { deferred, entry } from '../screens/test-support/route-harness'

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
jest.mock('../pieces/piece-runtime', () => ({ createPieces: jest.fn() }))
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

it('swaps a displayed Guide from its linked placeholders to ready geometry without composing the page again', async () => {
    const released = deferred<void>()
    const values = new Map<string, string>()
    const generate: PieceGenerationPort = async ({ request }): Promise<PieceBatchResult> => {
        await released.promise
        return {
            contentHash: request.contentHash,
            model: null,
            effort: null,
            durationMs: 1,
            results: request.parts.map((part) => ({
                id: part.id,
                name: part.name,
                status: 'passed',
                cutoutUri: null,
                issueCodes: [],
                piece: {
                    id: part.id,
                    name: part.name,
                    color: '#5978a5',
                    parts: [
                        {
                            type: 'box',
                            dimensions: { width: 1, height: 1, depth: 1 },
                            position: [0, 0, 0],
                            rotation: [0, 0, 0],
                        },
                    ],
                },
            })),
        }
    }
    const registry = new PieceRegistry({
        generate,
        newId: (): string => 'late-pieces',
        storage: {
            getItem: async (key): Promise<string | null> => values.get(key) ?? null,
            setItem: async (key, value): Promise<void> => {
                values.set(key, value)
            },
            removeItem: async (key): Promise<void> => {
                values.delete(key)
            },
            getAllKeys: async (): Promise<readonly string[]> => [...values.keys()],
        },
    })
    jest.mocked(createPieces).mockReturnValue(registry)
    const manual = entry()
    const link = manual.session.reviewedSteps[0]!.parts[0]!
    if (link.quantity.state !== 'known') throw new Error('Expected a known fixture quantity')
    link.quantity.value = 4
    mounted = await mount([manual], { screens: { generated: ['guide'] }, recordings: 'off' })
    await press('Continue building')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe(`/guide/${manual.session.manualId}`))
    const requests = (): Mounted['server']['requests'] =>
        mounted!.server.requests.filter(
            (request) => request.op === 'generate' && request.kind === 'guide' && request.stepId === 'step-1',
        )
    await waitFor(() => expect(requests()).toHaveLength(1))
    expect(screen.getByTestId('guide-pieces-step-1')).toBeTruthy()
    expect(screen.getByText('×4')).toBeTruthy()
    const id = requests()[0]!.stepPieces![0]!.pieceId
    expect(screen.getByTestId(`piece-tile-${id}`)).toBeTruthy()
    await fireEvent.press(screen.getByTestId(`piece-tile-${id}`))
    expect(screen.getByTestId(`piece-placeholder-${id}`)).toBeTruthy()
    await act(async () => {
        released.resolve()
        await released.promise
    })
    await waitFor(() => expect(registry.getSnapshot().status).toBe('ready'))
    await waitFor(() => expect(screen.queryByTestId(`piece-placeholder-${id}`)).toBeNull())
    // This host has no GL. A real valid spec reaches PieceViewer, which uses its named 2D fallback here.
    expect(screen.getByTestId('piece-viewer-fallback')).toBeTruthy()
    expect(within(screen.getByTestId('piece-viewer-fullscreen')).getByText('×4')).toBeTruthy()
    await flush()
    expect(requests()).toHaveLength(1)
})
