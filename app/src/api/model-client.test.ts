import {
    createDemoManual,
    LIMITS,
    type ApiResult,
    type CaptureBinding,
    type ManualSession,
    type SegmentEvent,
} from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createCallGuard } from './transport'
import {
    MODEL_CHECK_TIMEOUT_MS,
    MODEL_PARSE_TIMEOUT_MS,
    MODEL_SEGMENT_TIMEOUT_MS,
    MODEL_METADATA_MAX_BYTES,
    ModelApiClient,
    type ImageBytes,
    type ModelFetch,
} from './model-client'

const BASE_URL = 'http://127.0.0.1:3001'
const SECRET = 'public-demo-key-for-tests'
const REQUEST_ID = 'req-model-1'
const session: ManualSession = createDemoManual()
const captureBinding: CaptureBinding = {
    kind: 'capture',
    manualId: session.manualId,
    revision: session.revision,
    stepId: 'step-1',
    captureId: 'capture-1',
}
const sourcePageIds = ['demo-page-1']
const observation: ImageBytes = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', width: 4, height: 3 }
const source: ImageBytes = {
    bytes: new Uint8Array([4, 5, 6]),
    mimeType: 'image/jpeg',
    width: session.pages[0]?.width ?? 1,
    height: session.pages[0]?.height ?? 1,
}

interface Recorded {
    readonly url: string
    readonly init: RequestInit
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Scripted fetch that records every dispatch and answers with one canned response. */
function scripted(response: () => Response): { fetch: ModelFetch; calls: Recorded[] } {
    const calls: Recorded[] = []
    const fetch: ModelFetch = (url: string, init: RequestInit): Promise<Response> => {
        calls.push({ url, init })
        return Promise.resolve(response())
    }
    return { fetch, calls }
}

function client(fetch: ModelFetch): ModelApiClient {
    return new ModelApiClient({ baseUrl: BASE_URL, secret: SECRET, fetch })
}

function okCheck(overrides: Record<string, unknown> = {}): unknown {
    return {
        status: 'ok',
        requestId: REQUEST_ID,
        mode: 'model',
        binding: captureBinding,
        value: {
            decision: 'pass',
            reason: 'The groove faces inward.',
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            observedRegion: null,
            missingEvidence: [],
        },
        ...overrides,
    }
}

function sse(events: readonly unknown[]): Response {
    const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

/** A finite body by default (its end is truncation when no terminal arrived). `open` keeps it pending after the chunks. */
function streamOf(chunks: readonly string[], options: { open?: boolean; onCancel?: () => void } = {}): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
        start(controller): void {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk))
            }
            if (options.open !== true) {
                controller.close()
            }
        },
        cancel(): void {
            options.onCancel?.()
        },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function snapshotEvent(binding: CaptureBinding = captureBinding): unknown {
    return {
        status: 'ok',
        requestId: REQUEST_ID,
        mode: 'model',
        binding,
        value: {
            type: 'snapshot',
            snapshot: {
                binding,
                streamId: 'stream-1',
                frameIndex: 0,
                capturedAt: '2026-10-26T10:00:00.000Z',
                records: [{ objectId: 'object-1', label: 'Divider', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
                complete: false,
            },
        },
    }
}

function completedEvent(): unknown {
    return { status: 'ok', requestId: REQUEST_ID, mode: 'model', binding: captureBinding, value: { type: 'completed' } }
}

describe('trusted outer action checkpoint', () => {
    it('dispatches nothing when actual multipart JSON construction crosses the outer deadline before timers run', async () => {
        let now = 100
        vi.spyOn(performance, 'now').mockImplementation((): number => now)
        const stringify = JSON.stringify
        vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown): string => {
            const text = stringify(value)

            if (typeof value === 'object' && value !== null && 'sourcePageIds' in value) {
                now += 8001
            }

            return text
        })
        const outer = createCallGuard(MODEL_CHECK_TIMEOUT_MS, undefined)
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck()))

        try {
            const ctx = { requestId: REQUEST_ID, signal: outer.signal, checkpoint: outer.checkpoint }
            const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], observation, ctx)

            expect(result).toMatchObject({ status: 'unavailable', code: 'timeout' })
            expect(calls).toHaveLength(0)
        } finally {
            outer.dispose()
            vi.restoreAllMocks()
        }
    })
})

async function collect(
    stream: AsyncGenerator<ApiResult<SegmentEvent>, void, void>,
): Promise<ApiResult<SegmentEvent>[]> {
    const out: ApiResult<SegmentEvent>[] = []
    for await (const item of stream) {
        out.push(item)
    }
    return out
}

