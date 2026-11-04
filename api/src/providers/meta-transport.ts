import type { Deadline } from '../server/deadline'

/** Primary checks permit an explicit reset even when upstream receipt is unknown; other operations keep their prior rules. */
export function retryableNetworkFailure(error: unknown, resetOnly = false): boolean {
    let eligible = !resetOnly && error instanceof TypeError && error.message === 'fetch failed'
    const pending: unknown[] = [error]
    const seen = new Set<object>()
    while (pending.length > 0) {
        const current = pending.pop()
        if (typeof current !== 'object' || current === null || seen.has(current)) continue
        seen.add(current)
        if ('code' in current && (current.code === 'ECONNRESET' || current.code === 'UND_ERR_SOCKET')) return resetOnly
        if (!resetOnly && 'code' in current && current.code === 'ETIMEDOUT') eligible = true
        if ('cause' in current) pending.push(current.cause)
        if (current instanceof AggregateError) {
            const nested: unknown = current.errors
            if (Array.isArray(nested)) pending.push(...nested)
        }
    }
    return eligible
}

const retryDeadlines = new WeakMap<Response, number | null>()

/** Classify once per actual response, so guard and transport share an exact monotonic deadline or a final denial. */
export function retryAfterDeadline(response: Response): number | undefined {
    const cached = retryDeadlines.get(response)
    if (cached !== undefined) return cached ?? undefined
    const value = response.headers.get('retry-after')?.trim()
    const milliseconds =
        response.status !== 429 || !value
            ? Number.NaN
            : /^\d+(?:\.\d+)?$/u.test(value)
              ? Number(value) * 1_000
              : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value) &&
                  new Date(value).toUTCString() === value
                ? Math.max(0, Date.parse(value) - Date.now())
                : Number.NaN
    const retryAt =
        Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 2_000
            ? performance.now() + milliseconds
            : null
    retryDeadlines.set(response, retryAt)
    return retryAt ?? undefined
}
export interface ProviderMetrics {
    operation:
        | 'parse'
        | 'check'
        | 'question'
        | 'segment'
        | 'second_opinion'
        | 'screen'
        | 'document'
        | 'overlay'
        | 'pieces'
        | 'stepMotion'
    /** The configured request target, never a claim about what answered; see `modelIdentity`. */
    model: string
    /** Whether the provider's own response reported `model`. Absent on events logged before any response body. */
    modelIdentity?: 'verified' | 'unverified'
    status: number
    latencyMs: number
    inputTokens?: number
    cachedTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    imagesProcessed?: number
    videoFramesProcessed?: number
    /** Policy stage and configured reasoning effort of the call. */
    effort?: string
    stage?: string
    /** Admission-to-send, send-to-body, JSON parse + validation, and whole-call milliseconds. */
    timeToProviderMs?: number
    providerMs?: number
    parseValidateMs?: number
    totalMs?: number
    /** Split of providerMs: pacing/backoff wait, time to response headers, time reading the body. */
    paceWaitMs?: number
    networkMs?: number
    bodyMs?: number
    timeToCreatedMs?: number
    timeToFirstSummaryMs?: number
    timeToFirstOutputMs?: number
    streamEventCount?: number
    attempt?: number
}

/** Filled in by `MetaTransport.send`: where the time before the response headers went. */
export interface TransportObservation {
    /** Pacing reservation wait plus status-retry backoff. */
    paceWaitMs: number
    /** Time from each dispatch to its response headers, summed over bounded status retries. */
    networkMs: number
}

export function usageMetrics(
    value: unknown,
): Pick<
    ProviderMetrics,
    'inputTokens' | 'cachedTokens' | 'outputTokens' | 'reasoningTokens' | 'imagesProcessed' | 'videoFramesProcessed'
> {
    const object = (v: unknown): Record<string, unknown> =>
        typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
    const usage = object(object(value).usage)
    const number = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
    return {
        imagesProcessed: number(usage.images_processed),
        videoFramesProcessed: number(usage.video_frames_processed),
        inputTokens: number(usage.input_tokens),
        outputTokens: number(usage.output_tokens),
        cachedTokens: number(object(usage.input_tokens_details).cached_tokens),
        reasoningTokens: number(object(usage.output_tokens_details).reasoning_tokens),
    }
}

/** Aborts waiting and takes custody even when a transport ignores the signal. */
export async function settleMetaResponse(pending: Promise<Response>, deadline: Deadline): Promise<Response> {
    let settled: Response | undefined
    let delivered = false
    const owned = pending.then((response) => {
        settled = response
        try {
            deadline.checkpoint()
        } catch (error) {
            void response.body?.cancel().catch(() => {})
            throw error
        }
        return response
    })
    let abort: (() => void) | undefined
    const stopped = new Promise<never>((_resolve, reject) => {
        abort = (): void => {
            try {
                deadline.checkpoint()
            } catch (error) {
                reject(error)
            }
        }
        deadline.signal.addEventListener('abort', abort, { once: true })
        if (deadline.signal.aborted) abort()
    })
    try {
        const response = await Promise.race([owned, stopped])
        deadline.checkpoint()
        delivered = true
        return response
    } finally {
        if (abort) deadline.signal.removeEventListener('abort', abort)
        if (!delivered) void settled?.body?.cancel().catch(() => {})
    }
}

