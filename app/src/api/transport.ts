import {
    apiResultSchema,
    matchesBinding,
    type ApiResult,
    type CaptureBinding,
    type ManualBinding,
} from '@truebuild/contracts'
import { z } from 'zod'

export const MAX_RESPONSE_BYTES = 262_144

// Plain HTTP is for local and LAN development only. HTTPS is accepted for any host.
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost']
const PRIVATE_LAN = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/u

function isDevelopmentHost(hostname: string): boolean {
    return LOOPBACK_HOSTS.includes(hostname) || PRIVATE_LAN.test(hostname)
}

export type UnavailableCode = Extract<ApiResult<never>, { status: 'unavailable' }>['code']
export type ApiMode = 'fixture' | 'model'

/** One validated call description. Shared by the fixture client and the model client. */
export interface Call<T> {
    readonly path: string
    readonly requestId: string
    readonly binding: ManualBinding | CaptureBinding
    readonly fields: Readonly<Record<string, unknown>>
    readonly valueSchema: z.ZodType<T>
    readonly accepts: (value: T, binding: ManualBinding | CaptureBinding) => boolean
    readonly signal: AbortSignal | undefined
}

export class InvalidResponseError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options)
        this.name = 'InvalidResponseError'
    }
}

export function parseBaseUrl(raw: string): string {
    const url = new URL(raw)

    const schemeAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && isDevelopmentHost(url.hostname))
    if (
        !schemeAllowed ||
        url.username !== '' ||
        url.password !== '' ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== ''
    ) {
        throw new Error('API base URL must be an https origin, or a loopback/LAN http origin for development, without credentials, path, query or hash')
    }

    return url.origin
}

export function unavailableResult<T>(
    requestId: string,
    binding: ManualBinding | CaptureBinding | null,
    code: UnavailableCode,
    retryable: boolean,
): ApiResult<T> {
    return { status: 'unavailable', requestId, binding, code, retryable }
}

export function invalidInputResult<T>(requestId: string): ApiResult<T> {
    return unavailableResult(requestId, null, 'invalid_input', false)
}

/** An envelope may be trusted only if it echoes this request's identity, binding and (for values) mode. */
export function echoesRequest(
    result: ApiResult<unknown>,
    call: { requestId: string; binding: ManualBinding | CaptureBinding },
    mode: ApiMode,
): boolean {
    if (
        result.requestId !== call.requestId ||
        result.binding === null ||
        !matchesBinding(result.binding, call.binding)
    ) {
        return false
    }

    return result.status === 'unavailable' || result.mode === mode
}

export function statusResult<T>(
    status: number,
    call: { requestId: string; binding: ManualBinding | CaptureBinding },
): ApiResult<T> {
    if (status === 401 || status === 403) {
        return unavailableResult(call.requestId, call.binding, 'unauthorized', false)
    }

    if (status === 400 || status === 413 || status === 415) {
        return unavailableResult(call.requestId, call.binding, 'invalid_input', false)
    }

    if (status >= 500 && status < 600) {
        return unavailableResult(call.requestId, call.binding, 'provider_error', true)
    }

    return unavailableResult(call.requestId, call.binding, 'invalid_output', false)
}

/**
 * Model-mode classification of an HTTP error with no echoed envelope. Pre-body rejections (no body read) carry a
 * placeholder identity, so the status alone decides. A success status is never classified here.
 */
export function modelStatusResult<T>(
    status: number,
    call: { requestId: string; binding: ManualBinding | CaptureBinding },
): ApiResult<T> {
    if (status === 401 || status === 403) {
        return unavailableResult(call.requestId, call.binding, 'unauthorized', false)
    }
    if (status === 503) {
        return unavailableResult(call.requestId, call.binding, 'unconfigured', false)
    }
    if (status === 400 || status === 413 || status === 415) {
        return unavailableResult(call.requestId, call.binding, 'invalid_input', false)
    }
    if (status === 409) {
        return unavailableResult(call.requestId, call.binding, 'duplicate_request', false)
    }
    if (status === 429) {
        return unavailableResult(call.requestId, call.binding, 'budget_exhausted', false)
    }
    if (status === 504) {
        return unavailableResult(call.requestId, call.binding, 'timeout', true)
    }
    if (status >= 500 && status < 600) {
        return unavailableResult(call.requestId, call.binding, 'provider_error', true)
    }
    return unavailableResult(call.requestId, call.binding, 'invalid_output', false)
}

