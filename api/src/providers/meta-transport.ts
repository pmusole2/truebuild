import type { Deadline } from '../server/deadline'

export const RETRY_STATUSES = new Set([429, 500, 503])
export interface ProviderMetrics {
    operation: 'parse' | 'check' | 'question' | 'segment' | 'second_opinion' | 'screen' | 'document' | 'overlay'
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
        const timer = setTimeout(done, Math.min(milliseconds, 2_147_483_647))
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
            cleanup()
            try {
                deadline.checkpoint()
                resolve()
            } catch (error) {
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
        maxAttempts: 1 | 3 = 3,
        observed?: TransportObservation,
    ): Promise<Response> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const waitStart = performance.now()
            await pause((this.#next.get(model) ?? 0) - performance.now(), deadline)
            deadline.checkpoint()
            if (observed) observed.paceWaitMs += Math.max(0, performance.now() - waitStart)
            const started = performance.now()
            // A rejected/ambiguous dispatch is deliberately never retried.
            const response = await settleMetaResponse(
                this.fetchImpl('https://api.meta.ai/v1/responses', init),
                deadline,
            )
            if (observed) observed.networkMs += Math.max(0, performance.now() - started)
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
            if (!RETRY_STATUSES.has(response.status) || attempt === maxAttempts - 1) return response
            // Status-only retries own/discard the rejected body before backoff, even plain-text or empty errors.
            void response.body?.cancel().catch(() => {})
            const retry = response.headers.get('retry-after')
            const retryMs =
                retry === null
                    ? 0
                    : /^\d+(?:\.\d+)?$/u.test(retry.trim())
                      ? Number(retry) * 1000
                      : Math.max(0, Date.parse(retry) - Date.now())
            const backoffStart = performance.now()
            await pause(
                Math.max(500 * 2 ** attempt + Math.random() * 250, Number.isNaN(retryMs) ? 0 : retryMs),
                deadline,
            )
            if (observed) observed.paceWaitMs += Math.max(0, performance.now() - backoffStart)
        }
        throw new Error('provider_error')
    }
}
