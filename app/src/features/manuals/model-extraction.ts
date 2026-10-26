import {
    manualSessionSchema,
    parsedManualSchema,
    type Fact,
    type ManualBinding,
    type ManualPage,
    type ManualSession,
    type ManualStep,
    type ParsedManual,
} from '@truebuild/contracts'

/** Pages sent in one extraction request. Matches the frozen wire limit for parse requests. */
export const EXTRACTION_MAX_PAGES = 3

const ID_MAX_LENGTH = 128

export class ExtractionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ExtractionError'
    }
}

/** Pages already cited by the preserved raw extraction. Appending a batch never re-extracts these. */
export function extractedPageIds(session: ManualSession): ReadonlySet<string> {
    const raw = session.rawExtraction
    if (raw === null) {
        return new Set()
    }
    const factRefs = <T>(fact: Fact<T>): readonly { pageId: string }[] =>
        fact.state === 'known' ? fact.sourceRefs : []
    const stepRefs = (step: ManualStep): readonly { pageId: string }[] => [
        ...step.sourceRefs,
        ...step.parts.flatMap((part) => factRefs(part.quantity)),
        ...factRefs(step.orientation),
        ...factRefs(step.connection),
        ...step.visibleChecks.flatMap((check) => factRefs(check.description)),
        ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
    ]
    const refs = [...raw.parts.flatMap((part) => factRefs(part.name)), ...raw.steps.flatMap(stepRefs)]
    return new Set(refs.map((ref) => ref.pageId))
}

/**
 * Pages already used as extraction sources. The recorded list is authoritative, because a page read without any cited
 * fact is still a source. Older sessions have no list, so their cited pages are the only evidence of custody.
 */
export function extractionSourcesOf(session: ManualSession): ReadonlySet<string> {
    return session.extractionSourcePageIds !== undefined
        ? new Set(session.extractionSourcePageIds)
        : extractedPageIds(session)
}

/** Validates a page selection for one batch. Returns the pages in session order, or the user-facing reason. */
export function selectBatch(
    session: ManualSession,
    pageIds: readonly string[],
    _mode: 'append' | 'replace',
): { pages: ManualPage[] } | { reason: string } {
    const unique = new Set(pageIds)
    if (pageIds.length === 0) {
        return { reason: 'Select one to three source pages to extract.' }
    }
    if (unique.size !== pageIds.length || pageIds.length > EXTRACTION_MAX_PAGES) {
        return { reason: `Select up to ${EXTRACTION_MAX_PAGES} different pages per extraction.` }
    }
    const pages = session.pages.filter((page) => unique.has(page.pageId))
    if (pages.length !== pageIds.length) {
        return { reason: 'One of the selected pages is no longer in this manual. Select again.' }
    }
    const already = extractionSourcesOf(session)
    if (pages.some((page) => already.has(page.pageId))) {
        return {
            reason: 'A selected page already has raw extraction. Choose other pages, or create another manual to extract it again.',
        }
    }
    return { pages }
}

/** Deterministic namespace for one batch: its pages identify it, so repeated previews of one batch agree. */
export function batchNamespace(pageIds: readonly string[]): string {
    const text = [...pageIds].sort().join('|')
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return `b${hash.toString(16).padStart(8, '0')}`
}

/**
 * Maps every part and step identity in a batch into the batch namespace, including each reference to them. Names,
 * descriptions, values and page citations are untouched: only identities change.
 */
