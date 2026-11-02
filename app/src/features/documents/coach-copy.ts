import type { CoachCandidate } from '../onboarding/coach-types'

/** Document-written copy/order changes only targets the mounted screen already owns. */
export function applyWrittenTips(
    candidates: readonly CoachCandidate[],
    tips: ReadonlyMap<string, { readonly heading: string; readonly text: string }> | undefined,
): readonly CoachCandidate[] {
    if (tips === undefined || tips.size === 0) return candidates
    const written: CoachCandidate[] = []
    for (const [targetId, tip] of tips) {
        const native = candidates.find((candidate) => candidate.id === targetId)
        if (native !== undefined) written.push({ ...native, heading: tip.heading, sentence: tip.text })
    }
    return [...written, ...candidates.filter((candidate) => !tips.has(candidate.id))]
}
