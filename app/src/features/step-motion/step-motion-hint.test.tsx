import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AppState, Pressable, Text, type AppStateStatus } from 'react-native'
import type * as ReactModule from 'react'
import type * as ReactNativeModule from 'react-native'
import type { GLViewProps, ExpoWebGLRenderingContext } from 'expo-gl'
import type { StepMotionScene } from '@truebuild/contracts'
import { StepMotionHint, type StepMotionAvailability } from './step-motion-hint'
import { FeedbackProvider } from '../../ui/feedback'
import { ThemeProvider } from '../../theme/theme'
import { lightColors } from '../../theme/tokens'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

const mockSurface: { props: GLViewProps | null } = { props: null }
const mockGL = { available: true }
// The scene's own clock: one mover, so its three loops finish at 9 s. The pure suite owns the real timeline.
const mockScene = {
    draw: jest.fn((elapsed: number) => ({ finished: elapsed >= 9000, mover: null, eased: 1 })),
    dispose: jest.fn(),
}
const mockCreateScene = jest.fn((): typeof mockScene => mockScene)
const mockLoadScene = jest.fn(async (): Promise<{ createStepMotionScene: typeof mockCreateScene }> => ({
    createStepMotionScene: mockCreateScene,
}))

jest.mock('../pieces/piece-gl', () => ({
    loadPieceGL: async (): Promise<{ default: (props: GLViewProps) => React.JSX.Element }> => ({
        default: function MockGLSurface(props: GLViewProps): React.JSX.Element {
            const React = jest.requireActual<typeof ReactModule>('react')
            const { View } = jest.requireActual<typeof ReactNativeModule>('react-native')
            // External GPU boundary only: the test drives context creation and records the surface's props.
            mockSurface.props = props
            return React.createElement(View, { testID: 'step-motion-gl-surface' })
        },
    }),
    loadStepMotionScene: (): Promise<unknown> => mockLoadScene(),
    isGLAvailable: (): boolean => mockGL.available,
}))

const gl = {} as ExpoWebGLRenderingContext
const box = (x: number): StepMotionScene['still'][number] => ({
    type: 'box' as const,
    dimensions: { width: 1, height: 1, depth: 1 },
    position: [x, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
})
const scene: StepMotionScene = {
    version: 1,
    stepId: 'hinge-up',
    still: [box(0)],
    movers: [
        {
            label: 'Frame',
            shapes: [box(2)],
            motion: { kind: 'translate', from: [0, 2, 0], to: [0, 0, 0] },
            actionIndex: 3,
        },
    ],
    caption: 'Raise the frame.',
}

// The app-state listener the hint subscribes with, so a test can background and foreground it.
let appStateListener: ((status: AppStateStatus) => void) | null = null

async function appState(status: AppStateStatus): Promise<void> {
    await act(async () => {
        appStateListener?.(status)
    })
}

function ui(props: {
    scene: unknown
    reduceMotion?: boolean
    active?: boolean
    readingLanguage?: string
    loading?: boolean
    fallback?: React.ReactNode
    stepLabel?: string
    onAvailabilityChange?: (status: StepMotionAvailability) => void
}): React.JSX.Element {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion={props.reduceMotion ?? false}>
                <StepMotionHint
                    scene={props.scene}
                    active={props.active ?? true}
                    readingLanguage={props.readingLanguage}
                    loading={props.loading}
                    fallback={props.fallback}
                    stepLabel={props.stepLabel}
                    onAvailabilityChange={props.onAvailabilityChange}
                />
            </FeedbackProvider>
        </ThemeProvider>
    )
}

/** Waits for the lazy surface, then delivers its context the way the native view does. */
async function createSurface(): Promise<void> {
    await screen.findByTestId('step-motion-gl-surface')
    const create = mockSurface.props?.onContextCreate as
        ((context: ExpoWebGLRenderingContext) => Promise<void> | void) | undefined
    await act(async () => {
        await create?.(gl)
    })
}

// Async act flushes React's timer-scheduled effects before and after the clock moves.
async function advance(milliseconds: number): Promise<void> {
    await act(async () => {
        jest.advanceTimersByTime(milliseconds)
    })
}

beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    mockSurface.props = null
    mockGL.available = true
    mockLoadScene.mockImplementation(async () => ({ createStepMotionScene: mockCreateScene }))
    mockCreateScene.mockImplementation(() => mockScene)
    // The jest host does not define isAvailable; a native device does, so the test provides the signal explicitly.
    Object.defineProperty(AppState, 'isAvailable', { value: true, configurable: true })
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
        appStateListener = listener
        return { remove: (): void => undefined }
    })
})

