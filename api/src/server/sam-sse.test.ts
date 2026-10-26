import { describe, expect, it } from 'vitest'

import { createDeadline } from './deadline'
import { guardSamGrammar, readSamSse } from './sam-sse'

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const result: T[] = []
    for await (const value of source) {
        result.push(value)
    }
    return result
}

function body(parts: readonly string[], onCancel: () => void = (): void => {}): Response {
    const encoded = parts.map((part) => new TextEncoder().encode(part))
    return new Response(
        new ReadableStream<Uint8Array>({
            pull(controller): void {
                const chunk = encoded.shift()
                if (chunk) {
                    controller.enqueue(chunk)
                } else {
                    controller.close()
                }
            },
            cancel: onCancel,
        }),
        { headers: { 'content-type': 'text/event-stream' } },
    )
}

const lane = { item_id: 'message-1', output_index: 0, content_index: 0 }

describe('bounded SAM SSE ownership', (): void => {
    it('handles comments, CRLF and arbitrary event splits', async (): Promise<void> => {
        const deadline = createDeadline(30_000)
        const json = JSON.stringify({ type: 'response.output_text.done', ...lane, text: '' })
        try {
            const events = await collect(
                readSamSse(
                    body([
                        ': comment\r',
                        '\nevent: response.output_text.done\r\nda',
                        `ta: ${json.slice(0, 30)}`,
                        `${json.slice(30)}\r\n\r`,
                        '\ndata: {"type":"response.completed"}\r\n\r\n',
                    ]),
                    deadline,
                ),
            )
            expect(events.map((event) => event.type)).toEqual(['response.output_text.done', 'response.completed'])
        } finally {
            deadline.dispose()
        }
    })

    it.each(['data: {oops}\n\n', `data: ${'x'.repeat(1_048_577)}\n\n`])(
        'rejects malformed/oversized events',
        async (text): Promise<void> => {
            const deadline = createDeadline(30_000)
            try {
                await expect(collect(readSamSse(body([text]), deadline))).rejects.toThrow('invalid_output')
            } finally {
                deadline.dispose()
            }
        },
    )

    it('decodes UTF8 split inside a multibyte character and refuses truncated UTF8', async (): Promise<void> => {
        const bytes = new TextEncoder().encode(
            `data: ${JSON.stringify({
                type: 'response.output_text.done',
                ...lane,
                item_id: 'message-é',
                text: '',
            })}\n\ndata: {"type":"response.completed"}\n\n`,
        )
        const offset = bytes.indexOf(0xc3) + 1
        const deadline = createDeadline(30_000)
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller): void {
                    controller.enqueue(bytes.slice(0, offset))
                    controller.enqueue(bytes.slice(offset))
                    controller.close()
                },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
        )
        try {
            expect((await collect(readSamSse(response, deadline))).map((event) => event.type)).toEqual([
                'response.output_text.done',
                'response.completed',
            ])
            const malformed = new Response(new Uint8Array([0xc3]), { headers: { 'content-type': 'text/event-stream' } })
            await expect(collect(readSamSse(malformed, deadline))).rejects.toThrow('invalid_output')
        } finally {
            deadline.dispose()
        }
    })

    it('counts both CRLF bytes toward the per-event bound', async (): Promise<void> => {
        const deadline = createDeadline(30_000)
        const wire =
            ':x\r\n'.repeat(270_000) +
            `data: ${JSON.stringify({ type: 'response.output_text.done', ...lane, text: '' })}\r\n\r\n` +
            'data: {"type":"response.completed"}\r\n\r\n'
        try {
            await expect(collect(readSamSse(body([wire]), deadline))).rejects.toThrow('invalid_output')
        } finally {
            deadline.dispose()
        }
    })

    it('caps total response bytes even when individual comment events are small', async (): Promise<void> => {
        const deadline = createDeadline(30_000)
        try {
            await expect(
                collect(readSamSse(body(Array.from({ length: 50 }, () => `:${'x'.repeat(100_000)}\n\n`)), deadline)),
            ).rejects.toThrow('invalid_output')
        } finally {
            deadline.dispose()
        }
    })

    it('bounds aggregate decoder pixel work across frames', async (): Promise<void> => {
        const deadline = createDeadline(30_000)
        const text = Array.from(
            { length: 5 },
            (_unused, frame) =>
                `<${frame}f>0<|box;x1=0;y1=0;x2=1023;y2=1023;w=1024;h=1024|><|mask;x=0;y=0;data=1024,1024,!bad|>\n`,
        ).join('')
        try {
            await expect(
                collect(
                    guardSamGrammar(
                        readSamSse(
                            body([
                                `data: ${JSON.stringify({ type: 'response.output_text.delta', ...lane, delta: text })}\n\n`,
                            ]),
                            deadline,
                        ),
                        { kind: 'clip', width: 1024, height: 1024, frameCount: 5 },
                        deadline,
                    ),
                ),
            ).rejects.toThrow('invalid_output')
        } finally {
            deadline.dispose()
        }
    })

    it('cancels and releases the body on early consumer return', async (): Promise<void> => {
        let cancelled = false
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller): void {
                    controller.enqueue(
                        new TextEncoder().encode(
                            `data: ${JSON.stringify({ type: 'response.output_text.done', ...lane, text: '' })}\n\n`,
                        ),
                    )
                },
                cancel(): void {
                    cancelled = true
                },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
        )
        const deadline = createDeadline(30_000)
        for await (const _event of readSamSse(response, deadline)) {
            break
        }
        expect(cancelled).toBe(true)
        expect(response.body?.locked).toBe(false)
        deadline.dispose()
    })

    it('releases a paused consumer body immediately when its parent cancels', async (): Promise<void> => {
        let cancelled = false
        const parent = new AbortController()
        const deadline = createDeadline(30_000, parent.signal)
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller): void {
                    controller.enqueue(
                        new TextEncoder().encode(
                            `data: ${JSON.stringify({
                                type: 'response.output_text.done',
                                ...lane,
                                text: '',
                            })}\n\n`,
                        ),
                    )
                },
                cancel(): void {
                    cancelled = true
                },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
        )
        const source = readSamSse(response, deadline)
        await source.next()
        parent.abort()
        try {
            expect(cancelled).toBe(true)
            expect(response.body?.locked).toBe(false)
        } finally {
            await source.return(undefined)
            deadline.dispose()
        }
    })

    it('rejects oversized mask dimensions before giving grammar to the official decoder', async (): Promise<void> => {
        const deadline = createDeadline(30_000)
        const text = '<0f>0<|box;x1=0;y1=0;x2=3;y2=3;w=4;h=4|><|mask;x=0;y=0;data=99999999,99999999,!bad|>\n'
        const response = body([
            `data: ${JSON.stringify({ type: 'response.output_text.delta', ...lane, delta: text })}\n\n`,
        ])
        try {
            await expect(
                collect(
                    guardSamGrammar(
                        readSamSse(response, deadline),
                        {
                            kind: 'image',
                            width: 4,
                            height: 4,
                            frameCount: 1,
                        },
                        deadline,
                    ),
                ),
            ).rejects.toThrow('invalid_output')
        } finally {
            deadline.dispose()
        }
    })
})
