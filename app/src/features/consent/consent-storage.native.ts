import type { ConsentStorage } from './consent-store'

/** Loading the client in previews must not eagerly evaluate an unavailable native module. */
export const consentStorage: ConsentStorage = {
    getItem: async (key): Promise<string | null> =>
        (await import('@react-native-async-storage/async-storage')).default.getItem(key),
    setItem: async (key, value): Promise<void> =>
        (await import('@react-native-async-storage/async-storage')).default.setItem(key, value),
}
