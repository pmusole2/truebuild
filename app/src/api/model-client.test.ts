import {
    createDemoManual,
    LIMITS,
    manualPieceInputSchema,
    pieceBatchRequestSchema,
    type ApiResult,
    type CaptureBinding,
    type ManualBinding,
    type ManualSession,
    type SegmentEvent,
} from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CHECK_OVERALL_TIMEOUT_MS } from '../../../api/src/server/ai-policy'
import { createCallGuard } from './transport'
import {
    MODEL_CHECK_TIMEOUT_MS,
    MODEL_SECOND_OPINION_TIMEOUT_MS,
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
const manualBinding: ManualBinding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
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

function okParse(): unknown {
    return { status: 'ok', requestId: REQUEST_ID, mode: 'model', binding: manualBinding, value: session.rawExtraction }
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

describe('separate second opinion transport', () => {
    const token = 'second-opinion-test-ticket'
    const value = {
        decision: 'cannot_verify',
        reason: 'Orientation remains unclear.',
        sourceRefs: [],
        observedRegion: null,
        missingEvidence: ['Show the groove.'],
        model: 'muse-spark-1.3',
        modelNotes: ['Second opinion did not resolve the missing evidence.'],
        secondOpinion: { model: 'muse-wonder-1.0', status: 'completed' },
    }
    const invoke = (api: ModelApiClient, signal?: AbortSignal): Promise<ApiResult<unknown>> =>
        api.secondOpinion(captureBinding, session, sourcePageIds, [source], observation, token, {
            requestId: REQUEST_ID,
            signal,
        })

    it('sends the shared multipart context and ticket once and preserves server provenance', async () => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck({ value })))
        expect(await invoke(client(fetch))).toMatchObject({ status: 'ok', value })
        expect(calls).toHaveLength(1)
        expect(calls[0]!.url).toBe(`${BASE_URL}/api/checks/second-opinion`)
        const body = calls[0]!.init.body as FormData
        expect(JSON.parse(String(body.get('metadata')))).toMatchObject({
            mode: 'model',
            requestId: REQUEST_ID,
            binding: captureBinding,
            session,
            sourcePageIds,
            secondOpinionToken: token,
        })
        expect(new Uint8Array(await (body.get('source-0') as Blob).arrayBuffer())).toEqual(source.bytes)
        expect(new Uint8Array(await (body.get('observation') as Blob).arrayBuffer())).toEqual(observation.bytes)
    })

    it('has its own 60 second budget and accepts a reply after the primary eight seconds', async () => {
        vi.useFakeTimers()
        let deliver: ((response: Response) => void) | undefined
        const fetch = vi.fn(
            (): Promise<Response> =>
                new Promise((resolve) => {
                    deliver = resolve
                }),
        )
        try {
            const pending = invoke(client(fetch))
            await vi.advanceTimersByTimeAsync(30_000)
            expect(fetch).toHaveBeenCalledTimes(1)
            deliver?.(jsonResponse(200, okCheck({ value })))
            expect(await pending).toMatchObject({ status: 'ok', value })
            expect(MODEL_SECOND_OPINION_TIMEOUT_MS).toBe(60_000)
        } finally {
            vi.useRealTimers()
        }
    })

    it('times out a hung second opinion once without retry', async () => {
        vi.useFakeTimers()
        const fetch = vi.fn((): Promise<Response> => new Promise(() => undefined))
        try {
            const pending = invoke(client(fetch))
            await vi.advanceTimersByTimeAsync(60_001)
            expect(await pending).toMatchObject({ status: 'unavailable', code: 'timeout' })
            expect(fetch).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not dispatch an empty ticket or an already cancelled operation', async () => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck({ value })))
        const api = client(fetch)
        expect(
            await api.secondOpinion(captureBinding, session, sourcePageIds, [source], observation, '', {
                requestId: REQUEST_ID,
            }),
        ).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        const abort = new AbortController()
        abort.abort()
        expect(await invoke(api, abort.signal)).toMatchObject({ status: 'unavailable' })
        expect(calls).toHaveLength(0)
    })

    it.each([
        { binding: { ...captureBinding, captureId: 'different-capture' } },
        { requestId: 'different-request' },
        { mode: 'fixture' },
        { value: { ...value, sourceRefs: [{ pageId: 'unrequested-page', region: null }] } },
    ])('rejects a reply with mismatched request context %j', async (overrides) => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck({ value, ...overrides })))
        expect(await invoke(client(fetch))).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
        expect(calls).toHaveLength(1)
    })
})

