import { spawnSync } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'

import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createSamProvider, type SamInput } from './sam'
import type { SegmentEvent } from '@truebuild/contracts'

const servers: Server[] = []
const lane = { item_id: 'message-1', output_index: 0, content_index: 0 }
// Documented synthetic 5x5 one_bit conformance payload from parser README; no media/mask API call.
const mask = '!!!!!(QO(0lu8?'
const grammar = `<0f>7<|box;x1=5;y1=4;x2=9;y2=8;w=20;h=16|><|mask;x=0;y=0;data=5,5,${mask}|>\n`

function event(value: unknown): string {
    return `data: ${JSON.stringify(value)}\r\n\r\n`
}
function completed(text = grammar, terminal = 'response.completed'): string {
    return (
        event({ type: 'response.output_text.delta', ...lane, delta: text }) +
        event({ type: 'response.output_text.done', ...lane, text }) +
        event({ type: terminal, response: {} })
    )
}

async function input(): Promise<SamInput> {
    const bytes = await sharp({ create: { width: 20, height: 16, channels: 3, background: 'red' } })
        .png()
        .toBuffer()
    return {
        requestId: 'request-1',
        binding: { kind: 'capture', manualId: 'manual-1', revision: 1, stepId: 'step-1', captureId: 'capture-1' },
        capturedAt: '2026-01-01T00:00:00.000Z',
        prompt: 'red divider',
        media: { kind: 'image', image: { bytes, width: 20, height: 16, mimeType: 'image/png' } },
    }
}

async function collect(source: AsyncIterable<SegmentEvent>): Promise<SegmentEvent[]> {
    const events: SegmentEvent[] = []
    for await (const value of source) {
        events.push(value)
    }
    return events
}

async function local(
    respond: (response: ServerResponse) => void,
    checkBody?: (value: unknown) => void,
): Promise<{ fetchImpl: typeof fetch; dispatches: () => number }> {
    let calls = 0
    const server = createServer(async (request, response): Promise<void> => {
        // Only the provider dispatch counts; a stray loopback probe from another process is not a model request.
        if (request.method !== 'POST') {
            request.resume()
            response.statusCode = 404
            response.end()
            return
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) {
            if (Buffer.isBuffer(chunk)) {
                chunks.push(chunk)
            }
        }
        if (checkBody) {
            checkBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        }
        response.setHeader('content-type', 'text/event-stream')
        respond(response)
    })
    servers.push(server)
    await new Promise<void>((resolve): void => {
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
        throw new Error('fixture_unavailable')
    }
    const fetchImpl: typeof fetch = async (url, options): Promise<Response> => {
        expect(String(url) === 'https://api.meta.ai/v1/responses').toBe(true)
        calls += 1
        return fetch(`http://127.0.0.1:${address.port}`, options)
    }
    return { fetchImpl, dispatches: (): number => calls }
}

afterEach(async (): Promise<void> => {
    vi.restoreAllMocks()
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve): void => {
                    server.closeAllConnections()
                    server.close((): void => resolve())
                }),
        ),
    )
})

