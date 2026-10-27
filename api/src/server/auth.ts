import { createHash, timingSafeEqual } from 'node:crypto'

export class AuthenticationError extends Error {
    constructor() {
        super('unauthorized')
    }
}

/** Fixed-size digests permit a timing-safe comparison regardless of supplied header length. */
export class SharedKeyAuth {
    readonly #digest: Buffer | null

    constructor(options: { sharedSecret?: string }) {
        this.#digest = options.sharedSecret ? createHash('sha256').update(options.sharedSecret).digest() : null
    }

    authenticate(request: Request): void {
        const supplied = request.headers.get('x-truebuild-key')
        const digest = createHash('sha256')
            .update(supplied ?? '')
            .digest()
        const matches = timingSafeEqual(this.#digest ?? Buffer.alloc(32), digest)
        digest.fill(0)
        if (this.#digest === null || supplied === null || !matches) {
            throw new AuthenticationError()
        }
    }
}
