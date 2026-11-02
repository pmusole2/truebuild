import { Linking } from 'react-native'

// Tips can be switched off for tests and development without touching the saved "seen" record. Development builds
// only: a production build never reads the flag, so a real person always gets the tips.
const URL_FLAG = 'truebuildSkipTips'
let latched = false

function webSearch(): string | null {
    return typeof window !== 'undefined' && typeof window.location?.search === 'string' ? window.location.search : null
}

/** True for the whole process once the launch URL carried the flag, so later pushed URLs need not repeat it. */
function latchFromUrl(url: string | null): boolean {
    if (
        url !== null &&
        new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?')) : '').get(URL_FLAG) === '1'
    ) {
        latched = true
    }
    return latched
}

export function tipsSkippedSynchronously(): boolean {
    if (!__DEV__) return false
    return process.env.EXPO_PUBLIC_SKIP_TIPS === '1' || latchFromUrl(webSearch())
}

/** The native launch URL can only be read asynchronously; the answer latches the same way. */
export async function tipsSkippedByLaunchUrl(): Promise<boolean> {
    if (!__DEV__) return false
    try {
        return latchFromUrl((await Linking.getInitialURL()) ?? null)
    } catch {
        return latched
    }
}

export function resetTipsSkipLatchForTests(): void {
    latched = false
}