afterEach(() => {
    appStateListener = null
    Reflect.deleteProperty(AppState, 'isAvailable')
    jest.restoreAllMocks()
    jest.useRealTimers()
})

it('renders nothing for a null, invalid, unavailable or failed scene', async () => {
    const nothing = await render(ui({ scene: null }))
    expect(nothing.toJSON()).toBeNull()
    await nothing.unmount()

    const invalid = await render(ui({ scene: { version: 2, caption: 'Not a scene' } }))
    expect(invalid.toJSON()).toBeNull()
    await invalid.unmount()

    mockGL.available = false
    const unavailable = await render(ui({ scene }))
    expect(unavailable.toJSON()).toBeNull()
    expect(mockLoadScene).not.toHaveBeenCalled()
    await unavailable.unmount()
    mockGL.available = true

    mockCreateScene.mockImplementation(() => {
        throw new Error('no GL')
    })
    await render(ui({ scene }))
    await createSurface()
    expect(screen.queryByTestId('step-motion-hint')).toBeNull()
    expect(screen.queryByText(scene.caption)).toBeNull()
})

it('renders nothing when no context arrives within the startup window', async () => {
    await render(ui({ scene }))
    await screen.findByTestId('step-motion-gl-surface')
    await advance(4_900)
    expect(screen.getByTestId('step-motion-hint')).toBeTruthy()
    await advance(200)
    expect(screen.queryByTestId('step-motion-hint')).toBeNull()
})

it('uses the reading-language registry for loading and approximation copy, with an English fallback', async () => {
    const view = await render(ui({ scene: null, loading: true, readingLanguage: 'fr' }))
    expect(screen.getByText('Visualisation du mouvement')).toBeTruthy()
    await view.rerender(ui({ scene, reduceMotion: true, readingLanguage: 'fr' }))
    await createSurface()
    expect(screen.getByText('Approximatif')).toBeTruthy()
    expect(screen.queryByText('Approximate motion')).toBeNull()
    await view.rerender(ui({ scene, reduceMotion: true, readingLanguage: 'zz' }))
    expect(screen.getByText('Approximate motion')).toBeTruthy()
})

it('turning reduced motion off does not offer Replay before the three loops finish', async () => {
    const view = await render(ui({ scene, reduceMotion: true }))
    await createSurface()
    await view.rerender(ui({ scene, reduceMotion: false }))
    await advance(100)
    expect(screen.queryByTestId('step-motion-replay')).toBeNull()
    await advance(9_000)
    expect(screen.getByTestId('step-motion-replay')).toBeTruthy()
})

it('shows the finished pose and caption with no motion when reduced', async () => {
    await render(ui({ scene, reduceMotion: true }))
    await createSurface()
    expect(mockScene.draw).toHaveBeenCalledTimes(1)
    expect(mockScene.draw).toHaveBeenCalledWith(Number.POSITIVE_INFINITY)
    expect(screen.getByText(scene.caption)).toBeTruthy()
    expect(screen.getByText('Approximate motion')).toBeTruthy()
    expect(screen.queryByTestId('step-motion-replay')).toBeNull()
    await advance(20_000)
    expect(mockScene.draw).toHaveBeenCalledTimes(1)
})

it('plays at most 30 frames a second to the end, then stops until Replay restarts the budget', async () => {
    await render(ui({ scene }))
    await createSurface()
    await advance(1000)
    const framesInFirstSecond = mockScene.draw.mock.calls.length
    expect(framesInFirstSecond).toBeGreaterThan(10)
    expect(framesInFirstSecond).toBeLessThanOrEqual(31)
    expect(screen.queryByTestId('step-motion-replay')).toBeNull()

    // Frames land every ~32ms, so the last frame before 9 s may fall just short; one more frame finishes the run.
    await advance(8_200)
    expect(screen.getByTestId('step-motion-replay')).toHaveStyle({ backgroundColor: lightColors.accent })
    const viewport = screen.getByTestId('step-motion-viewport')
    expect(viewport.props.pointerEvents).toBe('none')
    let parent = screen.getByTestId('step-motion-replay').parent
    while (parent !== null) {
        expect(parent).not.toBe(viewport)
        parent = parent.parent
    }

    const drawsAtEnd = mockScene.draw.mock.calls.length
    await advance(5_000)
    expect(mockScene.draw.mock.calls.length).toBe(drawsAtEnd)

    await act(async () => {
        fireEvent.press(screen.getByTestId('step-motion-replay'))
    })
    expect(screen.queryByTestId('step-motion-replay')).toBeNull()
    await advance(1000)
    expect(mockScene.draw.mock.calls.length).toBeGreaterThan(drawsAtEnd)
    // The replayed run starts from zero again, not from the old end.
    expect(mockScene.draw.mock.calls[drawsAtEnd]?.[0]).toBeLessThan(1000)
})

