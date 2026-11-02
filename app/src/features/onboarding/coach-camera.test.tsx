import { pressCoach } from './coach-test-support'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Platform, type ViewProps } from 'react-native'
import type { ReactElement } from 'react'
import type * as ReactModule from 'react'
import type * as ReactNativeModule from 'react-native'
import type { SourceImageAsset } from '../../media/normalize-image'
import { spies } from '../../ui/test-support/reanimated-mock'
import { CameraScreen } from '../capture/camera-screen'
import { CoachHarness, readyStore } from './coach-test-support'
import type { OnboardingStore, Rect } from './coach-types'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): { width: number; height: number; scale: number; fontScale: number } => ({
        width: 390,
        height: 844,
        scale: 3,
        fontScale: 1,
    }),
}))
jest.mock('../../media/owned-temporary-images', () => ({ ownTemporaryImage: jest.fn() }))
jest.mock('expo-camera', () => {
    const React = jest.requireActual<typeof ReactModule>('react')
    const { View } = jest.requireActual<typeof ReactNativeModule>('react-native')
    return {
        useCameraPermissions: (): unknown[] => [{ granted: true, canAskAgain: true }, jest.fn()],
        CameraView: React.forwardRef(function CameraView(
            props: { onCameraReady: () => void; onMountError: () => void },
            ref,
        ): ReactElement {
            React.useImperativeHandle(ref, () => ({
                takePictureAsync: async (): Promise<SourceImageAsset> => ({
                    uri: 'file://x.jpg',
                    width: 10,
                    height: 10,
                }),
            }))
            return React.createElement<ViewProps & typeof props>(View, { testID: 'camera-feed', ...props })
        }),
    }
})

const SHUTTER: Rect = { x: 157, y: 700, width: 76, height: 76 }
const measure = async (): Promise<Rect | null> => SHUTTER
const noop = (): void => undefined

async function mountCamera(
    options: { busy?: boolean; intent?: 'page' | 'check'; reduceMotion?: boolean; tipsSeen?: boolean } = {},
): Promise<{
    store: OnboardingStore
    capture: jest.Mock
    view: Awaited<ReturnType<typeof render>>
    tree: (busy: boolean) => ReactElement
}> {
    const { store } = await readyStore(options.tipsSeen ? ['camera'] : [])
    const capture = jest.fn()
    const tree = (busy: boolean): ReactElement => (
        <CoachHarness store={store} screen="camera" measure={measure} reduceMotion={options.reduceMotion ?? true}>
            <CameraScreen
                busy={busy}
                intent={{ kind: options.intent ?? 'page' }}
                onCancel={noop}
                onCapture={capture as (take: () => Promise<SourceImageAsset>) => void}
            />
        </CoachHarness>
    )
    const view = await render(tree(options.busy ?? false))
    return { store, capture, view, tree }
}

async function wait(ms = 40): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
    })
}

it('shows no tip until the camera is ready, then one tip over the shutter inside the camera screen', async () => {
    const { store } = await mountCamera()
    await wait()
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
    await fireEvent(screen.getByTestId('camera-feed'), 'cameraReady')
    expect(await screen.findByText('Tap here when one page fills the frame.')).toBeTruthy()
    // The tip lives inside the camera's own root, so it can never outlive the route; no second modal is stacked.
    expect(JSON.stringify(screen.toJSON())).not.toContain('"type":"Modal"')
    expect(screen.getByTestId('camera-screen')).toContainElement(screen.getByTestId('coach-overlay'))
    expect(screen.getAllByTestId('coach-overlay')).toHaveLength(1)
    expect(screen.queryByTestId('coach-next')).toBeNull()
    expect(store.getSnapshot().seen).toEqual([])
})

it('the tip target takes the photo through the shutter exactly once and consumes the tip first', async () => {
    const { capture, store } = await mountCamera()
    await fireEvent(screen.getByTestId('camera-feed'), 'cameraReady')
    await screen.findByTestId('coach-target-hole')
    await pressCoach('coach-target-hole')
    expect(capture).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('coach-overlay')).toBeNull())
    expect(store.getSnapshot().seen).toEqual(['camera'])
})

it('words the tip for a part photo differently from a page photo', async () => {
    await mountCamera({ intent: 'check' })
    await fireEvent(screen.getByTestId('camera-feed'), 'cameraReady')
    expect(await screen.findByText('Tap here when the part fills the frame.')).toBeTruthy()
})

it('withdraws the tour while a photo is being prepared', async () => {
    const { tree, view } = await mountCamera()
    await fireEvent(screen.getByTestId('camera-feed'), 'cameraReady')
    await screen.findByTestId('coach-overlay')
    await view.rerender(tree(true))
    await waitFor(() => expect(screen.queryByTestId('coach-overlay')).toBeNull())
})

it('keeps Android screen readers inside the local camera tip and out of covered camera controls', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    try {
        await mountCamera()
        await fireEvent(screen.getByTestId('camera-feed'), 'cameraReady')
        await screen.findByTestId('coach-overlay')
        const feed = screen.getByTestId('camera-feed', { hidden: true })
        let covered: typeof feed | null = feed
        while (covered !== null && covered.props.importantForAccessibility !== 'no-hide-descendants') {
            covered = covered.parent
        }
        expect(covered).not.toBeNull()
        expect(covered).not.toContainElement(screen.getByTestId('coach-overlay'))
    } finally {
        jest.restoreAllMocks()
    }
})

it('fades the coordinated camera chrome when preview becomes ready and cancels it during capture', async () => {
    const { tree, view } = await mountCamera({ reduceMotion: false, tipsSeen: true })
    spies.withTiming.mockClear()
    await fireEvent(screen.getByTestId('camera-feed'), 'cameraReady')
    expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 150 }))
    spies.cancelAnimation.mockClear()
    await view.rerender(tree(true))
    expect(spies.cancelAnimation).toHaveBeenCalled()
})
