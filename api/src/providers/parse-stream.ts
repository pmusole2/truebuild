import { RequestStoppedError, type Deadline } from '../server/deadline'

export type ParseProgress = 'reading' | 'output'
export interface ParseStreamTiming {
    timeToCreatedMs?: number
    timeToFirstSummaryMs?: number
    timeToFirstOutputMs?: number
    eventCount: number
}

const FIRST_EVENT_MS = 15_000
const IDLE_MS = 30_000
const MAX_STREAM_BYTES = 4_194_304
const MAX_EVENT_BYTES = 1_048_576
const MAX_EVENTS = 65_536

export class ParseStreamError extends Error {
    constructor(readonly code: 'invalid_output' | 'provider_error') {
        super(code)
        this.name = 'ParseStreamError'
    }
}

/** Covers the wait for headers as well as the SSE body. Events never extend the parent's overall ceiling. */
export function parseStreamGuard(
    parent: Deadline,
    onProgress?: (phase: ParseProgress) => void,
): {
    deadline: Deadline
    timing: ParseStreamTiming
    event(type: string, hasOutput?: boolean): void
    dispose(): void
} {
    const started = performance.now()
    const controller = new AbortController()
    const timing: ParseStreamTiming = { eventCount: 0 }
    let due = started + FIRST_EVENT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => controller.abort(new RequestStoppedError('timeout'))
    const parentAbort = (): void => controller.abort(parent.signal.reason)
    const arm = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        if (!Number.isFinite(due)) return
        timer = setTimeout(stop, Math.max(0, due - performance.now()))
        timer.unref?.()
    }
    const checkpoint = (): void => {
        parent.checkpoint()
        if (!controller.signal.aborted && performance.now() >= due) stop()
        controller.signal.throwIfAborted()
    }
    const progress = (phase: ParseProgress): void => {
        try {
            onProgress?.(phase)
        } catch {
            /* Progress is advisory, never authority over a valid parse. */
        }
    }
    if (parent.signal.aborted) parentAbort()
    else parent.signal.addEventListener('abort', parentAbort, { once: true })
    arm()
    return {
        deadline: { signal: controller.signal, checkpoint, dispose: (): void => {} },
        timing,
        event(type, hasOutput = true): void {
            checkpoint()
            timing.eventCount++
            if (timing.eventCount > MAX_EVENTS) throw new ParseStreamError('invalid_output')
            const now = performance.now()
            if (type === 'response.created' && timing.timeToCreatedMs === undefined) {
                timing.timeToCreatedMs = Math.max(0, now - started)
                // Raw reasoning may be silent for most of the attempt. Only the parent ceiling applies until
                // the first output-text delta; optional summaries do not start output idle.
                due = Number.POSITIVE_INFINITY
                arm()
                progress('reading')
            }
            if (
                type === 'response.reasoning_summary_text.delta' &&
                hasOutput &&
                timing.timeToFirstSummaryMs === undefined
            ) {
                timing.timeToFirstSummaryMs = Math.max(0, now - started)
            }
            if (type === 'response.output_text.delta' && hasOutput && timing.timeToFirstOutputMs === undefined) {
                timing.timeToFirstOutputMs = Math.max(0, now - started)
                progress('output')
            }
            if (timing.timeToCreatedMs !== undefined && timing.timeToFirstOutputMs !== undefined) {
                due = now + IDLE_MS
                arm()
            }
        },
        dispose(): void {
            if (timer !== undefined) clearTimeout(timer)
            parent.signal.removeEventListener('abort', parentAbort)
        },
    }
}

async function within<T>(pending: Promise<T>, deadline: Deadline): Promise<T> {
    deadline.checkpoint()
    let abort: (() => void) | undefined
    const stopped = new Promise<never>((_resolve, reject) => {
        abort = (): void => reject(deadline.signal.reason)
        deadline.signal.addEventListener('abort', abort, { once: true })
        if (deadline.signal.aborted) abort()
    })
    try {
        return await Promise.race([pending, stopped])
    } finally {
        if (abort !== undefined) deadline.signal.removeEventListener('abort', abort)
    }
}

/** The terminal event carries the complete response; the existing strict response/output validator still owns it. */
export async function readParseStream(
    response: Response,
    guard: ReturnType<typeof parseStreamGuard>,
): Promise<unknown> {
    if (!response.body) throw new ParseStreamError('invalid_output')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = '',
        bytes = 0
    let final: unknown
    let complete = false
    const consume = (block: string): void => {
        const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /u, ''))
            .join('\n')
        if (!data || data === '[DONE]') return
        if (new TextEncoder().encode(data).byteLength > MAX_EVENT_BYTES) throw new ParseStreamError('invalid_output')
        let event: unknown
        try {
            event = JSON.parse(data)
        } catch {
            throw new ParseStreamError('invalid_output')
        }
        if (typeof event !== 'object' || event === null || !('type' in event) || typeof event.type !== 'string')
            throw new ParseStreamError('invalid_output')
        guard.event(event.type, 'delta' in event && typeof event.delta === 'string' && event.delta.length > 0)
        if (event.type === 'error') throw new ParseStreamError('provider_error')
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
            if (guard.timing.timeToCreatedMs === undefined || !('response' in event))
                throw new ParseStreamError('invalid_output')
            final = event.response
            complete = true
        }
    }
    try {
        while (!complete) {
            const chunk = await within(reader.read(), guard.deadline)
            guard.deadline.checkpoint()
            if (chunk.done) {
                buffer += decoder.decode()
                if (buffer.trim()) consume(buffer)
                if (!complete) throw new ParseStreamError('invalid_output')
                break
            }
            bytes += chunk.value.byteLength
            if (bytes > MAX_STREAM_BYTES) throw new ParseStreamError('invalid_output')
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/gu, '\n')
            // Handle CRLF split between chunks without manufacturing an event boundary.
            buffer = buffer.replace(/\r\n/gu, '\n')
            let end = buffer.indexOf('\n\n')
            while (end >= 0 && !complete) {
                const block = buffer.slice(0, end)
                buffer = buffer.slice(end + 2)
                if (block.length > MAX_EVENT_BYTES) throw new ParseStreamError('invalid_output')
                consume(block)
                end = buffer.indexOf('\n\n')
            }
            if (buffer.length > MAX_EVENT_BYTES) throw new ParseStreamError('invalid_output')
        }
        return final
    } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}
