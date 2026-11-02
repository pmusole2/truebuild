export class BudgetError extends Error {
    constructor() {
        super('budget_exhausted')
    }
}

/**
 * Explicit attempt counter for injected handlers and bounded tests. The environment runtime uses its daily subclass.
 * Failures, cancellation and unknown outcomes never refund a call.
 */
export class ModelCallCounter {
    #used = 0

    constructor(readonly limit: number = Number.POSITIVE_INFINITY) {
        if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit <= 0)) {
            throw new Error('invalid_model_call_limit')
        }
    }

    get used(): number {
        return this.#used
    }

    claim(): void {
        if (this.#used >= this.limit) {
            throw new BudgetError()
        }
        this.#used += 1
    }
}

/**
 * Finite in-flight bound for provider work. Rationale (correctness, not cost): every in-flight call holds decoded
 * images and a response buffer, the provider paces by request/token rate, and unbounded fan-out would starve the
 * latency-critical verdict path. Foreground callers (verdict, question, overlay, second opinion, segmentation and
 * latency screens) fail fast; background callers (precompute) wait their turn and may never use the last `reserved`
 * slots, so background screen generation cannot starve a foreground call.
 */
export class ConcurrencyGate {
    #active = 0
    readonly #waiting: (() => void)[] = []
    readonly reserved: number

    constructor(
        readonly limit: number,
        /** Slots only foreground work may take. Default: a quarter of the limit (at least one) when limit > 1. */
        reserved?: number,
    ) {
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new Error('invalid_concurrency_limit')
        }
        this.reserved = reserved ?? (limit > 1 ? Math.min(Math.max(1, Math.floor(limit / 4)), limit - 1) : 0)
        if (!Number.isSafeInteger(this.reserved) || this.reserved < 0 || this.reserved >= limit) {
            throw new Error('invalid_concurrency_reserve')
        }
    }

    get active(): number {
        return this.#active
    }

    /** Returns a release function, or null when the gate is full (for background work: when only reserved slots remain). */
    tryAcquire(options: { background?: boolean } = {}): (() => void) | null {
        const ceiling = options.background === true ? this.limit - this.reserved : this.limit
        if (this.#active >= ceiling) return null
        this.#active += 1
        return this.#releaser()
    }

    /** Background wait for a non-reserved slot; rejects if the signal aborts first. The release function is idempotent. */
    async acquire(signal: AbortSignal): Promise<() => void> {
        while (true) {
            signal.throwIfAborted()
            const release = this.tryAcquire({ background: true })
            if (release) return release
            await new Promise<void>((resolve, reject) => {
                const wake = (): void => {
                    signal.removeEventListener('abort', abort)
                    resolve()
                }
                const abort = (): void => {
                    const index = this.#waiting.indexOf(wake)
                    if (index >= 0) this.#waiting.splice(index, 1)
                    reject(signal.reason)
                }
                this.#waiting.push(wake)
                signal.addEventListener('abort', abort, { once: true })
            })
        }
    }

    #releaser(): () => void {
        let released = false
        return (): void => {
            if (released) return
            released = true
            this.#active -= 1
            this.#waiting.shift()?.()
        }
    }
}
