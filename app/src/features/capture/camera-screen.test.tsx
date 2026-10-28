import { fireEvent, render, screen } from '@testing-library/react-native'
import { CameraScreen } from './camera-screen'
import type { SourceImageAsset } from '../../media/normalize-image'
import type { ReactElement } from 'react'
import type { ViewProps } from 'react-native'
import type * as ReactModule from 'react'
import type * as ReactNativeModule from 'react-native'

const mockRequestPermission = jest.fn(async () => undefined)
const mockTakePicture = jest.fn(async () => ({ uri: 'file://captured.jpg', width: 1200, height: 1600 }))
const mockOwnTemporaryImage = jest.fn()
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('../../media/owned-temporary-images', () => ({
    ownTemporaryImage: (uri: string): void => {
        mockOwnTemporaryImage(uri)
    },
}))
jest.mock('expo-camera', () => {
    const React = jest.requireActual<typeof ReactModule>('react')
    const { View } = jest.requireActual<typeof ReactNativeModule>('react-native')
    return {
        useCameraPermissions: (): unknown[] => [mockPermission, mockRequestPermission],
        CameraView: React.forwardRef(function CameraView(
            props: { onCameraReady: () => void; onMountError: () => void },
            ref,
        ): ReactElement {
            React.useImperativeHandle(ref, () => ({ takePictureAsync: mockTakePicture }))
            return React.createElement<ViewProps & typeof props>(View, { testID: 'camera-feed', ...props })
        }),
    }
})

const noop = (): void => undefined
beforeEach(() => {
    mockPermission = null
    mockRequestPermission.mockClear()
    mockTakePicture.mockClear()
    mockOwnTemporaryImage.mockClear()
})

it('renders permission checks before camera hardware and offers explicit permission recovery', async () => {
    const { rerender } = await render(
        <CameraScreen busy={false} intent={{ kind: 'page' }} onCancel={noop} onCapture={noop} />,
    )
    expect(screen.getByText('Checking camera access…')).toBeTruthy()
    expect(screen.queryByTestId('camera-feed')).toBeNull()
    mockPermission = { granted: false, canAskAgain: false }
    await rerender(<CameraScreen busy={false} intent={{ kind: 'page' }} onCancel={noop} onCapture={noop} />)
    expect(screen.getByRole('button', { name: 'Open device settings' })).toBeTruthy()
    expect(screen.queryByTestId('camera-feed')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Allow camera' }))
    expect(mockRequestPermission).toHaveBeenCalledTimes(1)
})

it('keeps capture disabled until ready and preserves the take factory, options and image ownership', async () => {
    mockPermission = { granted: true, canAskAgain: true }
    let take: (() => Promise<SourceImageAsset>) | undefined
    const capture = jest.fn((factory: () => Promise<SourceImageAsset>): void => {
        take = factory
    })
    const { rerender } = await render(
        <CameraScreen busy={false} intent={{ kind: 'page' }} onCancel={noop} onCapture={capture} />,
    )
    expect(screen.getByRole('button', { name: 'Capture photo' }).props.accessibilityState.disabled).toBe(true)
    await fireEvent.press(screen.getByRole('button', { name: 'Capture photo' }))
    expect(capture).not.toHaveBeenCalled()
    await fireEvent(screen.getByTestId('camera-feed'), 'cameraReady')
    await fireEvent.press(screen.getByRole('button', { name: 'Capture photo' }))
    expect(capture).toHaveBeenCalledTimes(1)
    expect(mockTakePicture).not.toHaveBeenCalled()
    expect(await take?.()).toEqual({ uri: 'file://captured.jpg', width: 1200, height: 1600 })
    expect(mockTakePicture).toHaveBeenCalledWith({ quality: 1, skipProcessing: false, exif: false })
    expect(mockOwnTemporaryImage).toHaveBeenCalledWith('file://captured.jpg')
    await rerender(<CameraScreen busy intent={{ kind: 'page' }} onCancel={noop} onCapture={capture} />)
    expect(screen.getByRole('button', { name: 'Preparing photo…' }).props.accessibilityState.disabled).toBe(true)
})

it('shows a mount failure and remounts on retry without allowing an unready capture', async () => {
    mockPermission = { granted: true, canAskAgain: true }
    await render(<CameraScreen busy={false} intent={{ kind: 'page' }} onCancel={noop} onCapture={noop} />)
    await fireEvent(screen.getByTestId('camera-feed'), 'mountError')
    expect(screen.getByText('Camera unavailable')).toBeTruthy()
    expect(screen.queryByTestId('camera-feed')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Retry camera' }))
    expect(screen.getByTestId('camera-feed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Capture photo' }).props.accessibilityState.disabled).toBe(true)
})
