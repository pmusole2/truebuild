import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { PieceViewer, PiecesGrid } from './piece-viewer'
import { ViewerScrollView } from './viewer-scroll-lock'
import { ThemeProvider } from '../../theme/theme'
import { PanResponder, Platform, Text, type GestureResponderEvent, type PanResponderGestureState } from 'react-native'
import type * as ReactModule from 'react'
import type * as ReactNativeModule from 'react-native'
import type { PieceSpec } from '@truebuild/contracts'

const mockOptionalNativeModule = jest.fn((): Record<string, never> | null => null)
jest.mock('expo', () => ({
    ...jest.requireActual('expo'),
    requireOptionalNativeModule: (): Record<string, never> | null => mockOptionalNativeModule(),
}))
jest.mock('./piece-gl', () => ({
    loadPieceGL: async (): Promise<{ default: () => React.JSX.Element }> => ({
        default: function MockGLSurface(): React.JSX.Element {
            const React = jest.requireActual<typeof ReactModule>('react')
            const { View } = jest.requireActual<typeof ReactNativeModule>('react-native')
            // External GPU boundary only: this surface deliberately never supplies a GL context.
            return React.createElement(View, { testID: 'stalled-gl-surface' })
        },
    }),
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

it('gives every valid step-registry piece its own 3D view in guide mode, not the 2D fallback', async () => {
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
                <PiecesGrid pieces={pieces} items={items} pieceIds={items.map((item) => item.pieceId)} />
            </ThemeProvider>,
        )
        await act(async () => {
            await Promise.resolve()
        })
        // Every linked piece with a valid spec mounts its viewer; the pending catalog entry stays a named placeholder.
        expect(screen.getAllByTestId('stalled-gl-surface')).toHaveLength(2)
        expect(screen.queryByTestId('piece-viewer-fallback')).toBeNull()
        expect(screen.getByText('×2')).toBeTruthy()
        expect(screen.getByTestId('piece-placeholder-phone-support')).toBeTruthy()
    } finally {
        await view?.unmount()
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
        os.restore()
    }
})
