import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import { PieceViewer, PiecesGrid } from './piece-viewer'
import { ViewerScrollView } from './viewer-scroll-lock'
import { spies } from '../../ui/test-support/reanimated-mock'
import { ThemeProvider } from '../../theme/theme'
import {
    AccessibilityInfo,
    PanResponder,
    Platform,
    StyleSheet,
    Text,
    type GestureResponderEvent,
    type PanResponderGestureState,
} from 'react-native'
import * as SafeArea from 'react-native-safe-area-context'
import type * as ReactModule from 'react'
import type * as ReactNativeModule from 'react-native'
import type { PieceSpec } from '@truebuild/contracts'
import type { GLViewProps } from 'expo-gl'

const mockOptionalNativeModule = jest.fn((): Record<string, never> | null => null)
const mockScene = {
    rotate: jest.fn(),
    zoom: jest.fn(),
    reset: jest.fn(),
    draw: jest.fn(() => false),
    dispose: jest.fn(),
}
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

jest.mock('expo', () => ({
    ...jest.requireActual('expo'),
    requireOptionalNativeModule: (): Record<string, never> | null => mockOptionalNativeModule(),
}))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('./piece-gl', () => ({
    loadPieceGL: async (): Promise<{ default: (props: GLViewProps) => React.JSX.Element }> => ({
        default: function MockGLSurface(props: GLViewProps): React.JSX.Element {
            const React = jest.requireActual<typeof ReactModule>('react')
            const { View } = jest.requireActual<typeof ReactNativeModule>('react-native')
            // External GPU boundary only: a test explicitly supplies a context when scene interaction is needed.
            return React.createElement(View, { ...props, testID: 'stalled-gl-surface' })
        },
    }),
    loadPieceScene: async (): Promise<unknown> => ({ createPieceScene: (): typeof mockScene => mockScene }),
}))

it('keeps a named 2D card when GL is unavailable and when the piece spec is invalid', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'ios')
    mockOptionalNativeModule.mockClear()
    const piece = {
        id: 'assembly-bracket',
        name: 'Assembly bracket',
        color: '#5A7CA5',
        parts: [
            { type: 'box', dimensions: { width: 2, height: 1, depth: 0.2 }, position: [0, 0, 0], rotation: [0, 0, 0] },
        ],
    }
    const tree = (value: unknown): React.JSX.Element => (
        <ThemeProvider>
            <PieceViewer piece={value} />
        </ThemeProvider>
    )
    let view: Awaited<ReturnType<typeof render>> | undefined
    try {
        view = await render(tree(piece))
        expect(screen.getByTestId('piece-viewer-fallback')).toBeTruthy()
        expect(screen.getByText('Assembly bracket')).toBeTruthy()
        expect(screen.queryByTestId('piece-viewer-gesture-surface')).toBeNull()
        expect(mockOptionalNativeModule).toHaveBeenCalled()
        mockOptionalNativeModule.mockClear()
        await view.rerender(
            tree({ ...piece, parts: [{ ...piece.parts[0], dimensions: { width: -2, height: 1, depth: 1 } }] }),
        )
        expect(screen.getByTestId('piece-viewer-fallback')).toBeTruthy()
        expect(screen.getByText('Assembly bracket')).toBeTruthy()
        // The malformed spec is rejected before GL capability is consulted, independently of GL being unavailable.
        expect(mockOptionalNativeModule).not.toHaveBeenCalled()

        mockOptionalNativeModule.mockReturnValue({})
        jest.useFakeTimers()
        await view.rerender(tree(piece))
        await act(async () => {
            await Promise.resolve()
        })
        expect(screen.getByTestId('stalled-gl-surface')).toBeTruthy()
        await act(async () => {
            jest.advanceTimersByTime(5_000)
        })
        expect(screen.getByTestId('piece-viewer-fallback')).toBeTruthy()
        expect(screen.queryByTestId('stalled-gl-surface')).toBeNull()
    } finally {
        await view?.unmount()
        jest.useRealTimers()
        os.restore()
    }
})

