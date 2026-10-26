// Fixed user-facing text only. Raw platform or library messages never reach a notice.
export const IMPORT_MESSAGES = {
    unsupported: 'Only JPEG, PNG and WebP pages can be imported. Export the page in one of those formats.',
    unreadable: 'This image could not be read. Export it again as JPEG, PNG or WebP.',
    oversize: 'Each page must be 4 MiB or smaller. Export a smaller copy and try again.',
    pixels: 'Each page must be 24 megapixels or smaller. Export a smaller copy and try again.',
    pageCount: 'A manual can hold at most 20 pages. Choose fewer pages and try again.',
    generic: 'The pages could not be imported. Nothing was saved.',
} as const

export type ImportFailure = keyof typeof IMPORT_MESSAGES

export class ImportRejectedError extends Error {
    readonly failure: ImportFailure

    constructor(failure: ImportFailure) {
        super(IMPORT_MESSAGES[failure])
        this.name = 'ImportRejectedError'
        this.failure = failure
    }
}

// Only our own rejections expose text. Anything else becomes the generic message.
export function userMessageForImportError(error: unknown): string {
    return error instanceof ImportRejectedError ? error.message : IMPORT_MESSAGES.generic
}
