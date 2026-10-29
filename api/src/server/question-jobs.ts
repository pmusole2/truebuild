import { randomUUID } from 'node:crypto'

import type { CaptureBinding } from '@truebuild/contracts'

import { matchesBinding } from '@truebuild/contracts'

export interface QuestionIdentity {
    requestId: string
    binding: CaptureBinding
}

/** The final HTTP response of a question, kept so a retrieval never re-asks the model. */
export interface StoredResponse {
    status: number
    body: string
    headers: [string, string][]
}

export interface QuestionJob {
    readonly ticket: string
    readonly controller: AbortController
    identity: QuestionIdentity | undefined
    stored: StoredResponse | undefined
    /** Resolves once the request identity is known or the job has finished, whichever is first. */
    readonly identified: Promise<void>
    /** Resolves when the job has finished (answered, failed, cancelled or expired). */
    readonly settled: Promise<void>
    readonly deadlineAt: number
    finishedAt: number | undefined
}

/** The same original request (identity) is already owned by a job; it is never dispatched twice. */
export class DuplicateQuestionError extends Error {
    constructor() {
        super('duplicate_question')
        this.name = 'DuplicateQuestionError'
    }
}

export type TerminalKind = 'expired' | 'failed'

const identityKey = (identity: QuestionIdentity): string =>
    JSON.stringify([
        identity.requestId,
        identity.binding.manualId,
        identity.binding.revision,
        identity.binding.stepId,
        identity.binding.captureId,
    ])

/** An identity stays fenced for this long after its job began, longer than any job and its retained result. */
const FENCE_MS = 10 * 60_000
const FENCE_MAX = 1_024
/** After the processing budget plus margin has passed and the abort is signalled, an abort-ignoring run is concluded. */
const SETTLE_GRACE_MS = 2_000
const EXPIRY_MARGIN_MS = 5_000

/**
 * Slow questions run server-side for up to `processingMs` and are collected by ticket. A client that stops waiting
 * (or disconnects) never causes a 504 for the user; the job keeps going until it finishes, is cancelled, is
 * superseded by a newer revision, or its server-side expiry passes, and every end stores a terminal response so a
 * later collection is answered gracefully. One original request (request id and exact capture binding) owns at most one
 * job, ever, within the fence: a repeat is rejected before any provider dispatch and never mints another ticket.
 * Bounds are correctness bounds: a finite number of tracked jobs and a finite retention of finished answers.
 */
export class QuestionJobs {
    readonly #jobs = new Map<string, QuestionJob>()
    readonly #fence = new Map<string, number>()

    constructor(
        readonly options: {
            processingMs: number
            /** How long a finished answer remains collectable. */
            retentionMs?: number
            max?: number
            now?: () => number
            /** Test hooks for the settle margin after the processing budget and the grace before force-concluding. */
            expiryMarginMs?: number
            settleGraceMs?: number
            /** Runs when the identity is known and before any provider work; throwing rejects the request. */
            onIdentity?: (identity: QuestionIdentity, job: QuestionJob) => void
            /** Builds the stored terminal response for a job that expired or failed without producing one. */
            terminal: (kind: TerminalKind, identity: QuestionIdentity | undefined) => StoredResponse
        },
    ) {}

    get #now(): number {
        return this.options.now?.() ?? Date.now()
    }

    get size(): number {
        this.#prune()
        return this.#jobs.size
    }

    #prune(): void {
        const retention = this.options.retentionMs ?? 120_000
        const now = this.#now
        for (const [ticket, job] of this.#jobs) {
            if (job.finishedAt !== undefined && now - job.finishedAt >= retention) this.#jobs.delete(ticket)
        }
        for (const [key, until] of this.#fence) if (now >= until) this.#fence.delete(key)
    }

    /** Returns null when the finite job table is full. */
    start(
        run: (signal: AbortSignal, identify: (identity: QuestionIdentity) => void) => Promise<StoredResponse>,
    ): QuestionJob | null {
        this.#prune()
        if (this.#jobs.size >= (this.options.max ?? 64)) return null
        const controller = new AbortController()
        let resolveIdentified: () => void = (): void => {}
        const identified = new Promise<void>((resolve) => {
            resolveIdentified = resolve
        })
        let resolveSettled: () => void = (): void => {}
        const settled = new Promise<void>((resolve) => {
            resolveSettled = resolve
        })
        const job: QuestionJob = {
            ticket: randomUUID(),
            controller,
            identity: undefined,
            stored: undefined,
            identified,
            settled,
            deadlineAt: this.#now + this.options.processingMs,
            finishedAt: undefined,
        }
        const timers: ReturnType<typeof setTimeout>[] = []
        const conclude = (stored: StoredResponse | undefined): void => {
            if (job.finishedAt !== undefined) return
            job.stored ??= stored
            job.finishedAt = this.#now
            for (const timer of timers) clearTimeout(timer)
            resolveIdentified()
            resolveSettled()
        }
        // Server-side expiry: a job can never outlive its processing budget (plus a small settle margin). If the run
        // ignores the abort, the job is still concluded with a stored terminal response.
        const expiry = setTimeout(
            () => {
                controller.abort()
                const grace = setTimeout(
                    () => conclude(this.options.terminal('expired', job.identity)),
                    SETTLE_GRACE_MS,
                )
                grace.unref?.()
                timers.push(grace)
            },
            this.options.processingMs + (this.options.expiryMarginMs ?? EXPIRY_MARGIN_MS),
        )
        expiry.unref?.()
        timers.push(expiry)
        this.#jobs.set(job.ticket, job)
        run(controller.signal, (identity) => {
            const key = identityKey(identity)
            if (this.#fence.has(key)) throw new DuplicateQuestionError()
            this.options.onIdentity?.(identity, job)
            if (this.#fence.size >= FENCE_MAX) {
                const oldest = this.#fence.keys().next().value
                if (oldest !== undefined) this.#fence.delete(oldest)
            }
            this.#fence.set(key, this.#now + FENCE_MS)
            job.identity = identity
            resolveIdentified()
        }).then(
            (stored) => conclude(stored),
            () => conclude(this.options.terminal('failed', job.identity)),
        )
        return job
    }

    /** A job is visible only to a request that names its exact identity (request, manual, revision, step, capture). */
    find(ticket: string, requestId: string, binding: CaptureBinding): QuestionJob | undefined {
        this.#prune()
        const job = this.#jobs.get(ticket)
        return job?.identity && job.identity.requestId === requestId && matchesBinding(job.identity.binding, binding)
            ? job
            : undefined
    }

    cancel(ticket: string, requestId: string, binding: CaptureBinding): boolean {
        const job = this.find(ticket, requestId, binding)
        if (!job) return false
        job.controller.abort()
        return true
    }

    /** Cancels running jobs of the same manual with an older revision. */
    supersede(manualId: string, revision: number, except: string): void {
        for (const job of this.#jobs.values()) {
            if (
                job.ticket !== except &&
                job.finishedAt === undefined &&
                job.identity?.binding.manualId === manualId &&
                job.identity.binding.revision < revision
            ) {
                job.controller.abort()
            }
        }
    }

    remainingMs(job: QuestionJob): number {
        return Math.max(1, job.deadlineAt - this.#now)
    }
}