it('claims a single-finger touch that starts on the view in any direction, and a pinch', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'ios')
    const create = jest.spyOn(PanResponder, 'create')
    mockOptionalNativeModule.mockReturnValue({})
    const view = await render(
        <ThemeProvider>
            <PieceViewer
                piece={{
                    id: 'test-piece',
                    name: 'Piece',
                    color: '#467abc',
                    parts: [
                        {
                            type: 'box',
                            dimensions: { width: 1, height: 1, depth: 1 },
                            position: [0, 0, 0],
                            rotation: [0, 0, 0],
                        },
                    ],
                }}
            />
        </ThemeProvider>,
    )
    try {
        const config = create.mock.calls.at(-1)![0]
        const event = {} as GestureResponderEvent
        const movement: PanResponderGestureState = {
            stateID: 1,
            moveX: 0,
            moveY: 0,
            x0: 0,
            y0: 0,
            dx: 0,
            dy: 0,
            vx: 0,
            vy: 0,
            numberActiveTouches: 1,
        }
        // A touch that starts on the viewer belongs to it, so a vertical drag cannot drift into a page scroll.
        expect(config.onStartShouldSetPanResponder?.(event, movement)).toBe(true)
        expect(config.onMoveShouldSetPanResponder?.(event, { ...movement, dx: 2, dy: 30 })).toBe(true)
        expect(config.onMoveShouldSetPanResponder?.(event, { ...movement, dx: 25, dy: 20 })).toBe(true)
        expect(config.onMoveShouldSetPanResponder?.(event, { ...movement, dx: 25, dy: 2 })).toBe(true)
        expect(config.onStartShouldSetPanResponder?.(event, { ...movement, numberActiveTouches: 2 })).toBe(true)
        expect(config.onMoveShouldSetPanResponder?.(event, { ...movement, numberActiveTouches: 2 })).toBe(true)
        expect(config.onPanResponderTerminationRequest?.(event, movement)).toBe(false)
    } finally {
        await view.unmount()
        create.mockRestore()
        os.restore()
    }
})

it('opens pending and unavailable pieces from chips and keeps an unavailable view static', async () => {
    const items = [
        { pieceId: 'arm', name: 'Arm', quantity: 1, state: 'pending' as const },
        { pieceId: 'hub', name: 'Hub', quantity: null, state: 'unavailable' as const },
    ]
    await render(
        <ThemeProvider>
            <PiecesGrid presentation="chips" pieces={[]} items={items} />
        </ThemeProvider>,
    )
    expect(screen.queryByTestId('piece-placeholder-arm')).toBeNull()
    await fireEvent.press(screen.getByTestId('piece-tile-arm'))
    expect(within(screen.getByTestId('piece-placeholder-arm')).getByTestId('blueprint-loader-piece')).toBeTruthy()
    expect(screen.getByText('Shaping the part')).toBeTruthy()
    await fireEvent.press(screen.getByTestId('piece-viewer-close'))
    await fireEvent.press(screen.getByTestId('piece-tile-hub'))
    const hub = screen.getByTestId('piece-placeholder-hub')
    expect(within(hub).getByText('3D view unavailable')).toBeTruthy()
    expect(within(hub).queryByTestId('blueprint-loader-piece')).toBeNull()
})