function segmentStream(response: Response): ModelApiClient {
    return new ModelApiClient({
        baseUrl: BASE_URL,
        secret: SECRET,
        fetch: () => Promise.resolve(jsonResponse(500, { status: 'unavailable' })),
        streamFetch: () => Promise.resolve(response),
    })
}

const segmentMetadata = {
    requestId: REQUEST_ID,
    binding: captureBinding,
    prompt: 'divider',
    capturedAt: '2026-10-26T10:00:00.000Z',
    image: observation,
}

describe('ModelApiClient construction', () => {
    it('refuses a non-loopback http origin, a path, or a credentialed origin before any I/O', () => {
        expect(() => new ModelApiClient({ baseUrl: 'http://example.com', secret: SECRET })).toThrow()
        expect(() => new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001/api', secret: SECRET })).toThrow()
        expect(() => new ModelApiClient({ baseUrl: 'https://user:pass@example.com', secret: SECRET })).toThrow()
    })

    it('accepts https and LAN http origins for development', () => {
        expect(() => new ModelApiClient({ baseUrl: 'https://api.example.com', secret: SECRET })).not.toThrow()
        expect(() => new ModelApiClient({ baseUrl: 'http://192.168.1.20:3001', secret: SECRET })).not.toThrow()
    })
})

describe('ModelApiClient request validation (zero dispatch when invalid)', () => {
    it('sends nothing when the reviewed step cites a page that is not selected', async () => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck()))

        const result = await client(fetch).check(
            captureBinding,
            session,
            ['not-a-selected-page'],
            [source],
            observation,
            { requestId: REQUEST_ID },
        )

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(calls).toHaveLength(0)
    })

    it('sends nothing when the metadata JSON exceeds the 64KiB frozen limit', async () => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck()))
        const oversized: ManualSession = {
            ...session,
            title: 'x'.repeat(MODEL_METADATA_MAX_BYTES),
        }

        const result = await client(fetch).check(captureBinding, oversized, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(calls).toHaveLength(0)
    })

    it('sends nothing when an image exceeds the per-file byte limit', async () => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck()))
        const huge: ImageBytes = { ...observation, bytes: new Uint8Array(LIMITS.imageBytes + 1) }

        const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], huge, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(calls).toHaveLength(0)
    })
})

