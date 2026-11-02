import { describe, expect, it, vi } from 'vitest'
import { createParseDeadline, RequestStoppedError } from '../server/deadline'
import { parseStreamGuard, readParseStream } from './parse-stream'

const encoder = new TextEncoder()
const event = (type: string, rest: Record<string, unknown> = {}): Uint8Array =>
    encoder.encode(`event: ${type}\r\ndata: ${JSON.stringify({ type, ...rest })}\r\n\r\n`)

function source(): {
    response: Response
    send: (type: string, rest?: Record<string, unknown>) => void
    cancelled: () => boolean
} {
    let controller: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start(value): void {
                controller = value
            },
            cancel(): void {
                cancelled = true
            },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
    )
    return {
        response,
        send: (type, rest): void => controller.enqueue(event(type, rest)),
        cancelled: (): boolean => cancelled,
    }
}

describe('streamed parse deadlines', () => {
    it('accepts slow steady events beyond 55 seconds and assembles the terminal response', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        const parent = createParseDeadline(120_000)
        const progress: string[] = []
        const guard = parseStreamGuard(parent, (phase): void => {
            progress.push(phase)
        })
        const stream = source()
        const final = {
            status: 'completed',
            model: 'muse-spark-1.3',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"steps":[]}' }] }],
            usage: { output_tokens: 72 },
        }
        const result = readParseStream(stream.response, guard)
        try {
            stream.send('response.created')
            await vi.advanceTimersByTimeAsync(0)
            for (let tick = 0; tick < 9; tick++) {
                await vi.advanceTimersByTimeAsync(10_000)
                stream.send('response.in_progress')
                await vi.advanceTimersByTimeAsync(0)
            }
            stream.send('response.output_text.delta', { delta: '{' })
            stream.send('response.completed', { response: final })
            expect(await result).toEqual(final)
            expect(guard.timing.timeToCreatedMs).toBe(0)
            expect(guard.timing.timeToFirstOutputMs).toBe(90_000)
            expect(progress).toEqual(['reading', 'output'])
            expect(stream.cancelled()).toBe(true)
            // A terminal failure must retain the full observed response, identity and usage for the existing validator.
            for (const status of ['failed', 'incomplete'] as const) {
                const terminalGuard = parseStreamGuard(parent)
                const terminalSource = source()
                const terminal = { ...final, status, usage: { output_tokens: 73 } }
                const terminalResult = readParseStream(terminalSource.response, terminalGuard)
                terminalSource.send('response.created')
                terminalSource.send(`response.${status}`, { response: terminal })
                expect(await terminalResult).toEqual(terminal)
                expect(terminalSource.cancelled()).toBe(true)
                terminalGuard.dispose()
            }
        } finally {
            guard.dispose()
            parent.dispose()
            vi.useRealTimers()
        }
    })

    it('fails a silent stream with the timeout category used by the existing reading error and Try again flow', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        const parent = createParseDeadline(120_000)
        const guard = parseStreamGuard(parent)
        const stream = source()
        const result = readParseStream(stream.response, guard)
        const rejection = expect(result).rejects.toMatchObject({ name: 'RequestStoppedError', reason: 'timeout' })
        try {
            stream.send('response.created')
            await vi.advanceTimersByTimeAsync(0)
            await vi.advanceTimersByTimeAsync(20_001)
            await rejection
            expect(guard.deadline.signal.reason).toBeInstanceOf(RequestStoppedError)
            expect(stream.cancelled()).toBe(true)
        } finally {
            guard.dispose()
            parent.dispose()
            vi.useRealTimers()
        }
    })
})