it('shows one wrapping chip row and opens only the selected part in a rotatable modal', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'ios')
    mockOptionalNativeModule.mockReset()
    mockOptionalNativeModule.mockReturnValue({})
    const part = {
        type: 'box' as const,
        dimensions: { width: 1, height: 1, depth: 1 },
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
    }
    const pieces: PieceSpec[] = [
        { id: 'walking-machine', name: 'Walking machine', color: '#5A7CA5', parts: [part] },
        { id: 'screw', name: 'M4 * 15 screw', color: '#B0B7C3', parts: [part] },
    ]
    const items = [
        { pieceId: 'walking-machine', name: 'Walking machine', quantity: 1 },
        { pieceId: 'screw', name: 'M4 * 15 screw', quantity: 2 },
        { pieceId: 'phone-support', name: 'Phone support', quantity: null, state: 'pending' as const },
    ]
    let view: Awaited<ReturnType<typeof render>> | undefined
    try {
        view = await render(
            <ThemeProvider>
                <PiecesGrid
                    presentation="chips"
                    pieces={pieces}
                    items={items}
                    pieceIds={items.map((item) => item.pieceId)}
                />
            </ThemeProvider>,
        )
        await act(async () => {
            await Promise.resolve()
        })
        expect(screen.queryByTestId('stalled-gl-surface')).toBeNull()
        expect(screen.queryByText('Drag to rotate. Pinch to zoom. Double-tap to reset.')).toBeNull()
        expect(screen.getByTestId('piece-quantity-screw')).toBeTruthy()
        expect(screen.getByLabelText('Expand M4 * 15 screw 3D view')).toBeTruthy()
        await fireEvent.press(screen.getByTestId('piece-tile-screw'))
        expect(screen.getAllByTestId('stalled-gl-surface')).toHaveLength(1)
        expect(screen.getByLabelText('M4 * 15 screw, interactive 3D view')).toBeTruthy()
        expect(screen.getByText('Drag to rotate. Pinch to zoom. Double-tap to reset.')).toBeTruthy()
        expect(screen.getByTestId('piece-viewer-gesture-surface')).toHaveStyle({ flex: 1 })
        expect(
            StyleSheet.flatten(screen.getByTestId('piece-viewer-gesture-surface').props.style).height,
        ).toBeUndefined()
        expect(screen.getByTestId('piece-card-screw')).toHaveStyle({ flex: 1 })
        expect(screen.getByTestId('piece-viewer')).toHaveStyle({ flex: 1 })
        expect(screen.queryByTestId('piece-viewer-expand')).toBeNull()
        await fireEvent.press(screen.getByTestId('piece-viewer-close'))
        expect(screen.queryByTestId('stalled-gl-surface')).toBeNull()
        await fireEvent.press(screen.getByTestId('piece-tile-phone-support'))
        expect(screen.getByTestId('piece-placeholder-phone-support')).toBeTruthy()
        await fireEvent(screen.getByTestId('piece-viewer-fullscreen-modal'), 'requestClose')
        expect(screen.queryByTestId('piece-placeholder-phone-support')).toBeNull()
    } finally {
        await view?.unmount()
        os.restore()
    }
})

const pendingItem = (
    pieceId: string,
    name: string,
): { pieceId: string; name: string; quantity: number; state: 'pending' } => ({
    pieceId,
    name,
    quantity: 1,
    state: 'pending',
})

it('keeps the outgoing piece drawing for 200ms when its first spec arrives', async () => {
    jest.useFakeTimers()
    const items = [pendingItem('arm', 'Arm')]
    const piece: PieceSpec = {
        id: 'arm',
        name: 'Arm',
        color: '#5A7CA5',
        parts: [
            { type: 'box', dimensions: { width: 1, height: 1, depth: 1 }, position: [0, 0, 0], rotation: [0, 0, 0] },
        ],
    }
    const tree = (pieces: PieceSpec[]): React.JSX.Element => (
        <ThemeProvider>
            <PiecesGrid presentation="chips" pieces={pieces} items={items} />
        </ThemeProvider>
    )
    const view = await render(tree([]))
    try {
        await fireEvent.press(screen.getByTestId('piece-tile-arm'))
        await view.rerender(tree([piece]))
        expect(screen.getByTestId('piece-placeholder-arm', { hidden: true })).toBeTruthy()
        await act(() => jest.advanceTimersByTime(199))
        expect(screen.getByTestId('piece-placeholder-arm', { hidden: true })).toBeTruthy()
        await act(() => jest.advanceTimersByTime(1))
        expect(screen.queryByTestId('piece-placeholder-arm', { hidden: true })).toBeNull()
    } finally {
        await view.unmount()
        jest.useRealTimers()
    }
})

