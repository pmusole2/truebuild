import type { ScreenProgress, ScreenState } from '@truebuild/contracts'

/** Process-local LRU with a TTL. Holds composed documents only: no photo, image bytes, key or provider text. */
export class ScreenCache<V> {
    readonly #entries = new Map<string, { value: V; expires: number }>()

    constructor(
        readonly max = 256,
        readonly ttlMs = 6 * 60 * 60_000,
        private readonly now: () => number = () => Date.now(),
    ) {}

    get size(): number {
        return this.#entries.size
    }

    get(key: string): V | undefined {
        const entry = this.#entries.get(key)
        if (!entry) return undefined
        if (this.now() >= entry.expires) {
            this.#entries.delete(key)
            return undefined
        }
        // Refresh recency.
        this.#entries.delete(key)
        this.#entries.set(key, entry)
        return entry.value
    }

    set(key: string, value: V): void {
        this.#entries.delete(key)
        this.#entries.set(key, { value, expires: this.now() + this.ttlMs })
        while (this.#entries.size > this.max) {
            const oldest = this.#entries.keys().next().value
            if (oldest === undefined) break
            this.#entries.delete(oldest)
        }
    }
}

/**
 * One in-flight computation per key. Waiters share the result; a waiter that leaves only detaches itself, and the
 * computation stops (via its signal) only when the last waiter is gone. A failed computation is not cached.
 */
export class SingleFlight<V> {
    readonly #flights = new Map<string, { promise: Promise<V>; controller: AbortController; waiters: number }>()

    get active(): number {
        return this.#flights.size
    }

    async run(key: string, start: (signal: AbortSignal) => Promise<V>, waiter?: AbortSignal): Promise<V> {
        // An already-aborted waiter never starts or joins work, and so never holds a waiter count.
        waiter?.throwIfAborted()
        let flight = this.#flights.get(key)
        // A new intentional request cannot join work whose last waiter already left. The old producer may ignore its
        // cancelled signal and settle later; its identity-checked cleanup must leave any replacement flight alone.
        if (flight?.controller.signal.aborted) {
            this.#flights.delete(key)
            flight = undefined
        }
        if (!flight) {
            const controller = new AbortController()
            const created = {
                controller,
                waiters: 0,
                promise: start(controller.signal).finally(() => {
                    if (this.#flights.get(key) === created) this.#flights.delete(key)
                }),
            }
            void created.promise.catch((): void => {})
            this.#flights.set(key, created)
            flight = created
        }
        const joined = flight
        joined.waiters += 1
        const leave = (): void => {
            joined.waiters -= 1
            if (joined.waiters <= 0) joined.controller.abort()
        }
        if (!waiter) {
            try {
                return await joined.promise
            } finally {
                joined.waiters -= 1
            }
        }
        let onAbort: (() => void) | undefined
        const left = new Promise<never>((_resolve, reject) => {
            onAbort = (): void => {
                leave()
                reject(waiter.reason)
            }
            waiter.addEventListener('abort', onAbort, { once: true })
        })
        try {
            return await Promise.race([joined.promise, left])
        } finally {
            if (onAbort) waiter.removeEventListener('abort', onAbort)
            if (!waiter.aborted) joined.waiters -= 1
        }
    }
}

/**
 * Newest revision wins per manual. Work registered under an older revision is cancelled the moment a newer revision
 * is observed, and a request for an older revision is reported stale. This prevents a stale session from consuming
 * provider capacity or publishing into a newer one; it never rejects verdict work (the client binding already does).
 */
export class StaleGuard {
    readonly #latest = new Map<string, number>()
    readonly #work = new Map<string, Set<{ revision: number; controller: AbortController }>>()

    /** True when no newer revision of this manual has been observed. */
    isCurrent(manualId: string, revision: number): boolean {
        return revision >= (this.#latest.get(manualId) ?? 0)
    }

    /** Returns false when the revision is older than one already observed. */
    observe(manualId: string, revision: number): boolean {
        const latest = this.#latest.get(manualId) ?? 0
        if (revision < latest) return false
        this.#latest.set(manualId, revision)
        for (const entry of this.#work.get(manualId) ?? []) {
            if (entry.revision < revision) entry.controller.abort(new StaleRevisionError())
        }
        if (this.#latest.size > 256) {
            const oldest = this.#latest.keys().next().value
            if (oldest !== undefined && oldest !== manualId) this.#latest.delete(oldest)
        }
        return true
    }

    /**
     * Registers cancellable work; call the returned function when it settles. Registration is atomic with the check
     * against the newest observed revision: work for an older revision is aborted at once and never runs, and work
     * registered before it can be waiting (for capacity, say) is cancelled the moment a newer revision is observed.
     */
    register(manualId: string, revision: number, controller: AbortController): () => void {
        if (!this.isCurrent(manualId, revision)) {
            controller.abort(new StaleRevisionError())
            return (): void => {}
        }
        const entry = { revision, controller }
        const set = this.#work.get(manualId) ?? new Set()
        set.add(entry)
        this.#work.set(manualId, set)
        return (): void => {
            set.delete(entry)
            if (set.size === 0) this.#work.delete(manualId)
        }
    }
}

export class StaleRevisionError extends Error {
    constructor() {
        super('stale_revision')
        this.name = 'StaleRevisionError'
    }
}

export interface PrecomputeStep {
    stepId: string
    order: number
    /** Cache key of the step's screen; progress readers fetch the document by it. */
    key: string
}

export interface StepOutcome {
    state: Extract<ScreenState, 'ready' | 'fallback' | 'failed'>
    screenId: string | null
}

interface Job {
    manualId: string
    revision: number
    contextKey: string
    mode: ScreenProgress['mode']
    controller: AbortController
    steps: Map<string, PrecomputeStep & { state: ScreenState; screenId: string | null }>
    queue: string[]
}

/**
 * Bounded background precompute of per-step screens. The focused step runs first, then manual order, so the first
 * steps are available before the rest. Concurrency is finite (provider pacing and memory, not cost). A newer
 * revision of the same manual cancels the older job.
 */
export class PrecomputeRegistry {
    readonly #jobs = new Map<string, Job>()

