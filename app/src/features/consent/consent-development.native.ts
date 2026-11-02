import { tipsSkippedByLaunchUrl, tipsSkippedSynchronously } from '../onboarding/coach-skip'

export async function developmentConsent(): Promise<boolean> {
    if (!__DEV__) return false
    return tipsSkippedSynchronously() || (await tipsSkippedByLaunchUrl())
}