async function pause(milliseconds: number, deadline: Deadline): Promise<void> {
    deadline.checkpoint()
    if (milliseconds <= 0) return
    await new Promise<void>((resolve, reject) => {
        const expiresAt = performance.now() + milliseconds
        let timer = setTimeout(done, Math.min(milliseconds, 2_147_483_647))
        function cleanup(): void {
            clearTimeout(timer)
            deadline.signal.removeEventListener('abort', abort)
        }
        function abort(): void {
            cleanup()
            try {
                deadline.checkpoint()
            } catch (error) {
                reject(error)
            }
        }
        function done(): void {
            try {
                deadline.checkpoint()
                const remaining = expiresAt - performance.now()
                if (remaining > 0) {
                    timer = setTimeout(done, Math.min(Math.ceil(remaining), 2_147_483_647))
                    return
                }
                cleanup()
                resolve()
            } catch (error) {
                cleanup()
                reject(error)
            }
        }
        deadline.signal.addEventListener('abort', abort, { once: true })
        if (deadline.signal.aborted) abort()
    })
    deadline.checkpoint()
}

/** A provider-instance, per-model pacing reservation. Headers are hints, never an account balance.
 * No reset header is documented: zero remaining conservatively waits a minute.
 */
export class MetaTransport {
    readonly #next = new Map<string, number>()
    constructor(private readonly fetchImpl: typeof fetch) {}

    async send(
        model: string,
        init: RequestInit,
        deadline: Deadline,
        onAttempt?: (status: number, elapsed: number) => void,
        // Legacy 3 remains accepted internally, but never permits more than one 429 retry.
        maxAttempts: 1 | 2 | 3 = 2,
        observed?: TransportObservation,
        networkAttempts: 1 | 2 = 1,
    ): Promise<Response> {
        // Both grants are global to this send, even when a network failure and a 429 happen in either order.
        let networkRetried = false
        let rateLimitRetried = false
        for (let attempt = 0; attempt < 3; attempt++) {
            const waitStart = performance.now()
            // An admitted 429 already waits its exact deadline; quota hints still pace separate sends.
            if (!rateLimitRetried) await pause((this.#next.get(model) ?? 0) - performance.now(), deadline)
            deadline.checkpoint()
            if (observed) observed.paceWaitMs += Math.max(0, performance.now() - waitStart)
            const started = performance.now()
            let response: Response | undefined
            try {
                response = await settleMetaResponse(this.fetchImpl('https://api.meta.ai/v1/responses', init), deadline)
            } catch (error) {
                deadline.checkpoint()
                if (networkAttempts === 1 || networkRetried || !retryableNetworkFailure(error)) throw error
                networkRetried = true
            } finally {
                if (observed) observed.networkMs += Math.max(0, performance.now() - started)
            }
            if (!response) {
                const backoffStart = performance.now()
                await pause(100, deadline) // User-selected pre-response retry delay; no paid failure sample.
                if (observed) observed.paceWaitMs += Math.max(0, performance.now() - backoffStart)
                continue
            }
            onAttempt?.(response.status, Math.max(0, performance.now() - started))
            const number = (name: string): number | undefined => {
                const value = response.headers.get(name)
                return value !== null && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value))
                    ? Number(value)
                    : undefined
            }
            const remainingRequests = number('x-ratelimit-remaining-requests')
            const remainingTokens = number('x-ratelimit-remaining-tokens')
            const requestLimit = number('x-ratelimit-limit-requests')
            const tokenLimit = number('x-ratelimit-limit-tokens')
            let spacing = 0
            if (remainingRequests === 0 || remainingTokens === 0) spacing = 60_000
            else if (requestLimit && remainingRequests !== undefined && remainingRequests / requestLimit < 0.1)
                spacing = 60_000 / requestLimit
            else if (tokenLimit && remainingTokens !== undefined && remainingTokens / tokenLimit < 0.1) spacing = 500
            this.#next.set(model, Math.max(this.#next.get(model) ?? 0, performance.now() + spacing))
            const retryAt = maxAttempts === 1 || rateLimitRetried ? undefined : retryAfterDeadline(response)
            if (retryAt === undefined) return response
            rateLimitRetried = true
            // Retain body custody before waiting; HTTP 500/503 and every non-admitted response are final.
            void response.body?.cancel().catch(() => {})
            const backoffStart = performance.now()
            await pause(retryAt - performance.now(), deadline)
            if (observed) observed.paceWaitMs += Math.max(0, performance.now() - backoffStart)
        }
        throw new Error('provider_error')
    }
}