    constructor(
        readonly concurrency = 3,
        readonly maxJobs = 16,
    ) {
        if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error('invalid_precompute_concurrency')
    }

    #key(manualId: string, revision: number): string {
        return `${manualId}:${revision}`
    }

    start(
        input: {
            manualId: string
            revision: number
            contextKey: string
            mode: ScreenProgress['mode']
            steps: readonly PrecomputeStep[]
            focusStepId: string | null
        },
        run: (stepId: string, signal: AbortSignal) => Promise<StepOutcome>,
    ): ScreenProgress {
        this.cancel(input.manualId, input.revision)
        const key = this.#key(input.manualId, input.revision)
        const existing = this.#jobs.get(key)
        if (existing && existing.contextKey === input.contextKey && !existing.controller.signal.aborted) {
            return this.#progress(existing)
        }
        existing?.controller.abort()
        const ordered = [...input.steps].sort((a, b) => a.order - b.order)
        const focus = ordered.find((step) => step.stepId === input.focusStepId)
        const queue = [...(focus ? [focus] : []), ...ordered.filter((step) => step !== focus)].map(
            (step) => step.stepId,
        )
        const job: Job = {
            manualId: input.manualId,
            revision: input.revision,
            contextKey: input.contextKey,
            mode: input.mode,
            controller: new AbortController(),
            steps: new Map(ordered.map((step) => [step.stepId, { ...step, state: 'queued', screenId: null }])),
            queue,
        }
        this.#jobs.set(key, job)
        while (this.#jobs.size > this.maxJobs) {
            const oldest = this.#jobs.entries().next().value
            if (!oldest) break
            oldest[1].controller.abort()
            this.#jobs.delete(oldest[0])
        }
        for (let worker = 0; worker < Math.min(this.concurrency, queue.length); worker++) void this.#work(job, run)
        return this.#progress(job)
    }

    async #work(job: Job, run: (stepId: string, signal: AbortSignal) => Promise<StepOutcome>): Promise<void> {
        for (let stepId = job.queue.shift(); stepId !== undefined; stepId = job.queue.shift()) {
            const step = job.steps.get(stepId)
            if (!step || job.controller.signal.aborted) return
            step.state = 'running'
            try {
                const outcome = await run(stepId, job.controller.signal)
                if (job.controller.signal.aborted) {
                    step.state = 'cancelled'
                    return
                }
                step.state = outcome.state
                step.screenId = outcome.screenId
            } catch {
                step.state = job.controller.signal.aborted ? 'cancelled' : 'failed'
            }
        }
    }

    #progress(job: Job): ScreenProgress {
        return {
            manualId: job.manualId,
            revision: job.revision,
            contextKey: job.contextKey,
            mode: job.mode,
            steps: [...job.steps.values()]
                .sort((a, b) => a.order - b.order)
                .map((step) => ({ stepId: step.stepId, state: step.state, screenId: step.screenId })),
        }
    }

    progress(manualId: string, revision: number): ScreenProgress | null {
        const job = this.#jobs.get(this.#key(manualId, revision))
        return job ? this.#progress(job) : null
    }

    /** Cache key of a finished step, so a reader can fetch its document. */
    keyOf(manualId: string, revision: number, stepId: string): string | null {
        const step = this.#jobs.get(this.#key(manualId, revision))?.steps.get(stepId)
        return step && (step.state === 'ready' || step.state === 'fallback') ? step.key : null
    }

    /** Cancels this revision's job and every older revision of the same manual. Returns the number cancelled. */
    cancel(manualId: string, upToRevision?: number, inclusive = upToRevision === undefined): number {
        let cancelled = 0
        for (const [key, job] of this.#jobs) {
            if (job.manualId !== manualId) continue
            const applies =
                upToRevision === undefined || (inclusive ? job.revision <= upToRevision : job.revision < upToRevision)
            if (!applies) continue
            job.controller.abort()
            job.queue.length = 0
            for (const step of job.steps.values()) {
                if (step.state === 'queued' || step.state === 'running') step.state = 'cancelled'
            }
            cancelled += 1
            if (upToRevision !== undefined && job.revision < upToRevision) this.#jobs.delete(key)
        }
        return cancelled
    }
}