it('keeps a finished sequence final across background and foreground, and resumes a paused one where it stopped', async () => {
    await render(ui({ scene }))
    await createSurface()
    await advance(4_000)
    const elapsedBeforePause = mockScene.draw.mock.calls.at(-1)?.[0] as number

    // Background mid-play: the surface goes, and no time passes for the sequence.
    await appState('background')
    expect(screen.queryByTestId('step-motion-gl-surface')).toBeNull()
    expect(mockScene.dispose).toHaveBeenCalledTimes(1)
    await advance(10_000)

    // Foreground resumes at the stored elapsed time, not at zero and not at the wall-clock total.
    await appState('active')
    await createSurface()
    const resumedAt = mockScene.draw.mock.calls.at(-1)?.[0] as number
    expect(resumedAt).toBeGreaterThanOrEqual(elapsedBeforePause)
    expect(resumedAt).toBeLessThan(elapsedBeforePause + 200)

    // Play to the end, then background and foreground again: final, with Replay, and no automatic second run.
    await advance(5_200)
    expect(screen.getByTestId('step-motion-replay')).toBeTruthy()
    await appState('background')
    await appState('active')
    await createSurface()
    expect(screen.getByTestId('step-motion-replay')).toBeTruthy()
    const drawsAfterForeground = mockScene.draw.mock.calls.length
    await advance(20_000)
    expect(mockScene.draw.mock.calls.length).toBeLessThanOrEqual(drawsAfterForeground + 1)
    expect(mockScene.draw.mock.results.at(-1)?.value).toEqual({ finished: true, mover: null, eased: 1 })
})

it('releases the GL surface and scene when made inactive, and never attaches a scene created after unmount', async () => {
    const { rerender } = await render(ui({ scene }))
    await createSurface()
    await advance(500)
    await rerender(ui({ scene, active: false }))
    expect(screen.queryByTestId('step-motion-gl-surface')).toBeNull()
    expect(mockScene.dispose).toHaveBeenCalledTimes(1)
    const drawsBeforeInactive = mockScene.draw.mock.calls.length
    await advance(2_000)
    expect(mockScene.draw.mock.calls.length).toBe(drawsBeforeInactive)

    // A scene whose async load finishes after the hint has been made inactive must not be created at all.
    let finishLoad: (value: { createStepMotionScene: typeof mockCreateScene }) => void = () => undefined
    mockLoadScene.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishLoad = resolve
            }),
    )
    await rerender(ui({ scene, active: true }))
    await screen.findByTestId('step-motion-gl-surface')
    // The context callback stays pending until the load resolves, so it is not awaited here.
    void mockSurface.props?.onContextCreate?.(gl)
    await rerender(ui({ scene, active: false }))
    await act(async () => {
        finishLoad({ createStepMotionScene: mockCreateScene })
    })
    expect(mockCreateScene).toHaveBeenCalledTimes(1)
    expect(mockScene.dispose).toHaveBeenCalledTimes(1)
    expect(mockScene.draw.mock.calls.length).toBe(drawsBeforeInactive)
})

it('ignores a context callback retained past deactivation or unmount: no loader, no builder, no GPU object', async () => {
    type ContextCallback = (context: ExpoWebGLRenderingContext) => Promise<void> | void
    const deactivated = await render(ui({ scene }))
    await screen.findByTestId('step-motion-gl-surface')
    const retainedBeforeDeactivate = mockSurface.props?.onContextCreate as ContextCallback | undefined
    await deactivated.rerender(ui({ scene, active: false }))
    await act(async () => {
        await retainedBeforeDeactivate?.(gl)
    })
    expect(mockLoadScene).not.toHaveBeenCalled()
    expect(mockCreateScene).not.toHaveBeenCalled()
    await deactivated.rerender(ui({ scene, active: true }))
    await screen.findByTestId('step-motion-gl-surface')
    await act(async () => {
        await retainedBeforeDeactivate?.(gl)
    })
    expect(mockLoadScene).not.toHaveBeenCalled()
    await deactivated.unmount()

    const unmounted = await render(ui({ scene }))
    await screen.findByTestId('step-motion-gl-surface')
    const retainedBeforeUnmount = mockSurface.props?.onContextCreate as ContextCallback | undefined
    await unmounted.unmount()
    await act(async () => {
        await retainedBeforeUnmount?.(gl)
    })
    expect(mockLoadScene).not.toHaveBeenCalled()
    expect(mockCreateScene).not.toHaveBeenCalled()
    expect(mockScene.dispose).not.toHaveBeenCalled()
})

