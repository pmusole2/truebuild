import type AsyncStorageModule from '@react-native-async-storage/async-storage'
import type { OnboardingStorage } from './onboarding-store'

// AsyncStorage is loaded on first use, so importing the app's layout never needs the native module. A failure to load or
// read it rejects into the onboarding store, which treats it as "nothing saved" and never blocks an action.
async function asyncStorage(): Promise<typeof AsyncStorageModule> {
    return (await import('@react-native-async-storage/async-storage')).default
}

/** The device's own key-value store, injected into the onboarding store. Only the onboarding record goes through it. */
export const onboardingStorage: OnboardingStorage = {
    getItem: async (key: string): Promise<string | null> => (await asyncStorage()).getItem(key),
    setItem: async (key: string, value: string): Promise<void> => (await asyncStorage()).setItem(key, value),
}
