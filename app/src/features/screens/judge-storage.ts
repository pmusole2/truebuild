import type AsyncStorageModule from '@react-native-async-storage/async-storage'
import type { OnboardingStorage } from '../onboarding/onboarding-store'

// Same device key-value store and loading pattern as onboarding, as its own adapter: the judge preference and the tip
// history never share a reader, so neither can change when or how often the other is read.
async function asyncStorage(): Promise<typeof AsyncStorageModule> {
    return (await import('@react-native-async-storage/async-storage')).default
}

/** The device's own key-value store for the judge preference only. Never reaches the network. */
export const judgeStorage: OnboardingStorage = {
    getItem: async (key: string): Promise<string | null> => (await asyncStorage()).getItem(key),
    setItem: async (key: string, value: string): Promise<void> => (await asyncStorage()).setItem(key, value),
}
