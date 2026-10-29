// One privacy contract for every surface. Each sentence matches what the controller actually sends.
export const PRIVACY_COPY = {
    stayOnDevice:
        'Your pages and photos stay on this phone until you read your manual, check a step, or ask a question.',
    read: 'Reading sends the pages you chose to the TrueBuild service to find the steps.',
    check: 'Checking sends your photo with the pages of your manual it is compared to, up to 20 pages.',
    ask: 'Asking sends your photo with the pages of your manual it is answered from, up to 20 pages.',
    camera: 'The camera opens only when you choose to take a photo of a manual page or a step.',
    library: 'Photos you choose from your library stay on this phone until you send them.',
    once: 'Each request is sent once. A stopped request is not repeated on its own.',
} as const
