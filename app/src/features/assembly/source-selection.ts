import type { ManualSession, ManualStep } from '@truebuild/contracts'
import * as modelContracts from '@truebuild/contracts/model'

/** Temporary API-merge adapter. Full context is all ordered manual pages (up to 20). Compact selection is an explicit
 * server policy, never a client retry/fallback. Replace reflection with the direct exporter after the API/main merge.
 * Keep the helper's (session, stepId) interface; null/invalid selections fail closed without a partial-page fallback.
 */
export function selectedStepSourcePageIds(session: ManualSession, step: ManualStep): string[] {
    if (
        session.pages.length === 0 ||
        session.pages.length > 20 ||
        !session.reviewedSteps.some((candidate) => candidate.stepId === step.stepId)
    ) {
        return []
    }
    const select: unknown = Reflect.get(modelContracts, 'selectStepSourcePageIds')
    if (typeof select !== 'function') {
        return session.pages.map((page) => page.pageId)
    }
    try {
        const result: unknown = select(session, step.stepId)
        if (
            !Array.isArray(result) ||
            result.length === 0 ||
            result.length > 20 ||
            !result.every(
                (id: unknown): id is string =>
                    typeof id === 'string' && session.pages.some((page) => page.pageId === id),
            ) ||
            new Set(result).size !== result.length
        ) {
            return []
        }
        return result
    } catch {
        return []
    }
}