it('lets accessibility text grow beyond the guide viewer footprint while waiting', async () => {
    const dimensions = jest.requireActual<typeof ReactNativeModule>('react-native')
    const scaled = jest
        .spyOn(dimensions, 'useWindowDimensions')
        .mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 3 })
    let view: Awaited<ReturnType<typeof render>> | undefined
    try {
        view = await render(
            <ThemeProvider>
                <PiecesGrid presentation="chips" pieces={[]} items={[pendingItem('arm', 'Arm')]} />
            </ThemeProvider>,
        )
        await fireEvent.press(screen.getByTestId('piece-tile-arm'))
        expect(screen.getByTestId('piece-placeholder-arm')).not.toHaveStyle({ height: 240 })
        expect(screen.getByTestId('piece-placeholder-arm')).toHaveStyle({ minHeight: 240 })
        expect(screen.getByTestId('blueprint-loader-piece')).not.toHaveStyle({ height: 240 })
    } finally {
        await view?.unmount()
        scaled.mockRestore()
    }
})

it.each([2, 3])('mounts one announced, animated modal wait from %i pending part chips', async (count) => {
    const dimensions = jest.requireActual<typeof ReactNativeModule>('react-native')
    const standardText = jest.spyOn(dimensions, 'useWindowDimensions').mockReturnValue({
        width: 390,
        height: 844,
        scale: 3,
        fontScale: 1,
    })
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
    announce.mockClear()
    spies.withRepeat.mockClear()
    const items = [pendingItem('arm', 'Arm'), pendingItem('hub', 'Hub'), pendingItem('leg', 'Leg')].slice(0, count)
    let view: Awaited<ReturnType<typeof render>> | undefined
    try {
        view = await render(
            <ThemeProvider>
                <PiecesGrid presentation="chips" pieces={[]} items={items} />
            </ThemeProvider>,
        )
        expect(screen.queryByTestId('blueprint-loader-piece')).toBeNull()
        await fireEvent.press(screen.getByTestId('piece-tile-arm'))
        expect(screen.getAllByTestId('blueprint-loader-piece')).toHaveLength(1)
        expect(announce.mock.calls.filter(([text]) => text === 'Shaping the part')).toHaveLength(1)
        // The selected pending part owns the only viewer and its wait loop.
        expect(spies.withRepeat).toHaveBeenCalledTimes(1)
        expect(screen.getByTestId('piece-placeholder-arm')).toHaveStyle({ height: 240, padding: 0 })
        expect(within(screen.getByTestId('piece-placeholder-arm')).getByTestId('blueprint-loader-piece')).toHaveStyle({
            height: 192,
            margin: 24,
        })
    } finally {
        await view?.unmount()
        announce.mockRestore()
        standardText.mockRestore()
    }
})

it('does not announce again when the selected pending piece becomes unavailable', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
    announce.mockClear()
    const items = [pendingItem('arm', 'Arm'), pendingItem('hub', 'Hub'), pendingItem('leg', 'Leg')]
    let view: Awaited<ReturnType<typeof render>> | undefined
    try {
        view = await render(
            <ThemeProvider>
                <PiecesGrid presentation="chips" pieces={[]} items={items} />
            </ThemeProvider>,
        )
        await fireEvent.press(screen.getByTestId('piece-tile-arm'))
        expect(announce.mock.calls.filter(([text]) => text === 'Shaping the part')).toHaveLength(1)
        await view.rerender(
            <ThemeProvider>
                <PiecesGrid
                    presentation="chips"
                    pieces={[]}
                    items={[
                        { pieceId: 'arm', name: 'Arm', quantity: 1, state: 'unavailable' as const },
                        ...items.slice(1),
                    ]}
                />
            </ThemeProvider>,
        )
        expect(screen.getByText('3D view unavailable')).toBeTruthy()
        expect(announce.mock.calls.filter(([text]) => text === 'Shaping the part')).toHaveLength(1)
    } finally {
        await view?.unmount()
        announce.mockRestore()
    }
})

