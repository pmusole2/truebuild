import * as ExpoHaptics from 'expo-haptics'
import { Platform } from 'react-native'
import { noopHaptics, type HapticKind, type HapticPort } from './feedback'

// The subset of expo-haptics the UI uses. Tests substitute it; a missing function means no capability.
export type HapticsModule = Pick<typeof ExpoHaptics, 'selectionAsync' | 'notificationAsync'>

/**
 * Maps UI intents onto a haptics module. Web, a missing module and any module without the needed functions all resolve
 * to silence rather than an error, so the action still happens on hardware-less platforms.
 */
export function createHapticsPort(module: Partial<HapticsModule> | null, os: string): HapticPort {
    if (os === 'web' || module === null) {
        return noopHaptics
    }
    const { selectionAsync, notificationAsync } = module
    if (typeof selectionAsync !== 'function' || typeof notificationAsync !== 'function') {
        return noopHaptics
    }
    return {
        trigger: (kind: HapticKind): Promise<void> =>
            kind === 'selection'
                ? selectionAsync()
                : notificationAsync(
                      kind === 'success'
                          ? ExpoHaptics.NotificationFeedbackType.Success
                          : ExpoHaptics.NotificationFeedbackType.Warning,
                  ),
    }
}

/** Device haptics for the current platform. Mount it with FeedbackProvider at integration; the default stays silent. */
export const nativeHaptics: HapticPort = createHapticsPort(ExpoHaptics, Platform.OS)
