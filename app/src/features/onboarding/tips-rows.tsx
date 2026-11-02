import type { ReactElement } from 'react'
import { AppButton } from '../../ui/button'
import { useCoach, useShowTipsAgain } from './coach-provider'

/** Clears the "seen" record, closes the sheet it is in and lets the screen offer its tips again. */
export function ShowTipsAgainRow({ onClose }: { readonly onClose: () => void }): ReactElement | null {
    const showAgain = useShowTipsAgain()
    if (showAgain === null) {
        return null
    }
    return (
        <AppButton
            label="Show tips again"
            variant="quiet"
            testID="show-tips-again"
            onPress={(): void => showAgain(onClose)}
        />
    )
}

/** Development only, inside the judge entry: hide tips for this session without touching the saved record. */
export function HideTipsForTestingRow(): ReactElement | null {
    const coach = useCoach()
    if (!__DEV__ || coach === null) {
        return null
    }
    return (
        <AppButton
            label="Hide tips for testing"
            variant="quiet"
            testID="coach-test-skip"
            onPress={coach.hideForTesting}
        />
    )
}