it('clears a guide piece ready marker when its spec is refined, until the refined view draws a frame', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'ios')
    mockOptionalNativeModule.mockReset()
    mockOptionalNativeModule.mockReturnValue({})
    jest.useFakeTimers()
    const part = {
        type: 'box' as const,
        dimensions: { width: 1, height: 1, depth: 1 },
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
    }
    const spec = (color: string): PieceSpec => ({ id: 'walking', name: 'Walking', color, parts: [part] })
    const items = [{ pieceId: 'walking', name: 'Walking', quantity: 1 }]
    const drawFrame = async (): Promise<void> => {
        await act(async () => {
            await Promise.resolve()
            jest.advanceTimersByTime(20)
        })
    }
    let view: Awaited<ReturnType<typeof render>> | undefined
    try {
        view = await render(
            <ThemeProvider>
                <PiecesGrid presentation="chips" pieces={[spec('#5A7CA5')]} items={items} />
            </ThemeProvider>,
        )
        await fireEvent.press(screen.getByTestId('piece-tile-walking'))
        await act(async () => screen.getByTestId('stalled-gl-surface').props.onContextCreate({}))
        await drawFrame()
        expect(screen.getByTestId('piece-viewer-ready-walking')).toBeTruthy()

        await view.rerender(
            <ThemeProvider>
                <PiecesGrid presentation="chips" pieces={[spec('#B0B7C3')]} items={items} />
            </ThemeProvider>,
        )
        // The refined spec is a new 3D view: the marker waits for its own first frame.
        expect(screen.queryByTestId('piece-viewer-ready-walking')).toBeNull()
        await act(async () => screen.getByTestId('stalled-gl-surface').props.onContextCreate({}))
        await drawFrame()
        expect(screen.getByTestId('piece-viewer-ready-walking')).toBeTruthy()
    } finally {
        await view?.unmount()
        jest.useRealTimers()
        os.restore()
    }
})

type PanConfig = Parameters<typeof PanResponder.create>[0]

const dragPiece: PieceSpec = {
    id: 'drag-piece',
    name: 'Drag piece',
    color: '#467abc',
    parts: [{ type: 'box', dimensions: { width: 1, height: 1, depth: 1 }, position: [0, 0, 0], rotation: [0, 0, 0] }],
}

function movement(dy: number): PanResponderGestureState {
    return { stateID: 1, moveX: 0, moveY: 0, x0: 0, y0: 0, dx: 0, dy, vx: 0, vy: 0, numberActiveTouches: 1 }
}

function PageWithViewer({ viewer = true }: { readonly viewer?: boolean }): React.JSX.Element {
    return (
        <ThemeProvider>
            <ViewerScrollView testID="page">
                <Text>Outside the 3D view</Text>
                {viewer ? <PieceViewer piece={dragPiece} /> : null}
            </ViewerScrollView>
        </ThemeProvider>
    )
}

function pageScrollEnabled(): boolean | undefined {
    return screen.getByTestId('page').props.scrollEnabled
}

