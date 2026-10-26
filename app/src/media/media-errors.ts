// Fixed user-facing text only. Raw platform or library messages never reach a notice.
export const MEDIA_MESSAGES = {
    unsupported: 'Only JPEG, PNG and WebP photos can be used. Export the photo in one of those formats.',
    unreadable: 'This image could not be read. Export it again as JPEG, PNG or WebP.',
    oversize: 'Each photo must be 4 MiB or smaller. Export a smaller copy and try again.',
    pixels: 'Each photo must be 24 megapixels or smaller. Export a smaller copy and try again.',
    generic: 'The photo could not be used. Nothing was sent.',
} as const

export type MediaFailure = keyof typeof MEDIA_MESSAGES

export class MediaRejectedError extends Error {
    readonly failure: MediaFailure

    constructor(failure: MediaFailure) {
        super(MEDIA_MESSAGES[failure])
        this.name = 'MediaRejectedError'
        this.failure = failure
    }
}

// Only our own rejections expose text. Anything else becomes the generic message.
export function userMessageForMediaError(error: unknown): string {
    return error instanceof MediaRejectedError ? error.message : MEDIA_MESSAGES.generic
}