/** Own a handoff even when a test/native transport ignores cancellation; late values are explicitly discarded. */
export function awaitStopped<T>(pending: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject): void => {
        let settled = false
        const onAbort = (): void => {
            if (!settled) {
                settled = true
                signal.removeEventListener('abort', onAbort)
                reject(new Error('Request stopped'))
            }
        }

        signal.addEventListener('abort', onAbort, { once: true })
        pending.then(
            (value): void => {
                if (settled) {
                    discard?.(value)
                    return
                }

                settled = true
                signal.removeEventListener('abort', onAbort)

                if (signal.aborted) {
                    discard?.(value)
                    reject(new Error('Request stopped'))
                } else {
                    resolve(value)
                }
            },
            (error: unknown): void => {
                if (!settled) {
                    settled = true
                    signal.removeEventListener('abort', onAbort)
                    reject(error)
                }
            },
        )

        if (signal.aborted) {
            onAbort()
        }
    })
}

export function discardResponse(response: Response): void {
    void response.body?.cancel().catch((): void => undefined)
}

/** Reads capped bytes while owning cancellation and checking the same absolute deadline at each handoff. */
export async function readBoundedText(
    response: Response,
    signal: AbortSignal,
    checkpoint: () => void,
): Promise<string> {
    const declared = response.headers.get('content-length')

    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
        discardResponse(response)
        throw new InvalidResponseError('Response exceeds the size limit')
    }

    if (response.body === null) {
        return ''
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let completed = false
    const onAbort = (): void => {
        void reader.cancel().catch((): void => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
        for (;;) {
            checkpoint()
            const next = await awaitStopped(reader.read(), signal)
            checkpoint()

            if (next.done) {
                completed = true
                break
            }

            total += next.value.byteLength

            if (total > MAX_RESPONSE_BYTES) {
                onAbort()
                throw new InvalidResponseError('Response exceeds the size limit')
            }

            chunks.push(next.value)
        }
    } finally {
        signal.removeEventListener('abort', onAbort)

        if (!completed) {
            onAbort()
        }
        reader.releaseLock()
    }

    const body = new Uint8Array(total)
    let offset = 0

    for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
    }

    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch (error: unknown) {
        throw new InvalidResponseError('Response is not valid UTF-8', { cause: error })
    }
}

export interface CallGuard {
    readonly signal: AbortSignal
    /** Throws when the caller aborted, the owned controller aborted, or the absolute deadline has passed. */
    readonly checkpoint: () => void
    readonly callerAborted: () => boolean
    readonly timedOut: () => boolean
    readonly dispose: () => void
}

/**
 * One absolute monotonic deadline per call, parented to the caller's signal. Timeouts abort the owned controller,
 * so a transport that honours the signal stops and a late response is discarded by the caller.
 */
export function createCallGuard(timeoutMs: number, callerSignal: AbortSignal | undefined): CallGuard {
    const controller = new AbortController()
    const deadline = performance.now() + timeoutMs
    const timer = setTimeout((): void => controller.abort(), timeoutMs)
    const onCallerAbort = (): void => controller.abort()
    // A function call keeps TypeScript from narrowing `aborted` to its pre-await value.
    const callerAborted = (): boolean => callerSignal?.aborted === true
    const timedOut = (): boolean => controller.signal.aborted || performance.now() >= deadline

    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    return {
        signal: controller.signal,
        checkpoint: (): void => {
            if (callerAborted() || timedOut()) {
                controller.abort()
                throw new Error('Request stopped')
            }
        },
        callerAborted,
        timedOut,
        dispose: (): void => {
            clearTimeout(timer)
            callerSignal?.removeEventListener('abort', onCallerAbort)
        },
    }
}

/** Interprets one HTTP status and body against the call's envelope rules. Pure: performs no I/O. */
export type StatusClassifier = <T>(
    status: number,
    call: { requestId: string; binding: ManualBinding | CaptureBinding },
) => ApiResult<T>

export function interpretEnvelope<T>(
    call: Call<T>,
    status: number,
    text: string,
    mode: ApiMode,
    classify: StatusClassifier = statusResult,
): ApiResult<T> {
    const succeeded = status >= 200 && status < 300
    let json: unknown

    try {
        json = JSON.parse(text)
    } catch {
        // A failure status without a JSON envelope is classified by its status code, not as invalid output.
        return succeeded
            ? unavailableResult(call.requestId, call.binding, 'invalid_output', false)
            : classify(status, call)
    }

    if (!succeeded) {
        const failure = apiResultSchema(z.unknown()).safeParse(json)

        if (failure.success && failure.data.status === 'unavailable' && echoesRequest(failure.data, call, mode)) {
            return unavailableResult(call.requestId, call.binding, failure.data.code, failure.data.retryable)
        }

        return classify(status, call)
    }

    const envelope = apiResultSchema(call.valueSchema).safeParse(json)

    if (!envelope.success) {
        return unavailableResult(call.requestId, call.binding, 'invalid_output', false)
    }

    const result = envelope.data

    if (!echoesRequest(result, call, mode)) {
        return unavailableResult(call.requestId, call.binding, 'invalid_output', false)
    }

    if (result.status === 'ok' && !call.accepts(result.value, call.binding)) {
        return unavailableResult(call.requestId, call.binding, 'invalid_output', false)
    }

    return result
}
