import type { ResponsesEvent } from '@meta-sam/parser'

import type { Deadline } from './deadline'

const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024
const MAX_EVENT_BYTES = 1_024 * 1_024
export const SAM_MASK_LIMITS = { perMaskPixels: 1_048_576, totalPixels: 4_194_304 } as const

export class SamStreamError extends Error {
    constructor(readonly code: 'invalid_output' | 'provider_error') {
        super(code)
        this.name = 'SamStreamError'
    }
}

export async function withSamDeadline<T>(promise: Promise<T>, deadline: Deadline): Promise<T> {
    // Attach rejection ownership even if the absolute checkpoint refuses immediately.
    void promise.catch((): void => {})
    deadline.checkpoint()
    let abort: (() => void) | undefined
    const stopped = new Promise<never>((_resolve, reject): void => {
        abort = (): void => {
            try {
                deadline.checkpoint()
            } catch (error) {
                reject(error)
            }
        }
        deadline.signal.addEventListener('abort', abort, { once: true })
        if (deadline.signal.aborted) {
            abort()
        }
    })
    try {
        const value = await Promise.race([promise, stopped])
        deadline.checkpoint()
        return value
    } finally {
        if (abort) {
            deadline.signal.removeEventListener('abort', abort)
        }
    }
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lane(value: Record<string, unknown>): { item_id: string; output_index: number; content_index: number } {
    if (
        typeof value.item_id !== 'string' ||
        value.item_id.length === 0 ||
        value.item_id.length > 128 ||
        !Number.isSafeInteger(value.output_index) ||
        typeof value.output_index !== 'number' ||
        value.output_index < 0 ||
        !Number.isSafeInteger(value.content_index) ||
        typeof value.content_index !== 'number' ||
        value.content_index < 0
    ) {
        throw new SamStreamError('invalid_output')
    }
    return { item_id: value.item_id, output_index: value.output_index, content_index: value.content_index }
}

function responseEvent(value: unknown): ResponsesEvent | null {
    if (!record(value) || typeof value.type !== 'string') {
        throw new SamStreamError('invalid_output')
    }
    switch (value.type) {
        case 'response.output_text.delta':
            if (typeof value.delta !== 'string') {
                throw new SamStreamError('invalid_output')
            }
            return { type: value.type, ...lane(value), delta: value.delta }
        case 'response.output_text.done':
            if (typeof value.text !== 'string') {
                throw new SamStreamError('invalid_output')
            }
            return { type: value.type, ...lane(value), text: value.text }
        case 'response.completed':
            return { type: value.type }
        case 'response.incomplete':
            return { type: value.type, response: {} }
        case 'response.failed':
        case 'error':
            throw new SamStreamError('provider_error')
        case 'response.refusal.delta':
        case 'response.refusal.done':
            throw new SamStreamError('provider_error')
        case 'response.created':
        case 'response.queued':
        case 'response.in_progress':
        case 'response.output_item.added':
        case 'response.output_item.done':
        case 'response.content_part.added':
        case 'response.content_part.done':
            return null
        default:
            throw new SamStreamError('invalid_output')
    }
}

/** Events that carry a `Response` object (ResponseCreated, ResponseCompleted and their siblings). */
const RESPONSE_ENVELOPE_EVENTS = new Set([
    'response.created',
    'response.queued',
    'response.in_progress',
    'response.completed',
    'response.incomplete',
])

/**
 * Owns and cancels the body, including on parser/consumer early return.
 * `onResponse` sees each envelope's `Response` before its event is delivered, and may throw to stop the stream.
 */
export async function* readSamSse(
    response: Response,
    deadline: Deadline,
    onTerminalResponse?: (value: unknown) => void,
    onResponse?: (value: unknown) => void,
): AsyncGenerator<ResponsesEvent> {
    const reader = response.body?.getReader()
    let released = false
    function cancelReader(): void {
        if (reader && !released) {
            released = true
            void reader.cancel().catch((): void => {})
            reader.releaseLock()
        }
    }
    deadline.signal.addEventListener('abort', cancelReader, { once: true })
    try {
        deadline.checkpoint()
        if (
            !reader ||
            !response.ok ||
            response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream'
        ) {
            throw new SamStreamError('provider_error')
        }
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let totalBytes = 0
        let eventBytes = 0
        let lineParts: string[] = []
        let data: string[] = []
        let eventName = ''
        let skipLf = false

        function acceptLine(line: string): ResponsesEvent | null {
            if (line === '') {
                eventBytes = 0
                if (data.length === 0) {
                    eventName = ''
                    return null
                }
                const text = data.join('\n')
                data = []
                if (text === '[DONE]') {
                    throw new SamStreamError('invalid_output')
                }
                let value: unknown
                try {
                    value = JSON.parse(text)
                } catch {
                    throw new SamStreamError('invalid_output')
                }
                if (eventName && (!record(value) || eventName !== value.type)) {
                    throw new SamStreamError('invalid_output')
                }
                eventName = ''
                if (
                    record(value) &&
                    ['response.completed', 'response.failed', 'response.incomplete'].includes(String(value.type))
                ) {
                    onTerminalResponse?.(value.response)
                }
                if (record(value) && RESPONSE_ENVELOPE_EVENTS.has(String(value.type))) {
                    onResponse?.(value.response)
                }
                return responseEvent(value)
            }
            if (line.startsWith(':')) {
                return null
            }
            const colon = line.indexOf(':')
            const field = colon === -1 ? line : line.slice(0, colon)
            const raw = colon === -1 ? '' : line.slice(colon + 1)
            const value = raw.startsWith(' ') ? raw.slice(1) : raw
            if (field === 'data') {
                data.push(value)
            } else if (field === 'event') {
                eventName = value
            }
            return null
        }

        while (true) {
            const chunk = await withSamDeadline(reader.read(), deadline)
            deadline.checkpoint()
            if (chunk.done) {
                try {
                    decoder.decode()
                } catch {
                    throw new SamStreamError('invalid_output')
                }
                if (lineParts.length > 0 || data.length > 0) {
                    throw new SamStreamError('invalid_output')
                }
                return
            }
            totalBytes += chunk.value.byteLength
            if (totalBytes > MAX_RESPONSE_BYTES) {
                throw new SamStreamError('invalid_output')
            }
            let text: string
            try {
                text = decoder.decode(chunk.value, { stream: true })
            } catch {
                throw new SamStreamError('invalid_output')
            }
            let start = 0
            if (skipLf) {
                if (text.startsWith('\n')) {
                    start = 1
                }
                if (text.length > 0) {
                    skipLf = false
                }
            }
            for (let index = start; index < text.length; index += 1) {
                const character = text[index]
                if (character !== '\r' && character !== '\n') {
                    continue
                }
                const part = text.slice(start, index)
                // Reserve both CRLF bytes even when the LF arrives in the next chunk.
                eventBytes += Buffer.byteLength(part) + (character === '\r' ? 2 : 1)
                if (eventBytes > MAX_EVENT_BYTES) {
                    throw new SamStreamError('invalid_output')
                }
                lineParts.push(part)
                const event = acceptLine(lineParts.join(''))
                lineParts = []
                if (character === '\r') {
                    if (text[index + 1] === '\n') {
                        index += 1
                    } else if (index + 1 === text.length) {
                        skipLf = true
                    }
                }
                start = index + 1
                if (event) {
                    deadline.checkpoint()
                    yield event
                    deadline.checkpoint()
                    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
                        return
                    }
                }
            }
            if (start < text.length) {
                const part = text.slice(start)
                eventBytes += Buffer.byteLength(part)
                if (eventBytes > MAX_EVENT_BYTES) {
                    throw new SamStreamError('invalid_output')
                }
                lineParts.push(part)
            }
        }
    } finally {
        deadline.signal.removeEventListener('abort', cancelReader)
        cancelReader()
    }
}

