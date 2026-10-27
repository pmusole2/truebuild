// Fixed user-facing text only. Raw platform or library messages never reach a notice.
export const MEDIA_MESSAGES = {
    unsupported: 'Only JPEG, PNG and WebP photos can be used. Export the photo in one of those formats.',
    unreadable: 'This image could not be read. Export it again as JPEG, PNG or WebP.',
    oversize:
        'This photo could not fit the app image budget after resizing, or exceeds the 32 MiB raw-read limit. Choose a smaller photo.',
    pixels: 'Photo dimensions exceed the app decode limit or could not be read. Choose a smaller photo.',
    permission:
        'Photo library access was not allowed. Enable Photos in device settings, or scan pages with the camera.',
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
