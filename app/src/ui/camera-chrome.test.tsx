import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { CameraChrome } from './camera-chrome'

jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
)

describe('CameraChrome', () => {
    it('gives the shutter and close controls names and fires them once each', async () => {
        const onShutter = jest.fn()
        const onClose = jest.fn()
        await render(
            <CameraChrome hint="Frame the step" shutterLabel="Take photo" onShutter={onShutter} onClose={onClose}>
                <Text>Viewfinder</Text>
            </CameraChrome>,
        )
        await fireEvent.press(screen.getByRole('button', { name: 'Take photo' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Close camera' }))
        expect(onShutter).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('a busy camera cannot take a second photo while the first is in flight', async () => {
        const onShutter = jest.fn()
        await render(
            <CameraChrome
                hint="Frame the step"
                shutterLabel="Take photo"
                busy={true}
                onShutter={onShutter}
                onClose={(): void => undefined}
            >
                <Text>Viewfinder</Text>
            </CameraChrome>,
        )
        expect(screen.getByRole('button', { name: 'Take photo' }).props.accessibilityState).toMatchObject({
            disabled: true,
        })
        await fireEvent.press(screen.getByRole('button', { name: 'Take photo' }))
        expect(onShutter).not.toHaveBeenCalled()
    })

    it('shows the framing hint and the viewfinder content', async () => {
        await render(
            <CameraChrome
                hint="Frame the step"
                shutterLabel="Take photo"
                onShutter={(): void => undefined}
                onClose={(): void => undefined}
            >
                <Text>Viewfinder</Text>
            </CameraChrome>,
        )
        expect(screen.getByText('Frame the step')).toBeTruthy()
        expect(screen.getByText('Viewfinder')).toBeTruthy()
    })
})