export interface SamGeometry {
    kind: 'image' | 'clip'
    width: number
    height: number
    frameCount: number
}

/** Bound parser allocations/work before its mandatory internal mask decode; do not decode masks twice. */
export async function* guardSamGrammar(
    events: AsyncIterable<ResponsesEvent>,
    geometry: SamGeometry,
    deadline: Deadline,
): AsyncGenerator<ResponsesEvent> {
    let pending = ''
    let received = ''
    let sawDelta = false
    let totalPixels = 0
    const frames = new Set<number>()

    function preflight(line: string): void {
        if (!line.trim()) {
            return
        }
        const marker = /^<(\d+)f>/.exec(line)
        const frame = Number(marker?.[1])
        if (
            !marker ||
            !Number.isSafeInteger(frame) ||
            frame < 0 ||
            frame >= geometry.frameCount ||
            (geometry.kind === 'image' && frame !== 0) ||
            frames.has(frame) ||
            frames.size >= 150
        ) {
            throw new SamStreamError('invalid_output')
        }
        frames.add(frame)
        let boxes = 0
        let masks = 0
        for (const token of line.matchAll(/<\|(box|mask);([^|]*)\|>/gu)) {
            const fields = new Map<string, string>()
            for (const field of (token[2] ?? '').split(';')) {
                const equals = field.indexOf('=')
                if (equals < 0) {
                    continue
                }
                const key = field.slice(0, equals).trim()
                if (fields.has(key)) {
                    throw new SamStreamError('invalid_output')
                }
                fields.set(key, field.slice(equals + 1).trim())
            }
            if (token[1] === 'box') {
                boxes += 1
                if (Number(fields.get('w')) !== geometry.width || Number(fields.get('h')) !== geometry.height) {
                    throw new SamStreamError('invalid_output')
                }
            } else {
                masks += 1
                const size = /^(\d+),(\d+),[!~]/u.exec(fields.get('data') ?? '')
                const height = Number(size?.[1])
                const width = Number(size?.[2])
                const pixels = width * height
                if (
                    !Number.isSafeInteger(width) ||
                    !Number.isSafeInteger(height) ||
                    width <= 0 ||
                    height <= 0 ||
                    width > geometry.width ||
                    height > geometry.height ||
                    pixels > SAM_MASK_LIMITS.perMaskPixels
                ) {
                    throw new SamStreamError('invalid_output')
                }
                totalPixels += pixels
                if (totalPixels > SAM_MASK_LIMITS.totalPixels) {
                    throw new SamStreamError('invalid_output')
                }
            }
        }
        if (boxes === 0 || boxes > 16 || masks !== boxes) {
            throw new SamStreamError('invalid_output')
        }
    }

    for await (const event of events) {
        deadline.checkpoint()
        if (event.type === 'response.output_text.delta') {
            sawDelta = true
            received += event.delta
            pending += event.delta
            let boundary = pending.indexOf('\n')
            while (boundary >= 0) {
                const line = pending.slice(0, boundary + 1)
                pending = pending.slice(boundary + 1)
                preflight(line)
                deadline.checkpoint()
                yield { ...event, delta: line }
                deadline.checkpoint()
                boundary = pending.indexOf('\n')
            }
        } else if (event.type === 'response.output_text.done') {
            if (sawDelta && event.text !== received) {
                throw new SamStreamError('invalid_output')
            }
            if (!sawDelta) {
                for (const line of event.text.split('\n')) {
                    preflight(line)
                }
            } else if (pending.length > 0) {
                preflight(pending)
                yield { ...event, type: 'response.output_text.delta', delta: pending }
                pending = ''
            }
            deadline.checkpoint()
            yield event
        } else {
            if (pending.trim() && event.type === 'response.completed') {
                throw new SamStreamError('invalid_output')
            }
            yield event
        }
        deadline.checkpoint()
    }
}
