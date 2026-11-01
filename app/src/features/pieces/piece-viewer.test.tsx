import { act, render, screen } from '@testing-library/react-native'
import { PieceViewer } from './piece-viewer'
import { ThemeProvider } from '../../theme/theme'
import { PanResponder, Platform, type GestureResponderEvent, type PanResponderGestureState } from 'react-native'
import type * as ReactModule from 'react'
import type * as ReactNativeModule from 'react-native'

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

it('leaves a vertical swipe to the page and claims diagonal rotation or a pinch', async () => {
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
        expect(config.onStartShouldSetPanResponder?.(event, movement)).toBe(false)
        expect(config.onMoveShouldSetPanResponder?.(event, { ...movement, dx: 2, dy: 30 })).toBe(false)
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
