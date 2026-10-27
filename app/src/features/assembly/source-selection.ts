import type { ManualSession, ManualStep } from '@truebuild/contracts'
import * as modelContracts from '@truebuild/contracts/model'

/** Baseline compatibility while the API track is integrated. Once available, the shared selector is authoritative:
 * it chooses a bounded set covering required facts, including alternative citations. Invalid output fails closed.
 * Older contracts use the stricter all-citation set supplied by the caller. No partial context is invented.
 */
export function selectedStepSourcePageIds(
    session: ManualSession,
    step: ManualStep,
    allCitedIds: readonly string[],
): string[] {
    const select: unknown = Reflect.get(modelContracts, 'selectStepSourcePageIds')
    if (typeof select !== 'function') {
        return allCitedIds.length >= 1 && allCitedIds.length <= 2 ? [...allCitedIds] : []
    }
    try {
        const result: unknown = select(session, step.stepId)
        if (
            !Array.isArray(result) ||
            result.length > 2 ||
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
