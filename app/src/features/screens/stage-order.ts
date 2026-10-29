/**
 * The stages of one held photo, in the order they really arrived on this phone. The verdict is always first: it is the
 * only stage that exists before the others are asked for. Every other stage is placed by when it landed or failed,
 * measured from the verdict, with ties kept in the canonical order. A stage that has not arrived (still working,
 * skipped, never offered) has no arrival time and follows the arrived ones in the canonical order. Nothing is estimated.
 */
export const CANONICAL_STAGES = ['verdict', 'result', 'mask', 'regions'] as const
export type StageId = (typeof CANONICAL_STAGES)[number]

export function orderStages<T extends { readonly id: StageId; readonly at: number | null }>(stages: readonly T[]): T[] {
    const rank = (stage: T): number => CANONICAL_STAGES.indexOf(stage.id)
    return [...stages].sort((a, b) => {
        if (a.id === 'verdict' || b.id === 'verdict') return a.id === 'verdict' ? -1 : 1
        if (a.at === null || b.at === null) {
            if (a.at === b.at) return rank(a) - rank(b)
            return a.at === null ? 1 : -1
        }
        return a.at - b.at || rank(a) - rank(b)
    })
}