describe('trusted outer action checkpoint', () => {
    it('dispatches nothing when actual multipart JSON construction crosses the outer deadline before timers run', async () => {
        let now = 100
        vi.spyOn(performance, 'now').mockImplementation((): number => now)
        const stringify = JSON.stringify
        vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown): string => {
            const text = stringify(value)

            if (typeof value === 'object' && value !== null && 'sourcePageIds' in value) {
                now += MODEL_CHECK_TIMEOUT_MS + 1
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
    const noRequest: ModelFetch = (): Promise<Response> => Promise.reject(new Error('Construction sends no request.'))
    const construct = (baseUrl: string): ModelApiClient =>
        new ModelApiClient({ baseUrl, secret: SECRET, fetch: noRequest })

    it('refuses a non-loopback http origin, a path, or a credentialed origin before any I/O', () => {
        expect(() => construct('http://example.com')).toThrow()
        expect(() => construct('http://127.0.0.1:3001/api')).toThrow()
        expect(() => construct('https://user:pass@example.com')).toThrow()
    })

    it('accepts https and LAN http origins for development', () => {
        expect(() => construct('https://api.example.com')).not.toThrow()
        expect(() => construct('http://192.168.1.20:3001')).not.toThrow()
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

    it('sends nothing when the metadata JSON exceeds the 1MiB app/server limit', async () => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck()))
        const first = session.reviewedSteps[0]!
        const oversized: ManualSession = {
            ...session,
            reviewedSteps: Array.from({ length: 200 }, (_, index) => ({
                ...first,
                stepId: index === 0 ? first.stepId : `large-step-${index}`,
                order: index + 1,
                visibleChecks: Array.from({ length: 10 }, (_, check) => ({
                    checkId: `check-${check}`,
                    description: { state: 'known' as const, value: 'x'.repeat(500), sourceRefs: first.sourceRefs },
                })),
            })),
        }
        expect(new TextEncoder().encode(JSON.stringify(oversized)).length).toBeGreaterThan(MODEL_METADATA_MAX_BYTES)

        const result = await client(fetch).check(captureBinding, oversized, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(calls).toHaveLength(0)
    })

    it('accepts schema-valid metadata larger than the old 64KiB cap and below 512KiB', async () => {
        const { fetch, calls } = scripted(() => jsonResponse(200, okCheck()))
        const large: ManualSession = {
            ...session,
            parts: [
                ...session.parts,
                ...Array.from({ length: 250 }, (_, index) => ({
                    partId: `extra-part-${index}`,
                    name: {
                        state: 'known' as const,
                        value: 'x'.repeat(200),
                        sourceRefs: [{ pageId: sourcePageIds[0]!, region: null }],
                    },
                })),
            ],
        }
        const size = new TextEncoder().encode(JSON.stringify(large)).length
        expect(size).toBeGreaterThan(65_536)
        expect(size).toBeLessThan(MODEL_METADATA_MAX_BYTES)
        const result = await client(fetch).check(captureBinding, large, sourcePageIds, [source], observation, {
            requestId: REQUEST_ID,
        })
        expect(result.status).toBe('ok')
        expect(calls).toHaveLength(1)
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

    it('outlasts the server overall check budget by at least a five-second return margin', () => {
        expect(MODEL_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(CHECK_OVERALL_TIMEOUT_MS + 5_000)
    })

    it('uses the check deadline, not the parse deadline', async () => {
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
            expect(MODEL_PARSE_TIMEOUT_MS).toBe(355_000)
            expect(MODEL_PARSE_TIMEOUT_MS).toBeGreaterThan(MODEL_CHECK_TIMEOUT_MS)
            // The streamed parse route allows 350s; the client outlasts it so the server reports its timeout.
            expect(MODEL_PARSE_TIMEOUT_MS).toBeGreaterThan(350_000)
        } finally {
            vi.useRealTimers()
        }
    })

    it('accepts a parse reply delivered at 350 seconds', async () => {
        vi.useFakeTimers()
        let deliver: ((response: Response) => void) | undefined
        const fetch = vi.fn(
            (): Promise<Response> =>
                new Promise((resolve) => {
                    deliver = resolve
                }),
        )
        try {
            const pending = client(fetch).parse(manualBinding, session.pages, [source], { requestId: REQUEST_ID })
            await vi.advanceTimersByTimeAsync(350_000)
            expect(fetch).toHaveBeenCalledTimes(1)
            deliver?.(jsonResponse(200, okParse()))
            expect(await pending).toMatchObject({ status: 'ok', mode: 'model', requestId: REQUEST_ID })
        } finally {
            vi.useRealTimers()
        }
    })

    it('times out a hung parse at 355 seconds once without retry', async () => {
        vi.useFakeTimers()
        const fetch = vi.fn((): Promise<Response> => new Promise(() => undefined))
        try {
            const pending = client(fetch).parse(manualBinding, session.pages, [source], { requestId: REQUEST_ID })
            await vi.advanceTimersByTimeAsync(354_999)
            let settled = false
            void pending.then(() => (settled = true))
            await Promise.resolve()
            expect(settled).toBe(false)

            await vi.advanceTimersByTimeAsync(2)
            expect(await pending).toMatchObject({ status: 'unavailable', code: 'timeout', retryable: true })
            expect(fetch).toHaveBeenCalledTimes(1)
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

    it('ignores keepalive comments between parse progress and segment events', async () => {
        const phases: string[] = []
        const parse = scripted(() =>
            streamOf([
                'data: {"type":"progress","phase":"reading"}\n\n',
                ': ping\n\n',
                `data: ${JSON.stringify({ type: 'result', result: okParse() })}\n\n`,
            ]),
        )
        expect(
            await client(parse.fetch).parse(manualBinding, session.pages, [source], {
                requestId: REQUEST_ID,
                onProgress: (phase) => phases.push(phase),
            }),
        ).toMatchObject({ status: 'ok' })
        expect(phases).toEqual(['reading'])

        const api = segmentStream(
            streamOf([
                `data: ${JSON.stringify(snapshotEvent())}\n\n`,
                ': ping\n\n',
                `data: ${JSON.stringify(completedEvent())}\n\n`,
            ]),
        )
        expect((await collect(api.segments(...segmentArgs()))).map((event) => event.status)).toEqual(['ok', 'ok'])
    })

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

it('validates and serializes parse language, defaults English, and rejects large parse batches without dispatch', async () => {
    const run = scripted(() => jsonResponse(200, okParse()))
    const api = client(run.fetch)
    await api.parse(manualBinding, session.pages, [source], { requestId: REQUEST_ID })
    expect(new URL(run.calls[0]!.url).searchParams.get('stepKinds')).toBe('remove')
    expect(new URL(run.calls[0]!.url).searchParams.get('stepFields')).toBe('actions,sourceText')
    expect(JSON.parse(String((run.calls[0]!.init.body as FormData).get('metadata'))).language).toBe('en')
    await api.parse(manualBinding, session.pages, [source], { requestId: REQUEST_ID, language: 'fr' })
    expect(JSON.parse(String((run.calls[1]!.init.body as FormData).get('metadata'))).language).toBe('fr')
    const invalid = await api.parse(manualBinding, session.pages, [source], {
        requestId: REQUEST_ID,
        language: 'free text',
    })
    expect(invalid.status).toBe('unavailable')
    const pages = Array.from({ length: 13 }, (_, index) => ({
        ...session.pages[0]!,
        pageId: `page-${index}`,
        assetId: `asset-${index}`,
    }))
    const large = await api.parse(
        manualBinding,
        pages,
        pages.map(() => source),
        { requestId: REQUEST_ID },
    )
    expect(large).toMatchObject({ status: 'unavailable', message: expect.stringContaining('12 pages') })
    expect(run.calls).toHaveLength(2)
})

describe('piece figure capability negotiation', () => {
    // The deployed pre-figureBox API uses this same strict schema without the optional field.
    const oldRequest = pieceBatchRequestSchema.safeExtend({
        parts: z
            .array(manualPieceInputSchema.omit({ figureBox: true }))
            .min(1)
            .max(8),
    })
    const request = {
        requestId: 'piece-compat',
        contentHash: 'a'.repeat(64),
        parts: [
            {
                id: 'divider',
                name: 'Divider',
                quantity: 1,
                label: null,
                dimensions: null,
                pageId: 'page-1',
                figureBox: [0, 0, 1, 1] as [number, number, number, number],
            },
        ],
        pages: [{ pageId: 'page-1', width: 1, height: 1, mimeType: 'image/png' as const }],
    }
    const result = {
        contentHash: request.contentHash,
        results: [
            {
                id: 'divider',
                name: 'Divider',
                status: 'invalid',
                piece: null,
                cutoutUri: null,
                issueCodes: ['piece:missing_id'],
            },
        ],
        model: null,
        effort: null,
        durationMs: 1,
    }

    it.each([false, true])('sends figureBox only while the server advertises support (%s)', async (supported) => {
        expect(oldRequest.safeParse(request).success).toBe(false)
        const calls: Recorded[] = []
        const wireRequests: unknown[] = []
        let probes = 0
        let advertised = false
        const fetch: ModelFetch = async (url, init) => {
            calls.push({ url, init })
            if (new URL(url).pathname === '/api/session') {
                expect(init.method).toBe('GET')
                probes += 1
                advertised = supported && probes === 1
                return jsonResponse(200, {
                    status: 'ok',
                    ...(advertised ? { capabilities: { pieceFigureBox: true } } : {}),
                })
            }
            const metadata: unknown = JSON.parse(String((init.body as FormData).get('metadata')))
            wireRequests.push(metadata)
            return jsonResponse(200, result)
        }
        const api = client(fetch)
        for (let batch = 0; batch < 2; batch++) {
            expect(await api.pieceBatch(request, { 'page-1': 'data:image/png;base64,AQID' })).toEqual(result)
        }
        expect(wireRequests.map((metadata) => oldRequest.safeParse(metadata).success)).toEqual([!supported, true])
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
            '/api/session',
            '/api/pieces',
            '/api/session',
            '/api/pieces',
        ])
        expect(request.parts[0]!.figureBox).toEqual([0, 0, 1, 1])
    })

    it('uses the legacy strict request after a failed capability probe and never resends a rejected batch', async () => {
        const calls: Recorded[] = []
        let metadata: unknown
        const fetch: ModelFetch = async (url, init) => {
            calls.push({ url, init })
            if (new URL(url).pathname === '/api/session') throw new Error('session unavailable')
            metadata = JSON.parse(String((init.body as FormData).get('metadata'))) as unknown
            return jsonResponse(400, { status: 'unavailable', code: 'invalid_input' })
        }
        expect(await client(fetch).pieceBatch(request, { 'page-1': 'data:image/png;base64,AQID' })).toBeNull()
        expect(oldRequest.safeParse(metadata).success).toBe(true)
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/session', '/api/pieces'])
    })
})

it('preserves bounded server parse failure messages through non-success HTTP responses', async () => {
    const run = scripted(() =>
        jsonResponse(400, {
            status: 'unavailable',
            requestId: REQUEST_ID,
            binding: manualBinding,
            code: 'invalid_input',
            retryable: false,
            message: 'Split into 8 pages.',
        }),
    )
    expect(
        await client(run.fetch).parse(manualBinding, session.pages, [source], { requestId: REQUEST_ID }),
    ).toMatchObject({ status: 'unavailable', message: 'Split into 8 pages.' })
})

it.each([false, true])('drops optional actions with unresolved pages (valid action: %s)', async (hasGood) => {
    const value = structuredClone(session.rawExtraction!)
    const good = { actionId: 'good', instruction: 'Turn the panel.', sourceRefs: value.steps[0]!.sourceRefs }
    value.steps[0]!.actions = [
        { actionId: 'bad', instruction: 'Turn it.', sourceRefs: [{ pageId: 'missing', region: null }] },
        ...(hasGood ? [good] : []),
    ]
    const run = scripted(
        () =>
            new Response(
                JSON.stringify({ status: 'ok', requestId: REQUEST_ID, mode: 'model', binding: manualBinding, value }),
                { status: 200, headers: { 'content-type': 'application/json', 'x-truebuild-step-fields': 'actions' } },
            ),
    )
    const result = await client(run.fetch).parse(manualBinding, session.pages, [source], { requestId: REQUEST_ID })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected usable extraction')
    expect(result.value.steps[0]!.actions).toEqual(hasGood ? [good] : null)
})

it('rejects new parse citations outside supplied pages', async () => {
    const value = structuredClone(session.rawExtraction!)
    value.steps[0]!.alternatives = ['a', 'b'].map((alternativeId) => ({
        alternativeId,
        title: alternativeId,
        description: alternativeId,
        sourceRefs: [{ pageId: 'missing', region: null }],
    }))
    value.steps[0]!.selectedAlternativeId = 'a'
    const run = scripted(() =>
        jsonResponse(200, { status: 'ok', requestId: REQUEST_ID, mode: 'model', binding: manualBinding, value }),
    )
    expect(
        await client(run.fetch).parse(manualBinding, session.pages, [source], { requestId: REQUEST_ID }),
    ).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
})

it.each([false, true])('applies only echoed optional parse fields (SSE: %s)', async (stream) => {
    const value = structuredClone(session.rawExtraction!)
    value.steps[0] = { ...value.steps[0]!, sourceText: 'Turn the panel.', actions: null }
    const body = { status: 'ok', requestId: REQUEST_ID, mode: 'model', binding: manualBinding, value }
    const firstStep = (result: Awaited<ReturnType<ModelApiClient['parse']>>): unknown =>
        result.status === 'ok' ? result.value.steps[0] : null
    const response = (echo?: string): Response =>
        new Response(stream ? `data: ${JSON.stringify({ type: 'result', result: body })}\n\n` : JSON.stringify(body), {
            headers: {
                'content-type': stream ? 'text/event-stream' : 'application/json',
                ...(echo === undefined ? {} : { 'x-truebuild-step-fields': echo }),
            },
        })
    const context = { requestId: REQUEST_ID, ...(stream ? { onProgress: (): void => {} } : {}) }
    const unechoed = scripted(() => response())
    const absent = await client(unechoed.fetch).parse(manualBinding, session.pages, [source], context)
    expect(absent).toMatchObject({ status: 'ok' })
    expect(firstStep(absent)).not.toHaveProperty('sourceText')
    expect(firstStep(absent)).not.toHaveProperty('actions')

    const echoed = scripted(() => response('actions, sourceText'))
    const kept = await client(echoed.fetch).parse(manualBinding, session.pages, [source], context)
    expect(firstStep(kept)).toMatchObject({ sourceText: 'Turn the panel.', actions: null })
})