it('reserves one hero frame through loading, motion and manual fallback, with availability updates', async () => {
    const availability = jest.fn()
    const fallback = <Text>Manual reference</Text>
    const props = { fallback, stepLabel: 'Step 2', onAvailabilityChange: availability }
    const view = await render(ui({ scene: null, loading: true, ...props }))
    expect(screen.getByTestId('step-motion-viewport')).toHaveStyle({ aspectRatio: 1.6, borderRadius: 16 })
    expect(screen.getByTestId('blueprint-loader-piece')).toBeTruthy()
    expect(screen.queryByText('Step 2')).toBeNull()
    expect(availability).toHaveBeenLastCalledWith('loading')
    await view.rerender(ui({ scene, ...props }))
    await createSurface()
    expect(screen.getByTestId('step-motion-viewport')).toHaveStyle({ aspectRatio: 1.6, borderRadius: 16 })
    expect(screen.getByText(scene.caption)).toBeTruthy()
    expect(screen.getByText('Step 2')).toBeTruthy()
    expect(availability).toHaveBeenLastCalledWith('motion')
    expect(mockCreateScene).toHaveBeenCalledWith(
        gl,
        scene,
        expect.objectContaining({ background: expect.any(String), ground: expect.any(String) }),
    )
    await view.rerender(ui({ scene: null, ...props }))
    expect(screen.getByText('Manual reference')).toBeTruthy()
    expect(screen.queryByText('Step 2')).toBeNull()
    expect(screen.queryByText(scene.caption)).toBeNull()
    expect(screen.getByTestId('step-motion-viewport')).toHaveStyle({ aspectRatio: 1.6, borderRadius: 16 })
    expect(availability).toHaveBeenLastCalledWith('fallback')
})

it('uses the manual reference when GL is unavailable or startup fails', async () => {
    const fallback = <Text>Manual reference</Text>
    mockGL.available = false
    const view = await render(ui({ scene, fallback }))
    expect(screen.getByText('Manual reference')).toBeTruthy()
    expect(screen.queryByTestId('step-motion-gl-surface')).toBeNull()
    await view.unmount()
    mockGL.available = true
    await render(ui({ scene, fallback }))
    await screen.findByTestId('step-motion-gl-surface')
    await advance(5_100)
    expect(screen.getByText('Manual reference')).toBeTruthy()
    expect(screen.queryByTestId('step-motion-gl-surface')).toBeNull()
})

it('keeps scene availability stable across inactive and foreground GL remounts without a blank hero', async () => {
    const availability = jest.fn()
    const props = { scene, fallback: <Text>Manual reference</Text>, onAvailabilityChange: availability }
    const view = await render(ui(props))
    await createSurface()
    expect(availability.mock.calls.map(([status]) => status)).toEqual(['motion'])
    await view.rerender(ui({ ...props, active: false }))
    expect(screen.getByText('Manual reference')).toBeTruthy()
    expect(screen.queryByTestId('step-motion-gl-surface')).toBeNull()
    await view.rerender(ui(props))
    expect(screen.getByTestId('blueprint-loader-piece')).toBeTruthy()
    await createSurface()
    await appState('background')
    expect(screen.getByText('Manual reference')).toBeTruthy()
    await appState('active')
    expect(screen.getByTestId('blueprint-loader-piece')).toBeTruthy()
    await createSurface()
    expect(availability.mock.calls.map(([status]) => status)).toEqual(['motion'])
    expect(screen.getByTestId('step-motion-viewport')).toHaveStyle({ aspectRatio: 1.6 })
})

it('reserves a loading drawing for an inactive scene without a manual fallback', async () => {
    await render(ui({ scene, active: false }))
    expect(screen.getByTestId('blueprint-loader-piece')).toBeTruthy()
    expect(screen.queryByTestId('step-motion-gl-surface')).toBeNull()
    expect(mockLoadScene).not.toHaveBeenCalled()
})

it('lets hero swipes pass through while the fallback image remains an interactive sibling', async () => {
    const open = jest.fn()
    const fallback = (
        <Pressable accessibilityRole="button" accessibilityLabel="Open manual image" onPress={open}>
            <Text>Manual picture</Text>
        </Pressable>
    )
    await render(ui({ scene: null, fallback }))
    const viewport = screen.getByTestId('step-motion-viewport')
    expect(viewport.props.pointerEvents).toBe('none')
    const picture = screen.getByRole('button', { name: 'Open manual image' })
    let parent = picture.parent
    while (parent !== null) {
        expect(parent).not.toBe(viewport)
        parent = parent.parent
    }
    await fireEvent.press(picture)
    expect(open).toHaveBeenCalledTimes(1)
})
