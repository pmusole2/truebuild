import type { ManualSession, SourceRef } from '@truebuild/contracts'

/**
 * The manual's own citations for one part: where its name is printed, else where this step's count for it is. These are
 * the manual's recorded pages and figure regions, never a guess. A part the manual does not cite on a page of this
 * session has none, and a figure for it must not be drawn.
 */
export function partSourceRefs(session: ManualSession, partId: string, stepIndex: number | undefined): SourceRef[] {
    const pages = new Set(session.pages.map((page) => page.pageId))
    const named = session.parts.find((part) => part.partId === partId)?.name
    const counted =
        stepIndex === undefined
            ? undefined
            : session.reviewedSteps[stepIndex]?.parts.find((part) => part.partId === partId)?.quantity
    const refs = named?.state === 'known' ? named.sourceRefs : counted?.state === 'known' ? counted.sourceRefs : []
    return refs.filter((ref) => pages.has(ref.pageId)).map((ref) => ({ pageId: ref.pageId, region: ref.region }))
}