describe('ModelApiClient multipart dispatch', () => {
    it('sends one metadata field, fixed source and observation file names, and the shared key only in the x-truebuild-key header', async () => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck()))

        const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'ok', mode: 'model' })
        const call = calls[0]
        expect(call?.url).toBe(`${BASE_URL}/api/checks`)
        const form = call?.init.body
        expect(form).toBeInstanceOf(FormData)
        const names: string[] = []
        ;(form as FormData).forEach((_value, key) => names.push(key))
        expect(names.sort()).toEqual(['metadata', 'observation', 'source-0'])
        expect(typeof (form as FormData).get('metadata')).toBe('string')
        expect(JSON.stringify(call?.init.body ?? '')).not.toContain(SECRET)
        expect(call?.url).not.toContain(SECRET)
        expect(call?.init.headers).toMatchObject({ 'x-truebuild-key': SECRET })
        expect(call?.init.redirect).toBe('error')
    })

    it('uses the 8s check deadline, not the 30s parse deadline', async () => {
        vi.useFakeTimers()
        try {
            const pending = new Promise<Response>(() => undefined)
            const hanging = client(() => pending)
            const outcome = hanging.check(captureBinding, session, sourcePageIds, [source], observation, {
                requestId: REQUEST_ID,
            })

            await vi.advanceTimersByTimeAsync(MODEL_CHECK_TIMEOUT_MS - 1)
            let settled = false
            void outcome.then(() => (settled = true))
            await Promise.resolve()
            expect(settled).toBe(false)

            await vi.advanceTimersByTimeAsync(2)
            expect(await outcome).toMatchObject({ status: 'unavailable', code: 'timeout', retryable: true })
            expect(MODEL_PARSE_TIMEOUT_MS).toBeGreaterThan(MODEL_CHECK_TIMEOUT_MS)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('ModelApiClient response discipline', () => {
    it('rejects a fixture-mode envelope even when the requestId and binding echo', async () => {
        const { fetch } = scripted(() => jsonResponse(200, okCheck({ mode: 'fixture' })))

        const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_output', retryable: false })
    })

    it('rejects a binding that does not match the requested capture', async () => {
        const other = { ...captureBinding, captureId: 'capture-2' }
        const { fetch } = scripted(() => jsonResponse(200, okCheck({ binding: other })))

        const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
    })

    it('rejects a verdict that cites a page outside the selected source set', async () => {
        const cited = okCheck({
            value: {
                decision: 'pass',
                reason: 'Cites another page.',
                sourceRefs: [{ pageId: 'other-page', region: null }],
                observedRegion: null,
                missingEvidence: [],
            },
        })
        const { fetch } = scripted(() => jsonResponse(200, cited))

        const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
    })

    it('does not publish a success body on a 5xx status and maps it to a retryable provider error', async () => {
        const { fetch } = scripted(() => jsonResponse(502, okCheck()))

        const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'provider_error', retryable: true })
    })
})

describe('ModelApiClient segment stream', () => {
    const segmentArgs = (): [CaptureBinding, string, string, ImageBytes, { requestId: string }] => [
        captureBinding,
        segmentMetadata.prompt,
        segmentMetadata.capturedAt,
        observation,
        { requestId: REQUEST_ID },
    ]

    it('yields a snapshot then exactly one completed terminal, in order', async () => {
        const client = segmentStream(sse([snapshotEvent(), completedEvent()]))

        const events = await collect(client.segments(...segmentArgs()))

        expect(events.map((item) => (item.status === 'ok' ? item.value.type : item.code))).toEqual([
            'snapshot',
            'completed',
        ])
    })

    it('never fabricates completed when the stream ends after a snapshot without a terminal', async () => {
        const client = segmentStream(streamOf([`data: ${JSON.stringify(snapshotEvent())}\n\n`]))

        const events = await collect(client.segments(...segmentArgs()))

        expect(events.at(-1)).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
        expect(events.some((item) => item.status === 'ok' && item.value.type === 'completed')).toBe(false)
    })

    it('rejects a second terminal after completion and stops at the first invalid one', async () => {
        const client = segmentStream(sse([completedEvent(), completedEvent()]))

        const events = await collect(client.segments(...segmentArgs()))

        // The first terminal is held, so the invalid second one leaves no published success behind.
        expect(events).toEqual([expect.objectContaining({ status: 'unavailable', code: 'invalid_output' })])
    })

    it('rejects a snapshot for a different capture binding', async () => {
        const other: CaptureBinding = { ...captureBinding, captureId: 'capture-9' }
        const client = segmentStream(sse([snapshotEvent(other)]))

        const events = await collect(client.segments(...segmentArgs()))

        expect(events).toEqual([expect.objectContaining({ status: 'unavailable', code: 'invalid_output' })])
    })

    it('rejects a non-data SSE field instead of parsing it as an event', async () => {
        const client = segmentStream(streamOf([`event: custom\ndata: ${JSON.stringify(completedEvent())}\n\n`]))

        const events = await collect(client.segments(...segmentArgs()))

        expect(events).toEqual([expect.objectContaining({ status: 'unavailable', code: 'invalid_output' })])
    })

    it('passes through a non-2xx unavailable envelope as the only terminal value', async () => {
        const envelope = {
            status: 'unavailable',
            requestId: REQUEST_ID,
            binding: captureBinding,
            code: 'budget_exhausted',
            retryable: false,
        }
        const client = segmentStream(jsonResponse(429, envelope))

        const events = await collect(client.segments(...segmentArgs()))

        expect(events).toEqual([expect.objectContaining({ status: 'unavailable', code: 'budget_exhausted' })])
    })

    it('ends with invalid_input when the caller aborts while the stream is still open', async () => {
        const controller = new AbortController()
        const client = segmentStream(streamOf([`data: ${JSON.stringify(snapshotEvent())}\n\n`], { open: true }))

        const seen: ApiResult<SegmentEvent>[] = []
        const iterator = client.segments(
            captureBinding,
            segmentMetadata.prompt,
            segmentMetadata.capturedAt,
            observation,
            {
                requestId: REQUEST_ID,
                signal: controller.signal,
            },
        )
        seen.push((await iterator.next()).value as ApiResult<SegmentEvent>)
        controller.abort()
        seen.push((await iterator.next()).value as ApiResult<SegmentEvent>)

        expect(seen[0]).toMatchObject({ status: 'ok' })
        expect(seen[1]).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
    })

    it('cancels the response body when the consumer stops early', async () => {
        const cancelled = vi.fn()
        const client = segmentStream(
            streamOf(
                [`data: ${JSON.stringify(snapshotEvent())}\n\n`, `data: ${JSON.stringify(completedEvent())}\n\n`],
                { open: true, onCancel: cancelled },
            ),
        )

        for await (const _item of client.segments(...segmentArgs())) {
            break
        }

        expect(cancelled).toHaveBeenCalled()
    })
})

describe('pre-body refusals (no request body read by the backend)', () => {
    // The backend answers before reading the body, so its envelope carries a placeholder identity and null binding.
    const placeholder = (code: string, retryable: boolean): unknown => ({
        status: 'unavailable',
        requestId: 'invalid-request',
        binding: null,
        code,
        retryable,
    })

    it.each([
        [401, 'unauthorized', false],
        [403, 'unauthorized', false],
        [503, 'unconfigured', false],
        [400, 'invalid_input', false],
        [413, 'invalid_input', false],
        [415, 'invalid_input', false],
        [409, 'duplicate_request', false],
        [429, 'budget_exhausted', false],
        [504, 'timeout', true],
    ])(
        'classifies HTTP %i by status as %s when the placeholder envelope does not echo',
        async (status, code, retryable) => {
            const { fetch } = scripted(() => jsonResponse(status, placeholder(code, retryable)))

            const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], observation, {
                requestId: REQUEST_ID,
            })

            expect(result).toMatchObject({ status: 'unavailable', requestId: REQUEST_ID, code, retryable })
        },
    )

    it('never publishes a 200 whose envelope carries the placeholder identity', async () => {
        const { fetch } = scripted(() => jsonResponse(200, placeholder('unauthorized', false)))

        const result = await client(fetch).check(captureBinding, session, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
    })
})