it.each(['release', 'cancel', 'unmount', 'startup timeout'] as const)(
    'holds the page still for a drag that starts on the 3D view, and frees it on %s',
    async (ending) => {
        const os = jest.replaceProperty(Platform, 'OS', 'ios')
        const create = jest.spyOn(PanResponder, 'create')
        mockOptionalNativeModule.mockReturnValue({})
        jest.useFakeTimers()
        let view: Awaited<ReturnType<typeof render>> | undefined
        try {
            view = await render(<PageWithViewer />)
            mockScene.rotate.mockClear()
            if (ending !== 'startup timeout') {
                // Only the external GPU is mocked: the real viewer creates its scene and handles the drag.
                await act(async () => screen.getByTestId('stalled-gl-surface').props.onContextCreate({}))
            }
            const config: PanConfig = create.mock.calls.at(-1)![0]
            // A single finger has no second touch, so the grant and move read the pinch distance as absent.
            const event = { nativeEvent: { touches: [] } } as unknown as GestureResponderEvent
            expect(pageScrollEnabled()).toBe(true)

            await act(() => {
                // A single finger that starts on the view is claimed at once, before any direction is known.
                expect(config.onStartShouldSetPanResponder?.(event, movement(0))).toBe(true)
                config.onPanResponderGrant?.(event, movement(0))
            })
            expect(pageScrollEnabled()).toBe(false)

            // A vertical drag, the case the page used to scroll, stays with the viewer.
            await act(() => config.onPanResponderMove?.(event, movement(40)))
            if (ending !== 'startup timeout') expect(mockScene.rotate).toHaveBeenCalledWith(0, 40 * 0.009)
            expect(config.onPanResponderTerminationRequest?.(event, movement(40))).toBe(false)
            expect(pageScrollEnabled()).toBe(false)

            switch (ending) {
                case 'release':
                    await act(() => config.onPanResponderRelease?.(event, movement(40)))
                    break
                case 'cancel':
                    await act(() => config.onPanResponderTerminate?.(event, movement(40)))
                    break
                case 'unmount':
                    await view.rerender(<PageWithViewer viewer={false} />)
                    break
                case 'startup timeout':
                    // A surface that never delivers its context fails to the name card, and that failure frees the page.
                    await act(async () => {
                        jest.advanceTimersByTime(5_000)
                    })
                    expect(screen.getByTestId('piece-viewer-fallback')).toBeTruthy()
                    break
            }
            expect(pageScrollEnabled()).toBe(true)
        } finally {
            await view?.unmount()
            jest.useRealTimers()
            create.mockRestore()
            os.restore()
        }
    },
)

it('opens the same piece full screen from its own view, and closes from its button or the system back gesture', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'ios')
    const insets = jest.spyOn(SafeArea, 'useSafeAreaInsets').mockReturnValue({ top: 59, bottom: 34, left: 0, right: 0 })
    mockOptionalNativeModule.mockReturnValue({})
    let view: Awaited<ReturnType<typeof render>> | undefined
    try {
        view = await render(
            <ThemeProvider>
                <PieceViewer piece={dragPiece} />
            </ThemeProvider>,
        )
        expect(screen.getAllByTestId('piece-viewer-gesture-surface')).toHaveLength(1)

        await act(async () => {
            fireEvent.press(screen.getByRole('button', { name: 'Expand Drag piece 3D view' }))
        })
        expect(screen.getAllByTestId('piece-viewer-gesture-surface')).toHaveLength(2)
        const fullscreenStyle = StyleSheet.flatten(screen.getByTestId('piece-viewer-fullscreen').props.style)
        expect(fullscreenStyle.paddingTop).toBeGreaterThanOrEqual(59)
        expect(fullscreenStyle.paddingBottom).toBeGreaterThanOrEqual(34)
        await act(async () => {
            fireEvent.press(screen.getByRole('button', { name: 'Close 3D view' }))
        })
        expect(screen.getAllByTestId('piece-viewer-gesture-surface')).toHaveLength(1)

        await act(async () => {
            fireEvent.press(screen.getByRole('button', { name: 'Expand Drag piece 3D view' }))
        })
        await act(async () => {
            fireEvent(screen.getByTestId('piece-viewer-fullscreen-modal'), 'requestClose')
        })
        expect(screen.getAllByTestId('piece-viewer-gesture-surface')).toHaveLength(1)
    } finally {
        await view?.unmount()
        insets.mockRestore()
        os.restore()
    }
})

it('keeps the default non-guide grid inline and opens no modal until Expand is chosen', async () => {
    mockOptionalNativeModule.mockReturnValue(null)
    const spec: PieceSpec = {
        id: 'legacy-part',
        name: 'Legacy part',
        color: '#467ABC',
        parts: [
            { type: 'box', dimensions: { width: 1, height: 1, depth: 1 }, position: [0, 0, 0], rotation: [0, 0, 0] },
        ],
    }
    await render(
        <ThemeProvider>
            <PiecesGrid pieces={[spec]} />
        </ThemeProvider>,
    )
    expect(screen.getByTestId('piece-viewer-fallback')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View Legacy part' })).toBeTruthy()
    expect(screen.queryByTestId('piece-viewer-fullscreen-modal')).toBeNull()
})
