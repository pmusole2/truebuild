import type { ConsentStorage } from './consent-store'

/** Browser storage shares the same keys as the app's AsyncStorage web adapter. */
export const consentStorage: ConsentStorage = {
    getItem: async (key): Promise<string | null> => window.localStorage.getItem(key),
    setItem: async (key, value): Promise<void> => window.localStorage.setItem(key, value),
}
