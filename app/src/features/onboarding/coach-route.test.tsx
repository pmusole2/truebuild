import { act, render, screen } from '@testing-library/react-native'
import { Platform, Text } from 'react-native'
import type * as ReactNativeModule from 'react-native'
import { CoachRoute } from './coach-root'

const mockListeners = new Map<string, () => void>()
let mockCanGoBack = true
let mockFocused = true
let mockNewNavigationIdentity = false
const mockNavigation = {
    canGoBack: (): boolean => mockCanGoBack,
    addListener: (name: string, listener: () => void): (() => void) => {
        mockListeners.set(name, listener)
        return (): void => {
            mockListeners.delete(name)
        }
    },
}
jest.mock('expo-router', () => ({
    useIsFocused: (): boolean => mockFocused,
    useNavigation: (): typeof mockNavigation => (mockNewNavigationIdentity ? { ...mockNavigation } : mockNavigation),
}))
jest.mock('./coach-provider', () => {
    const { Text: NativeText } = jest.requireActual<typeof ReactNativeModule>('react-native')
    return {
        CoachProvider: 'CoachProvider',
        CoachScope: ({ active }: { active: boolean }): React.ReactElement => (
            <NativeText>{active ? 'eligible' : 'waiting'}</NativeText>
        ),
    }
})
jest.mock('./coach-overlay', () => ({ CoachRootOverlay: 'CoachRootOverlay' }))
jest.mock('./coach-storage', () => ({ onboardingStorage: {} }))

beforeEach(() => {
    mockCanGoBack = true
    mockFocused = true
    mockListeners.clear()
    mockNewNavigationIdentity = false
})

it('keeps an incoming pushed route quiet even before transitionStart arrives', async () => {
    await render(
        <CoachRoute screen="pages">
            <Text>Pages</Text>
        </CoachRoute>,
    )
    expect(screen.getByText('waiting')).toBeTruthy()
    await act(async () => mockListeners.get('transitionStart')?.())
    expect(screen.getByText('waiting')).toBeTruthy()
    await act(async () => mockListeners.get('transitionEnd')?.())
    expect(screen.getByText('eligible')).toBeTruthy()
})

it('allows the first root screen, and suppresses a returning route until its native transition ends', async () => {
    mockCanGoBack = false
    const view = await render(
        <CoachRoute screen="home">
            <Text>Home</Text>
        </CoachRoute>,
    )
    expect(screen.getByText('eligible')).toBeTruthy()
    mockFocused = false
    await view.rerender(
        <CoachRoute screen="home">
            <Text>Home</Text>
        </CoachRoute>,
    )
    expect(screen.getByText('waiting')).toBeTruthy()
    mockCanGoBack = true
    mockFocused = true
    await view.rerender(
        <CoachRoute screen="home">
            <Text>Home</Text>
        </CoachRoute>,
    )
    expect(screen.getByText('waiting')).toBeTruthy()
    await act(async () => mockListeners.get('transitionEnd')?.())
    expect(screen.getByText('eligible')).toBeTruthy()
})

it('does not restart an ended transition when the navigation wrapper identity changes', async () => {
    mockNewNavigationIdentity = true
    await render(
        <CoachRoute screen="pages">
            <Text>Pages</Text>
        </CoachRoute>,
    )
    await act(async () => mockListeners.get('transitionEnd')?.())
    expect(screen.getByText('eligible')).toBeTruthy()
})

it('offers web pushed routes without waiting for native-only transition events, including after refocus', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    try {
        const view = await render(
            <CoachRoute screen="pages">
                <Text>Pages</Text>
            </CoachRoute>,
        )
        expect(screen.getByText('eligible')).toBeTruthy()
        mockFocused = false
        await view.rerender(
            <CoachRoute screen="pages">
                <Text>Pages</Text>
            </CoachRoute>,
        )
        expect(screen.getByText('waiting')).toBeTruthy()
        mockFocused = true
        await view.rerender(
            <CoachRoute screen="pages">
                <Text>Pages</Text>
            </CoachRoute>,
        )
        expect(screen.getByText('eligible')).toBeTruthy()
    } finally {
        jest.restoreAllMocks()
    }
})
