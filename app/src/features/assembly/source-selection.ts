import type { ManualSession, ManualStep } from '@truebuild/contracts'
import { selectStepSourcePageIds } from '@truebuild/contracts/model'

/** Full context follows the shared reviewed-session selector; compact fallback is a server-only policy. */
export function selectedStepSourcePageIds(session: ManualSession, step: ManualStep): string[] {
    return selectStepSourcePageIds(session, step.stepId) ?? []
}
