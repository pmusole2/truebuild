import type { ManualPage, ParsedManual } from '@truebuild/contracts'

type RawStep = ParsedManual['steps'][number]

/** Every page a parsed result cites, anywhere in its parts, steps, checks, quantities and corrections. */
export function citedPageIdsOf(parsed: ParsedManual): Set<string> {
    const refs = [
        ...parsed.parts.flatMap((part) => (part.name.state === 'known' ? part.name.sourceRefs : [])),
        ...parsed.steps.flatMap((step) => [
            ...step.sourceRefs,
            ...step.parts.flatMap((part) => (part.quantity.state === 'known' ? part.quantity.sourceRefs : [])),
            ...(step.orientation.state === 'known' ? step.orientation.sourceRefs : []),
            ...(step.connection.state === 'known' ? step.connection.sourceRefs : []),
            ...step.visibleChecks.flatMap((check) =>
                check.description.state === 'known' ? check.description.sourceRefs : [],
            ),
            ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
        ]),
    ]
    return new Set(refs.map((ref) => ref.pageId))
}

/**
 * Conservative custody: a selected page counts as extracted only if the returned evidence cites it. Pages without a
 * citation are returned so the caller can refuse the batch; no reference is ever invented for them.
 */
export function uncitedPages(pages: readonly ManualPage[], parsed: ParsedManual): ManualPage[] {
    const cited = citedPageIdsOf(parsed)
    return pages.filter((page) => !cited.has(page.pageId))
}

/** Plain-language lines for one extracted step: facts, unknowns, citations and any proposed correction. */
export function describeRawStep(
    step: RawStep,
    parts: ParsedManual['parts'],
    pageNumber: (pageId: string) => number | undefined,
): string[] {
    const partName = (partId: string): string => {
        const part = parts.find((candidate) => candidate.partId === partId)
        return part !== undefined && part.name.state === 'known' ? part.name.value : partId
    }
    const lines = [`Step ${step.order}: ${step.title}`]
    for (const part of step.parts) {
        lines.push(
            part.quantity.state === 'known'
                ? `Part ${partName(part.partId)} × ${part.quantity.value}`
                : `Part ${partName(part.partId)}: quantity unknown (${part.quantity.reason})`,
        )
    }
    lines.push(
        step.orientation.state === 'known'
            ? `Orientation: ${step.orientation.value.description}`
            : `Orientation unknown: ${step.orientation.reason}`,
    )
    lines.push(
        step.connection.state === 'known'
            ? `Connection: ${step.connection.value.description}`
            : `Connection unknown: ${step.connection.reason}`,
    )
    for (const check of step.visibleChecks) {
        lines.push(
            check.description.state === 'known'
                ? `Check: ${check.description.value}`
                : `Check unknown: ${check.description.reason}`,
        )
    }
    if (step.correction !== null) {
        for (const action of step.correction.actions) {
            lines.push(`Proposed correction (not confirmed): ${action.instruction}`)
        }
    }
    const pages = [
        ...new Set(step.sourceRefs.map((ref) => pageNumber(ref.pageId)).filter((n): n is number => n !== undefined)),
    ]
    lines.push(pages.length === 0 ? 'Cited: no page' : `Cited: ${pages.map((n) => `page ${n}`).join(', ')}`)
    return lines
}
