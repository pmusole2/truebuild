import {
    manualSessionSchema,
    type Fact,
    type ManualSession,
    type ManualPage,
    type ManualPart,
    type ManualStep,
    type ParsedManual,
    LIMITS,
    type SourceRef,
} from '@truebuild/contracts'

const REMOVED_SOURCE_REASON =
    'The source page was removed. Confirm this part name from another page or enter it manually.'

export function createManualSession(title: string, pages: ManualPage[]): ManualSession {
    const now = new Date().toISOString()
    const manualId = `manual_${Date.now()}_${Math.random().toString(36).substring(7)}`

    const session: ManualSession = {
        manualId,
        title,
        updatedAt: now,
        revision: 1,
        pages,
        parts: [],
        rawExtraction: null,
        reviewedSteps: [],
        reviewStatus: 'unreviewed',
    }

    return manualSessionSchema.parse(session)
}

export function replaceReviewedSteps(session: ManualSession, steps: ManualStep[]): ManualSession {
    const updated: ManualSession = {
        ...session,
        reviewedSteps: steps,
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
        reviewStatus: 'unreviewed',
    }

    return manualSessionSchema.parse(updated)
}

/** Explicit review action. It is a state change, so it advances the revision the UI compares against savedRevision. */
export function markManualReviewed(session: ManualSession): ManualSession {
    const updated: ManualSession = {
        ...session,
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
        reviewStatus: 'reviewed',
    }

    return manualSessionSchema.parse(updated)
}

export function replaceReviewedParts(session: ManualSession, parts: ManualPart[]): ManualSession {
    const updated: ManualSession = {
        ...session,
        parts,
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
        reviewStatus: 'unreviewed',
    }

    return manualSessionSchema.parse(updated)
}

export function renameManual(session: ManualSession, title: string): ManualSession {
    const updated: ManualSession = {
        ...session,
        title,
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
        reviewStatus: 'unreviewed',
    }

    return manualSessionSchema.parse(updated)
}

function factRefs<T>(fact: Fact<T>): SourceRef[] {
    return fact.state === 'known' ? fact.sourceRefs : []
}

/** Every location in a step that can cite a page: step, orientation, connection, quantities, checks and corrections. */
function stepSourceRefs(step: ManualStep): SourceRef[] {
    return [
        ...step.sourceRefs,
        ...factRefs(step.orientation),
        ...factRefs(step.connection),
        ...step.parts.flatMap((part) => factRefs(part.quantity)),
        ...step.visibleChecks.flatMap((check) => factRefs(check.description)),
        ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
    ]
}

function partSourceRefs(part: ManualPart): SourceRef[] {
    return factRefs(part.name)
}

function extractionSourceRefs(extraction: ParsedManual): SourceRef[] {
    return [...extraction.parts.flatMap(partSourceRefs), ...extraction.steps.flatMap(stepSourceRefs)]
}

/**
 * Removes a page and everything that depends on it. Preserved raw extraction is never edited: if it cites the page
 * the removal is rejected. Reviewed steps citing the page at any nested location are dropped, and reviewed part names
 * citing it become unknown facts. The input session is never mutated.
 */
export function removeManualPage(session: ManualSession, pageId: string): ManualSession {
    const pageExists = session.pages.some((page) => page.pageId === pageId)

    if (!pageExists) {
        throw new Error(`Page ${pageId} not found in manual`)
    }

    if (session.extractionSourcePageIds?.includes(pageId)) {
        throw new Error('Cannot remove a preserved extraction source. Keep it with its raw evidence.')
    }

    const cites = (refs: readonly SourceRef[]): boolean => refs.some((ref) => ref.pageId === pageId)

    if (session.rawExtraction !== null && cites(extractionSourceRefs(session.rawExtraction))) {
        throw new Error(
            `Cannot remove page ${pageId}: the preserved raw extraction cites it. ` +
                'Raw extraction is kept unchanged, so this page must stay in the manual.',
        )
    }

    const updated: ManualSession = {
        ...session,
        pages: session.pages.filter((page) => page.pageId !== pageId),
        parts: session.parts.map((part: ManualPart): ManualPart =>
            cites(partSourceRefs(part)) ? { ...part, name: { state: 'unknown', reason: REMOVED_SOURCE_REASON } } : part,
        ),
        reviewedSteps: session.reviewedSteps.filter((step: ManualStep): boolean => !cites(stepSourceRefs(step))),
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
        reviewStatus: 'unreviewed',
    }

    return manualSessionSchema.parse(updated)
}

export class AssetValidationError extends Error {
    constructor(
        public code:
            'unsupported_mime_type' | 'oversized_file' | 'oversized_pixels' | 'too_many_pages' | 'invalid_input',
        message: string,
    ) {
        super(message)
        this.name = 'AssetValidationError'
    }
}

const SUPPORTED_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']

export function validateImportAsset(
    asset: { mimeType: unknown; byteLength: unknown; width: unknown; height: unknown },
    existingPageCount: number,
): void {
    if (typeof asset.mimeType !== 'string') {
        throw new AssetValidationError('invalid_input', 'MIME type must be a string')
    }

    if (typeof asset.byteLength !== 'number' || !Number.isInteger(asset.byteLength) || asset.byteLength <= 0) {
        throw new AssetValidationError('invalid_input', 'Byte length must be a positive integer')
    }

    if (typeof asset.width !== 'number' || !Number.isInteger(asset.width) || asset.width <= 0) {
        throw new AssetValidationError('invalid_input', 'Width must be a positive integer')
    }

    if (typeof asset.height !== 'number' || !Number.isInteger(asset.height) || asset.height <= 0) {
        throw new AssetValidationError('invalid_input', 'Height must be a positive integer')
    }

    if (!Number.isInteger(existingPageCount) || existingPageCount < 0) {
        throw new AssetValidationError('invalid_input', 'Existing page count must be a non-negative integer')
    }

    if (!SUPPORTED_MIME_TYPES.includes(asset.mimeType)) {
        throw new AssetValidationError(
            'unsupported_mime_type',
            `Unsupported MIME type: ${asset.mimeType}. Supported: ${SUPPORTED_MIME_TYPES.join(', ')}`,
        )
    }

    if (asset.byteLength > LIMITS.imageBytes) {
        throw new AssetValidationError(
            'oversized_file',
            `Image size ${asset.byteLength} bytes exceeds limit of ${LIMITS.imageBytes} bytes`,
        )
    }

    const pixelCount = asset.width * asset.height

    if (pixelCount > LIMITS.imagePixels) {
        throw new AssetValidationError(
            'oversized_pixels',
            `Image dimensions exceed limit of ${LIMITS.imagePixels} pixels (${pixelCount} provided)`,
        )
    }

    if (existingPageCount + 1 > LIMITS.manualPages) {
        throw new AssetValidationError(
            'too_many_pages',
            `Adding a page would exceed the limit of ${LIMITS.manualPages} pages`,
        )
    }
}
