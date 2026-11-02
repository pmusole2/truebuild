declare const __DEV__: boolean

/** No native import in the shared/Node graph. Production ignores both filming opt-ins. */
export async function developmentConsent(): Promise<boolean> {
    if (typeof __DEV__ === 'undefined' || !__DEV__) return false
    return (
        process.env.EXPO_PUBLIC_SKIP_TIPS === '1' ||
        (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('truebuildSkipTips') === '1')
    )
}