describe('inactive SAM transport over controlled local HTTP', (): void => {
    it('sends fixed fields and normalized inline image, parses real grammar and scopes stream identities', async (): Promise<void> => {
        const wire = z.strictObject({
            model: z.literal('sam-3.1'),
            stream: z.literal(true),
            store: z.literal(false),
            input: z.tuple([
                z.strictObject({
                    type: z.literal('message'),
                    role: z.literal('user'),
                    content: z.tuple([
                        z.strictObject({ type: z.literal('input_text'), text: z.literal('red divider') }),
                        z.strictObject({
                            type: z.literal('input_image'),
                            image_url: z.string().startsWith('data:image/jpeg;base64,'),
                        }),
                    ]),
                }),
            ]),
        })
        const transport = await local(
            (response): void => {
                const text = completed()
                for (let offset = 0; offset < text.length; offset += 7) {
                    response.write(text.slice(offset, offset + 7))
                }
                response.end()
            },
            (value): void => {
                expect(wire.safeParse(value).success).toBe(true)
            },
        )
        const provider = createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl })
        const first = await collect(provider.segment(await input(), new AbortController().signal))
        const second = await collect(provider.segment(await input(), new AbortController().signal))
        expect(first.map((entry) => entry.type)).toEqual(['snapshot', 'completed'])
        const a = first[0]
        const b = second[0]
        if (a?.type !== 'snapshot' || b?.type !== 'snapshot') {
            throw new Error('missing_snapshot')
        }
        expect(a.snapshot.records[0]?.box).toEqual({ x: 0.25, y: 0.25, width: 0.25, height: 0.3125 })
        expect(a.snapshot.records[0]?.objectId).toBe('7')
        expect(a.snapshot.frameIndex).toBe(0)
        expect(a.snapshot.streamId).not.toBe(b.snapshot.streamId)
        expect(transport.dispatches()).toBe(2)
    })

    it('missing key and invalid prompt/media/binding dispatch zero times', async (): Promise<void> => {
        let calls = 0
        const fetchImpl: typeof fetch = async (): Promise<Response> => {
            calls += 1
            throw new Error('unexpected_dispatch')
        }
        const value = await input()
        expect(await collect(createSamProvider({ fetchImpl }).segment(value, new AbortController().signal))).toEqual([
            { type: 'unavailable', code: 'provider_error' },
        ])
        const provider = createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl })
        for (const prompt of ['red panel, blue panel', 'find the divider', 'panel\nside', 'x'.repeat(101), '']) {
            expect(await collect(provider.segment({ ...value, prompt }, new AbortController().signal))).toEqual([
                { type: 'unavailable', code: 'invalid_output' },
            ])
        }
        expect(
            await collect(
                provider.segment(
                    { ...value, binding: { ...value.binding, captureId: '' } },
                    new AbortController().signal,
                ),
            ),
        ).toEqual([{ type: 'unavailable', code: 'invalid_output' }])
        expect(calls).toBe(0)
    })

    it.each([
        [
            'empty',
            event({ type: 'response.output_text.done', ...lane, text: '' }) + event({ type: 'response.completed' }),
            'completed',
        ],
        ['incomplete', completed(grammar, 'response.incomplete'), 'unavailable'],
        ['malformed', completed('<0f>bad\n'), 'unavailable'],
        ['partial grammar', completed(grammar.slice(0, -10)), 'unavailable'],
    ])('handles %s lane with one terminal', async (_name, wire, terminal): Promise<void> => {
        const transport = await local((response): void => {
            response.end(wire)
        })
        const result = await collect(
            createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl }).segment(
                await input(),
                new AbortController().signal,
            ),
        )
        expect(result.at(-1)?.type).toBe(terminal)
        expect(result.filter((entry) => entry.type !== 'snapshot')).toHaveLength(1)
        expect(transport.dispatches()).toBe(1)
    })

    it('maps a provider failure to a sanitized unavailable terminal', async (): Promise<void> => {
        const transport = await local((response): void => {
            response.end(
                event({ type: 'response.failed', response: { error: { message: 'private provider detail' } } }),
            )
        })
        const result = await collect(
            createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl }).segment(
                await input(),
                new AbortController().signal,
            ),
        )
        expect(result).toEqual([{ type: 'unavailable', code: 'provider_error' }])
    })

    it('sends normalized inline video and preserves sparse out-of-order source frame IDs', async (): Promise<void> => {
        const generated = spawnSync(
            '/opt/homebrew/bin/ffmpeg',
            [
                '-nostdin',
                '-v',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=c=red:s=32x24:r=4:d=1',
                '-an',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                '-movflags',
                'frag_keyframe+empty_moov',
                '-f',
                'mp4',
                'pipe:1',
            ],
            { timeout: 5_000, maxBuffer: 1_048_576 },
        )
        expect(generated.status).toBe(0)
        const text = [3, 1]
            .map((frame) => `<${frame}f>7<|box;x1=0;y1=0;x2=4;y2=4;w=32;h=24|><|mask;x=0;y=0;data=5,5,${mask}|>\n`)
            .join('')
        const bodySchema = z.object({
            input: z.array(
                z.object({
                    content: z.array(
                        z.object({
                            type: z.string(),
                            video_url: z.string().optional(),
                        }),
                    ),
                }),
            ),
        })
        let properVideo = false
        const transport = await local(
            (response): void => {
                response.end(completed(text))
            },
            (value): void => {
                const parsed = bodySchema.parse(value)
                const media = parsed.input[0]?.content[1]
                properVideo =
                    media?.type === 'input_video' && media.video_url?.startsWith('data:video/mp4;base64,') === true
            },
        )
        const value = await input()
        value.media = { kind: 'clip', bytes: new Uint8Array(generated.stdout), mimeType: 'video/mp4' }
        const result = await collect(
            createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl }).segment(
                value,
                new AbortController().signal,
            ),
        )
        expect(properVideo).toBe(true)
        expect(result.flatMap((entry) => (entry.type === 'snapshot' ? [entry.snapshot.frameIndex] : []))).toEqual([
            3, 1,
        ])
        expect(result.at(-1)?.type).toBe('completed')
    })

    it('owns submitted bytes and binding before asynchronous media work', async (): Promise<void> => {
        const transport = await local((response): void => {
            response.end(completed())
        })
        const value = await input()
        const source = createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl }).segment(
            value,
            new AbortController().signal,
        )
        value.binding.captureId = 'mutated'
        if (value.media.kind === 'image') {
            value.media.image.bytes.fill(0)
        }
        const result = await collect(source)
        const first = result[0]
        expect(first?.type === 'snapshot' ? first.snapshot.binding.captureId : null).toBe('capture-1')
        expect(result.at(-1)?.type).toBe('completed')
    })

    it('aborts a stalled real response once and never completes late', async (): Promise<void> => {
        const parent = new AbortController()
        const transport = await local((response): void => {
            response.write(': keepalive\n\n')
            parent.abort()
        })
        const result = await collect(
            createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl }).segment(
                await input(),
                parent.signal,
            ),
        )
        expect(result).toEqual([{ type: 'unavailable', code: 'provider_error' }])
        expect(transport.dispatches()).toBe(1)
    })

    it('cancels the real body when consumer stops after a partial snapshot', async (): Promise<void> => {
        let closed: (() => void) | undefined
        const closedPromise = new Promise<void>((resolve): void => {
            closed = resolve
        })
        const transport = await local((response): void => {
            response.on('close', (): void => {
                closed?.()
            })
            response.write(event({ type: 'response.output_text.delta', ...lane, delta: grammar }))
        })
        const source = createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl }).segment(
            await input(),
            new AbortController().signal,
        )
        for await (const snapshot of source) {
            expect(snapshot.type).toBe('snapshot')
            break
        }
        await closedPromise
        expect(transport.dispatches()).toBe(1)
    })

    it('owns and cancels a real body that arrives after an ignored abort', async (): Promise<void> => {
        const parent = new AbortController()
        let closed: (() => void) | undefined
        const closedPromise = new Promise<void>((resolve): void => {
            closed = resolve
        })
        const transport = await local((response): void => {
            response.on('close', (): void => {
                closed?.()
            })
            response.write(': keepalive\n\n')
        })
        const fetchImpl: typeof fetch = async (url, options): Promise<Response> => {
            const response = await transport.fetchImpl(url, { ...options, signal: undefined })
            parent.abort()
            return response
        }
        const result = await collect(
            createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl }).segment(await input(), parent.signal),
        )
        expect(result).toEqual([{ type: 'unavailable', code: 'provider_error' }])
        await closedPromise
        expect(transport.dispatches()).toBe(1)
    })

    it('enforces monotonic deadline before publishing success even if timer has not run', async (): Promise<void> => {
        let monotonic = 0
        vi.spyOn(performance, 'now').mockImplementation((): number => monotonic)
        const transport = await local((response): void => {
            monotonic = 30_001
            response.end(completed())
        })
        const result = await collect(
            createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl }).segment(
                await input(),
                new AbortController().signal,
            ),
        )
        expect(result).toEqual([{ type: 'unavailable', code: 'timeout' }])
        expect(transport.dispatches()).toBe(1)
    })
})

