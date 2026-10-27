import { describe, expect, it, jest } from '@jest/globals'
import * as ExpoHaptics from 'expo-haptics'
import { createHapticsPort } from './haptics'

function fakeModule(): {
    selectionAsync: jest.Mock<() => Promise<void>>
    notificationAsync: jest.Mock<(_type?: ExpoHaptics.NotificationFeedbackType) => Promise<void>>
} {
    return {
        selectionAsync: jest.fn(async (): Promise<void> => undefined),
        notificationAsync: jest.fn(async (_type?: ExpoHaptics.NotificationFeedbackType): Promise<void> => undefined),
    }
}

describe('createHapticsPort', () => {
    it('maps selection and notification intents onto the device module', async () => {
        const module = fakeModule()
        const port = createHapticsPort(module, 'ios')
        await port.trigger('selection')
        await port.trigger('success')
        await port.trigger('warning')
        expect(module.selectionAsync).toHaveBeenCalledTimes(1)
        expect(module.notificationAsync).toHaveBeenNthCalledWith(1, ExpoHaptics.NotificationFeedbackType.Success)
        expect(module.notificationAsync).toHaveBeenNthCalledWith(2, ExpoHaptics.NotificationFeedbackType.Warning)
    })

    it('stays silent on web without touching the device module', async () => {
        const module = fakeModule()
        await createHapticsPort(module, 'web').trigger('selection')
        expect(module.selectionAsync).not.toHaveBeenCalled()
    })

    it('stays silent when the module is missing or lacks the needed functions', async () => {
        await createHapticsPort(null, 'ios').trigger('success')
        await createHapticsPort({ selectionAsync: undefined }, 'android').trigger('selection')
    })
})