describe('segment terminal publication', () => {
    it('cancels the owned body on caller abort while the consumer is paused after a snapshot', async () => {
        const caller = new AbortController()
        let cancelled = false
        const client = segmentStream(
            streamOf([`data: ${JSON.stringify(snapshotEvent())}\n\n`], {
                open: true,
                onCancel: (): void => {
                    cancelled = true
                },
            }),
        )
        const iterator = client.segments(captureBinding, 'side panel', '2026-10-26T10:00:00.000Z', observation, {
            requestId: REQUEST_ID,
            signal: caller.signal,
        })

        try {
            expect((await iterator.next()).value).toMatchObject({ status: 'ok', value: { type: 'snapshot' } })
            caller.abort()
            await Promise.resolve()

            expect(cancelled).toBe(true)
            expect((await iterator.next()).value).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
            expect((await iterator.next()).done).toBe(true)
        } finally {
            await iterator.return(undefined)
        }
    })

    it('refuses a held completion followed by an incomplete UTF-8 character at EOF', async () => {
        const text = new TextEncoder().encode(`data: ${JSON.stringify(completedEvent())}\n\n`)
        const client = segmentStream(
            new Response(new Uint8Array([...text, 0xc3]), { headers: { 'content-type': 'text/event-stream' } }),
        )
        const events = await collect(
            client.segments(captureBinding, segmentMetadata.prompt, segmentMetadata.capturedAt, observation, {
                requestId: REQUEST_ID,
            }),
        )

        expect(events).toEqual([expect.objectContaining({ status: 'unavailable', code: 'invalid_output' })])
    })

    const segmentArgs = (): [CaptureBinding, string, string, ImageBytes, { requestId: string }] => [
        captureBinding,
        'side panel',
        '2026-10-26T10:00:00.000Z',
        observation,
        { requestId: REQUEST_ID },
    ]

    it('publishes completed only once the stream has ended cleanly', async () => {
        const client = segmentStream(sse([completedEvent()]))

        const events = await collect(client.segments(...segmentArgs()))

        expect(events).toEqual([expect.objectContaining({ status: 'ok', value: { type: 'completed' } })])
    })

    it('never publishes completed when malformed trailing data follows it', async () => {
        const client = segmentStream(streamOf([`data: ${JSON.stringify(completedEvent())}\n\nnot-a-field\n\n`]))

        const events = await collect(client.segments(...segmentArgs()))

        expect(events).toEqual([expect.objectContaining({ status: 'unavailable', code: 'invalid_output' })])
    })

    it('never publishes completed when a truncated partial block follows it', async () => {
        const client = segmentStream(streamOf([`data: ${JSON.stringify(completedEvent())}\n\ndata: {"status":`]))

        const events = await collect(client.segments(...segmentArgs()))

        expect(events).toEqual([expect.objectContaining({ status: 'unavailable', code: 'invalid_output' })])
    })

    it('stops a paused consumer at the deadline instead of publishing a buffered completed', async () => {
        vi.useFakeTimers()
        try {
            const client = segmentStream(
                streamOf([`data: ${JSON.stringify(snapshotEvent())}\n\ndata: ${JSON.stringify(completedEvent())}\n\n`]),
            )
            const iterator = client.segments(...segmentArgs())

            const first = await iterator.next()
            expect(first.value).toMatchObject({ status: 'ok', value: { type: 'snapshot' } })

            // The consumer pauses past the 30s segment deadline before asking for the next value.
            await vi.advanceTimersByTimeAsync(MODEL_SEGMENT_TIMEOUT_MS + 1000)
            const second = await iterator.next()

            expect(second.value).toMatchObject({ status: 'unavailable', code: 'timeout', retryable: true })
            expect(await iterator.next()).toMatchObject({ done: true })
        } finally {
            vi.useRealTimers()
        }
    })
})
