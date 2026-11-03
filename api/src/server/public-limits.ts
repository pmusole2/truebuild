import { AsyncLocalStorage } from 'node:async_hooks'
import { isIP } from 'node:net'

import { BudgetError, ModelCallCounter } from './budget'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const MAX_CLIENTS = 10_000
export const PUBLIC_LIMIT_MESSAGE = 'Too many builds right now, try again later.'

export class PublicLimitError extends BudgetError {}

interface ClientUsage {
    hour: number
    parses: number
    calls: number
}

/** The edge must overwrite these forwarding headers. Unknown clients share a conservative fallback bucket. */
function clientIp(request: Request): string {
    const cloudflare = request.headers.get('cf-connecting-ip')?.trim()
    if (cloudflare && isIP(cloudflare)) return cloudflare
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    return forwarded && isIP(forwarded) ? forwarded : 'unknown'
}

/** Single-instance UTC-day ceilings. Async context charges deferred work and retries to their initiating client. */
export class PublicModelCallCounter extends ModelCallCounter {
    readonly #client = new AsyncLocalStorage<string>()
    readonly #clients = new Map<string, ClientUsage>()
    #day = -1
    #calls = 0

    constructor(
        dailyLimit = 1_500,
        readonly clientDailyLimit = 200,
        readonly clientParseHourlyLimit = 10,
        private readonly now: () => number = Date.now,
    ) {
        super(dailyLimit)
        for (const value of [clientDailyLimit, clientParseHourlyLimit]) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_public_limit')
        }
    }

    override get used(): number {
        this.#refreshDay()
        return this.#calls
    }

    runForClient<T>(request: Request, parse: boolean, work: () => T, cacheOnly = false): T {
        return this.#client.run(clientIp(request), () => {
            // Free result lookup must work after the last paid call. A real claim still checks this same client's quota.
            if (cacheOnly && !parse) return work()
            const usage = this.#usage()
            this.#check(usage)
            if (parse) {
                if (usage.parses >= this.clientParseHourlyLimit) throw new PublicLimitError()
                usage.parses += 1
            }
            return work()
        })
    }

    override claim(): void {
        const usage = this.#usage()
        this.#check(usage)
        usage.calls += 1
        this.#calls += 1
    }

    #check(usage: ClientUsage): void {
        if (this.#calls >= this.limit || usage.calls >= this.clientDailyLimit) throw new PublicLimitError()
    }

    #refreshDay(): void {
        const day = Math.floor(this.now() / DAY_MS)
        if (day !== this.#day) {
            this.#day = day
            this.#calls = 0
            this.#clients.clear()
        }
    }

    #usage(): ClientUsage {
        this.#refreshDay()
        // Reject globally exhausted traffic before allocating a new client bucket.
        if (this.#calls >= this.limit) throw new PublicLimitError()
        const client = this.#client.getStore() ?? 'unknown'
        const hour = Math.floor(this.now() / HOUR_MS)
        let usage = this.#clients.get(client)
        if (!usage) {
            // Malformed/failed requests can arrive without spending a model call. Bound their daily memory as well.
            if (this.#clients.size >= MAX_CLIENTS) throw new PublicLimitError()
            usage = { hour, parses: 0, calls: 0 }
            this.#clients.set(client, usage)
        } else if (usage.hour !== hour) {
            usage.hour = hour
            usage.parses = 0
        }
        return usage
    }
}