export function namespaceBatch(parsed: ParsedManual, namespace: string): ParsedManual {
    const mapId = (id: string): string => {
        const next = `${namespace}-${id}`
        if (next.length > ID_MAX_LENGTH) {
            throw new ExtractionError('An extracted identity is too long to keep. Extract fewer or shorter pages.')
        }
        return next
    }
    const mapFact = <T, R>(fact: Fact<T>, map: (value: T) => R): Fact<R> =>
        fact.state === 'known'
            ? { state: 'known', value: map(fact.value), sourceRefs: fact.sourceRefs }
            : { state: 'unknown', reason: fact.reason }

    return {
        parts: parsed.parts.map((part) => ({ ...part, partId: mapId(part.partId) })),
        steps: parsed.steps.map((step) => ({
            ...step,
            stepId: mapId(step.stepId),
            parts: step.parts.map((part) => ({ ...part, partId: mapId(part.partId) })),
            orientation: mapFact(step.orientation, (value) => ({ ...value, partId: mapId(value.partId) })),
            connection: mapFact(step.connection, (value) => ({ ...value, partIds: value.partIds.map(mapId) })),
        })),
        unknowns: parsed.unknowns,
    }
}

/**
 * Appends a namespaced batch after the existing raw facts. Existing facts, steps and unknowns are kept exactly; new
 * steps take orders after the existing ones. Any identity clash is rejected by the registry schema, never merged.
 */
export function appendBatch(existing: ParsedManual | null, incoming: ParsedManual): ParsedManual {
    if (existing === null) {
        return incoming
    }
    const base = existing.steps.reduce((max, step) => Math.max(max, step.order), 0)
    const ordered = [...incoming.steps].sort((left, right) => left.order - right.order)
    const merged: ParsedManual = {
        parts: [...existing.parts, ...incoming.parts],
        steps: [...existing.steps, ...ordered.map((step, index) => ({ ...step, order: base + index + 1 }))],
        unknowns: [...existing.unknowns, ...incoming.unknowns],
    }
    const valid = parsedManualSchema.safeParse(merged)
    if (!valid.success) {
        throw new ExtractionError('These extracted facts clash with existing ones. Nothing was applied.')
    }
    return valid.data
}

export type ExtractionPreview = {
    readonly binding: ManualBinding
    readonly pageIds: readonly string[]
    // The extraction-source list the session will hold after apply: appended to, or reset to the selection.
    readonly sourcePageIds: readonly string[]
    readonly mode: 'append' | 'replace'
    readonly extraction: ParsedManual
    readonly counts: { readonly parts: number; readonly steps: number; readonly unknowns: number }
}

/** Builds the preview the user reviews. Nothing is written here; the result is applied only by an explicit action. */
export function previewBatch(
    session: ManualSession,
    pageIds: readonly string[],
    mode: 'append' | 'replace',
    parsed: ParsedManual,
): ExtractionPreview {
    const extraction =
        mode === 'append' ? appendBatch(session.rawExtraction, namespaceBatch(parsed, batchNamespace(pageIds))) : parsed
    const sourcePageIds =
        mode === 'append' ? [...new Set([...extractionSourcesOf(session), ...pageIds])] : [...new Set(pageIds)]
    return {
        binding: { kind: 'manual', manualId: session.manualId, revision: session.revision },
        pageIds: [...pageIds],
        sourcePageIds,
        mode,
        extraction,
        counts: {
            parts: extraction.parts.length,
            steps: extraction.steps.length,
            unknowns: extraction.unknowns.length,
        },
    }
}

/**
 * Writes a previewed extraction into the raw evidence only. The manual is marked unreviewed and its revision moves on,
 * so earlier results and reviews cannot survive. Reviewed steps are never created or edited here.
 */
export function applyPreview(session: ManualSession, preview: ExtractionPreview, now: string): ManualSession {
    if (preview.binding.manualId !== session.manualId || preview.binding.revision !== session.revision) {
        throw new ExtractionError('The manual changed after this preview was made. Extract again to apply it.')
    }
    const next = manualSessionSchema.safeParse({
        ...session,
        rawExtraction: preview.extraction,
        extractionSourcePageIds: [...preview.sourcePageIds],
        updatedAt: now,
        revision: session.revision + 1,
        reviewStatus: 'unreviewed',
    })
    if (!next.success) {
        throw new ExtractionError('This extraction does not fit the manual and was not applied.')
    }
    return next.data
}
