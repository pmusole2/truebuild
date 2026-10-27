export class RequestStoppedError extends Error {
    readonly reason: 'timeout' | 'cancelled'

    constructor(reason: 'timeout' | 'cancelled') {
        super(reason)
        this.name = 'RequestStoppedError'
        this.reason = reason
    }
}

export interface Deadline {
    readonly signal: AbortSignal
    checkpoint(): void
    dispose(): void
}

export function createDeadline(timeoutMs: number, parentSignal?: AbortSignal): Deadline {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
        throw new Error('invalid_timeout')
    }

    const expiresAt = performance.now() + timeoutMs
    const controller = new AbortController()
    let stopped: RequestStoppedError | null = null
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function stop(reason: 'timeout' | 'cancelled'): void {
        if (stopped === null) {
            stopped = new RequestStoppedError(reason)
            controller.abort(stopped)
        }
    }

    function onParentAbort(): void {
        stop(performance.now() >= expiresAt ? 'timeout' : 'cancelled')
    }

    function onTimer(): void {
        if (disposed || stopped !== null) {
            return
        }
        const remaining = expiresAt - performance.now()
        if (remaining <= 0) {
            stop('timeout')
        } else {
            timer = setTimeout(onTimer, remaining)
            timer.unref?.()
        }
    }

    if (parentSignal?.aborted) {
        stop('cancelled')
    } else {
        parentSignal?.addEventListener('abort', onParentAbort, { once: true })
        timer = setTimeout(onTimer, timeoutMs)
        timer.unref?.()
    }

    return {
        signal: controller.signal,
        checkpoint(): void {
            if (stopped === null && performance.now() >= expiresAt) {
                stop('timeout')
            }
            if (stopped !== null) {
                throw stopped
            }
        },
        dispose(): void {
            if (disposed) {
                return
            }
            disposed = true
            if (timer !== undefined) {
                clearTimeout(timer)
            }
            parentSignal?.removeEventListener('abort', onParentAbort)
            stop(performance.now() >= expiresAt ? 'timeout' : 'cancelled')
        },
    }
}
