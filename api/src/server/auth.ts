import { randomBytes, timingSafeEqual } from 'node:crypto'

import { protectedDirectory, writeProtectedFile, type RunLedger } from './budget'

export type OwnerSession = { runId: string; expiresAt: number }
const SESSION_LIFETIME_MS = 30 * 60 * 1_000
const DEFAULT_ORIGINS = ['http://localhost:8081', 'http://127.0.0.1:8081'] as const

export class SessionError extends Error {
    readonly code: string

    constructor(code: string) {
        super(code)
        this.name = 'SessionError'
        this.code = code
    }
}

export class OwnerSessionManager {
    readonly #privateDirectory: string
    readonly #ledger: RunLedger
    readonly #now: () => number
    #token: Buffer | null = null
    #session: OwnerSession | null = null
    #pending = Promise.resolve()

    constructor(options: { privateDirectory: string; ledger: RunLedger; now?: () => number }) {
        this.#privateDirectory = options.privateDirectory
        this.#ledger = options.ledger
        this.#now = options.now ?? Date.now
    }

    async createSession(options: { newRun: boolean }): Promise<OwnerSession> {
        const { newRun } = options
        if (typeof newRun !== 'boolean') {
            throw new SessionError('invalid_session_options')
        }
        const pending = this.#pending.then(async (): Promise<OwnerSession> => {
            this.#token?.fill(0)
            this.#token = null
            this.#session = null
            try {
                await protectedDirectory(this.#privateDirectory)
                await this.#ledger.load()
                const runId = newRun ? (await this.#ledger.startRun()).runId : this.#ledger.getCurrentRunId()
                if (runId === null) {
                    throw new SessionError('run_required')
                }
                const now = this.#now()
                if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + SESSION_LIFETIME_MS)) {
                    throw new SessionError('session_unavailable')
                }
                const token = randomBytes(32)
                try {
                    await writeProtectedFile(this.#privateDirectory, 'session-token', token.toString('hex'))
                    this.#session = { runId, expiresAt: now + SESSION_LIFETIME_MS }
                    this.#token = token
                    return { ...this.#session }
                } finally {
                    if (this.#token !== token) {
                        token.fill(0)
                    }
                }
            } catch (error) {
                if (error instanceof SessionError) {
                    throw error
                }
                throw new SessionError('session_unavailable')
            }
        })
        this.#pending = pending.then(
            (): void => {},
            (): void => {},
        )
        return pending
    }

    authenticate(authorization: string | null): OwnerSession {
        const now = this.#now()
        if (
            this.#session === null ||
            this.#token === null ||
            !Number.isSafeInteger(now) ||
            now < 0 ||
            now >= this.#session.expiresAt
        ) {
            this.#token?.fill(0)
            this.#token = null
            this.#session = null
            throw new SessionError('unauthorized')
        }
        if (authorization === null || !/^Bearer [a-f0-9]{64}$/u.test(authorization)) {
            throw new SessionError('unauthorized')
        }
        const supplied = Buffer.from(authorization.slice(7), 'hex')
        const matches = timingSafeEqual(this.#token, supplied)
        supplied.fill(0)
        if (!matches || this.#ledger.getCurrentRunId() !== this.#session.runId) {
            throw new SessionError('unauthorized')
        }
        return { ...this.#session }
    }
}

export function requireOwnerSession(
    request: Request,
    manager: OwnerSessionManager,
    options: { allowedOrigins?: readonly string[]; allowNonLoopbackHttps?: boolean } = {},
): OwnerSession {
    try {
        const url = new URL(request.url)
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        if (
            url.username ||
            url.password ||
            !['http:', 'https:'].includes(url.protocol) ||
            (!loopback && !(options.allowNonLoopbackHttps === true && url.protocol === 'https:'))
        ) {
            throw new SessionError('unauthorized')
        }
        const origin = request.headers.get('origin')
        if (origin !== null && !(options.allowedOrigins ?? DEFAULT_ORIGINS).includes(origin)) {
            throw new SessionError('unauthorized')
        }
        return manager.authenticate(request.headers.get('authorization'))
    } catch {
        throw new SessionError('unauthorized')
    }
}
