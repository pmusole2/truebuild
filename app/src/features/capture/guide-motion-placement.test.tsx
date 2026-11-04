/// <reference types="node" />
import type * as ReactModule from 'react'
import type * as ReactNative from 'react-native'
import { cleanup, screen, waitFor } from '@testing-library/react-native'
import { createController, createDocuments, createScreens } from './controller-factory'
import { flush, mount, press, type Mounted } from '../screens/test-support/flow'
import { entry } from '../screens/test-support/route-harness'
import { guideMotionInsertionPath } from '../documents/native-document'

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
// The hint's GL surface is not under test here: a probe marks where the Guide places it.
jest.mock('../step-motion/guide-step-motion', () => {
    const React = jest.requireActual<typeof ReactModule>('react')
    const { Text } = jest.requireActual<typeof ReactNative>('react-native')
    return {
        GuideStepMotion: (): ReactModule.ReactElement => React.createElement(Text, { testID: 'motion-probe' }, 'probe'),
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

it('places the motion hint directly after the directions, before the guide pieces', async () => {
    const manual = entry()
    mounted = await mount([manual], { screens: { generated: ['guide'] }, recordings: 'off' })
    await press('Continue building')
    await waitFor(() => expect(mounted!.view.getPathname()).toBe(`/guide/${manual.session.manualId}`))
    await waitFor(() => expect(screen.getByTestId('motion-probe')).toBeTruthy())
    await flush()
    // The rendered tree in document order: test ids as `#id`, text as quoted strings.
    const tokens: string[] = []
    const walk = (node: unknown): void => {
        if (typeof node === 'string') tokens.push(`"${node}"`)
        else if (node && typeof node === 'object') {
            const json = node as { props?: { testID?: string }; children?: unknown[] }
            if (json.props?.testID) tokens.push(`#${json.props.testID}`)
            ;(json.children ?? []).forEach(walk)
        }
    }
    walk(mounted.view.toJSON())
    const probe = tokens.indexOf('#motion-probe')
    expect(tokens.filter((token) => token === '#motion-probe')).toHaveLength(1)
    expect(tokens.indexOf('"Directions"')).toBeGreaterThan(-1)
    // It follows the last numbered direction, ahead of the source opener and the checks; the pieces follow it.
    expect(tokens[probe - 1]).toBe('"Keep the panel free before seating the divider."')
    expect(probe).toBeLessThan(tokens.indexOf('"Check your work"'))
    expect(probe).toBeLessThan(tokens.indexOf('#guide-pieces-step-1'))
})

it.each([
    {
        numbered: ['body.0.1.0', 'body.0.1.2'],
        directions: ['body.0.0', 'body.0.1.0', 'body.0.1.2'],
        expected: 'body.0.1.2',
    },
    { numbered: [], directions: ['body.0', 'body.1'], expected: 'body.1' },
    { numbered: [], directions: [], expected: null },
])('selects the last numbered direction, else the final flat instruction', ({ numbered, directions, expected }) => {
    expect(guideMotionInsertionPath(numbered, directions)).toBe(expected)
})