describe('SAM stage identity comes from the provider response', (): void => {
    const progress = (response: unknown, type = 'response.created'): string => event({ type, response })
    const body = (opening: string, terminal: unknown = {}): string =>
        opening +
        event({ type: 'response.output_text.delta', ...lane, delta: grammar }) +
        event({ type: 'response.output_text.done', ...lane, text: grammar }) +
        event({ type: 'response.completed', response: terminal })

    async function run(wire: string): Promise<SegmentEvent[]> {
        const transport = await local((response): void => {
            response.end(wire)
        })
        return collect(
            createSamProvider({ apiKey: 'synthetic-test-token', fetchImpl: transport.fetchImpl }).segment(
                await input(),
                new AbortController().signal,
            ),
        )
    }

    it('stamps the stage once ResponseCreated reported the requested model', async (): Promise<void> => {
        const events = await run(body(progress({ model: 'sam-3.1', status: 'in_progress' }), { model: 'sam-3.1' }))
        expect(events.map((entry) => entry.type)).toEqual(['snapshot', 'completed'])
        const first = events[0]
        if (first?.type !== 'snapshot') throw new Error('missing_snapshot')
        expect(first.snapshot.stage).toEqual({ model: 'sam-3.1', elapsedMs: expect.any(Number) })
        // The real parser and mask path are unchanged by identity handling.
        expect(first.snapshot.records[0]?.mask).toMatchObject({ width: 5, height: 5 })
    })

    it('omits the stage rather than fabricating one when the response never names a model', async (): Promise<void> => {
        const events = await run(body(progress({ status: 'in_progress' })))
        expect(events.map((entry) => entry.type)).toEqual(['snapshot', 'completed'])
        const first = events[0]
        if (first?.type !== 'snapshot') throw new Error('missing_snapshot')
        expect(first.snapshot).not.toHaveProperty('stage')
        expect(first.snapshot.records).toHaveLength(1)
    })

    it('does not retroactively credit a snapshot published before any identity was observed', async (): Promise<void> => {
        const events = await run(body('', { model: 'sam-3.1' }))
        expect(events.map((entry) => entry.type)).toEqual(['snapshot', 'completed'])
        const first = events[0]
        if (first?.type !== 'snapshot') throw new Error('missing_snapshot')
        expect(first.snapshot).not.toHaveProperty('stage')
    })

    it.each(['muse-spark-1.3', 'sam-3.0', 'sam-3.1-preview', '', null, 7])(
        'stops with invalid output and publishes nothing when ResponseCreated reports %j',
        async (model): Promise<void> => {
            expect(await run(body(progress({ model }), { model: 'sam-3.1' }))).toEqual([
                { type: 'unavailable', code: 'invalid_output' },
            ])
        },
    )

    it.each(['muse-spark-1.3', 'sam-3.0', null, 7])(
        'stops with invalid output and never completes when the completed response reports %j',
        async (model): Promise<void> => {
            const events = await run(body(progress({ model: 'sam-3.1' }), { model }))
            expect(events.at(-1)).toEqual({ type: 'unavailable', code: 'invalid_output' })
            expect(events.map((entry) => entry.type)).not.toContain('completed')
        },
    )

    it('rejects a mismatched in-progress identity after a matching created one', async (): Promise<void> => {
        const events = await run(
            body(progress({ model: 'sam-3.1' }) + progress({ model: 'muse-wonder-1.0' }, 'response.in_progress')),
        )
        expect(events).toEqual([{ type: 'unavailable', code: 'invalid_output' }])
    })
})
