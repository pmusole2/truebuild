import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { EmptyState, ErrorState, PermissionState } from './states'

describe('state panels', () => {
    it('an empty state offers its action without implying a result', async () => {
        const onPress = jest.fn()
        await render(
            <EmptyState
                title="No manual yet"
                body="Photograph a manual to start a plan."
                action={{ label: 'Photograph a manual', onPress }}
            />,
        )
        expect(screen.getByRole('header', { name: 'No manual yet' })).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Photograph a manual' }))
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('an error state is an alert with a retry the user chooses', async () => {
        const retry = jest.fn()
        await render(
            <ErrorState
                title="Check unavailable"
                body="Nothing was shown as a result."
                retry={{ label: 'Try again', onPress: retry }}
            />,
        )
        expect(screen.getByRole('alert')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
        expect(retry).toHaveBeenCalledTimes(1)
    })

    it('a permission state offers the primary grant and a secondary way out, both as buttons', async () => {
        const allow = jest.fn()
        const choose = jest.fn()
        await render(
            <PermissionState
                title="Camera is off"
                body="Allow the camera to photograph the assembly."
                primary={{ label: 'Allow camera', onPress: allow }}
                secondary={{ label: 'Choose a photo', onPress: choose }}
            />,
        )
        await fireEvent.press(screen.getByRole('button', { name: 'Allow camera' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Choose a photo' }))
        expect(allow).toHaveBeenCalledTimes(1)
        expect(choose).toHaveBeenCalledTimes(1)
    })
})
