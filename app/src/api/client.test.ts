import {
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type ManualBinding,
    type ParsedManual,
    type QuestionResult,
    type SegmentEvent,
} from '@truebuild/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    BoundedApiClient,
    MAX_RESPONSE_BYTES,
    REQUEST_TIMEOUT_MS,
    SIMULATED_LABEL,
    type ApiClientOptions,
    type FetchLike,
} from './client'

const BASE_URL = 'http://127.0.0.1:3001'
const REQUEST_ID = 'req-under-test'

const binding: CaptureBinding = {
    kind: 'capture',
    manualId: 'demo-divider',
    revision: 1,
    stepId: 'step-1',
    captureId: 'capture-1',
}

const manualRef: ManualBinding = { kind: 'manual', manualId: 'demo-divider', revision: 1 }

interface Recorded {
    readonly url: string
    readonly init: RequestInit
}

/**
 * Scripted fetch. By default it honours the request signal (rejecting on abort, as the platform does). A `ignoresSignal`
 * variant keeps resolving after an abort, to exercise the client's own deadline check on late responses.
 */
function scriptedFetch(
    respond: (call: Recorded) => Promise<Response>,
    options: { ignoresSignal?: boolean } = {},
): { fetch: FetchLike; calls: Recorded[] } {
    const calls: Recorded[] = []
    const fetchLike: FetchLike = (url: string, init: RequestInit): Promise<Response> => {
        const call: Recorded = { url, init }
        calls.push(call)

        return new Promise<Response>((resolve, reject): void => {
            const abort = (): void => {
                if (options.ignoresSignal !== true) {
                    reject(new DOMException('The operation was aborted.', 'AbortError'))
                }
            }

            if (init.signal?.aborted === true) {
                abort()
                return
            }

            init.signal?.addEventListener('abort', abort, { once: true })
            respond(call).then(resolve, reject)
        })
    }

    return { fetch: fetchLike, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function okEnvelope<T>(value: T, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { status: 'ok', requestId: REQUEST_ID, mode: 'fixture', binding, value, ...overrides }
}

function passCheck(): CheckResult {
    return {
        decision: 'pass',
        reason: `${SIMULATED_LABEL}. The selected correct scenario matches the demo step.`,
        sourceRefs: [{ pageId: 'demo-page-1', region: null }],
        observedRegion: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
        missingEvidence: [],
    }
}

function client(options: Partial<ApiClientOptions> = {}): BoundedApiClient {
    return new BoundedApiClient({ baseUrl: BASE_URL, mode: 'fixture', ...options })
}

const context = { requestId: REQUEST_ID }

beforeEach(() => {
    vi.useRealTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('BoundedApiClient success and schema validation', () => {
    it('returns the validated check result and sends exactly one request carrying the request identity', async () => {
        const { fetch, calls } = scriptedFetch(async () => jsonResponse(okEnvelope(passCheck())))

        const result = await client({ fetch }).check(binding, 'correct', context)

        expect(result).toEqual({
            status: 'ok',
            requestId: REQUEST_ID,
            mode: 'fixture',
            binding,
            value: passCheck(),
        })
        expect(calls).toHaveLength(1)
        expect(calls[0]?.url).toBe(`${BASE_URL}/api/checks`)
        expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
            mode: 'fixture',
            requestId: REQUEST_ID,
            binding,
            scenario: 'correct',
        })
    })

    it('validates a parse envelope against the parsed manual schema', async () => {
        const parsed: ParsedManual = { parts: [], steps: [], unknowns: [SIMULATED_LABEL] }
        const { fetch } = scriptedFetch(async () => jsonResponse(okEnvelope(parsed, { binding: manualRef })))

        await expect(client({ fetch }).parse(manualRef, context)).resolves.toMatchObject({
            status: 'ok',
            value: { unknowns: [SIMULATED_LABEL] },
        })
    })

    it('sends the question and the caller-supplied target, not a substituted default', async () => {
        const answer: QuestionResult = {
            answer: `${SIMULATED_LABEL}. For the selected demo point, follow the step.`,
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            missingEvidence: [],
        }
        const { fetch, calls } = scriptedFetch(async () => jsonResponse(okEnvelope(answer)))

        await client({ fetch }).questions(binding, 'Where does this go?', { kind: 'point', x: 0.25, y: 0.75 }, context)

        expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
            question: 'Where does this go?',
            target: { kind: 'point', x: 0.25, y: 0.75 },
        })
    })

    it('rejects a success envelope whose value fails the domain schema as invalid output, without retrying', async () => {
        const malformed = { ...passCheck(), missingEvidence: undefined }
        const { fetch, calls } = scriptedFetch(async () => jsonResponse(okEnvelope(malformed)))

        await expect(client({ fetch }).check(binding, 'correct', context)).resolves.toEqual({
            status: 'unavailable',
            requestId: REQUEST_ID,
            binding,
            code: 'invalid_output',
            retryable: false,
        })
        expect(calls).toHaveLength(1)
    })

    it('rejects a fixture value that lacks the simulated label', async () => {
        const unlabelled = { ...passCheck(), reason: 'Looks correct.' }
        const { fetch } = scriptedFetch(async () => jsonResponse(okEnvelope(unlabelled)))

        await expect(client({ fetch }).check(binding, 'correct', context)).resolves.toMatchObject({
            code: 'invalid_output',
        })
    })

    it.each([
        { name: 'a different requestId', overrides: { requestId: 'someone-else' } },
        { name: 'a different step binding', overrides: { binding: { ...binding, stepId: 'step-2' } } },
        { name: 'a different revision', overrides: { binding: { ...binding, revision: 2 } } },
        { name: 'a model-mode envelope from a fixture client', overrides: { mode: 'model' } },
    ])('rejects a success envelope echoing $name as invalid output', async ({ overrides }) => {
        const { fetch } = scriptedFetch(async () => jsonResponse(okEnvelope(passCheck(), overrides)))

        await expect(client({ fetch }).check(binding, 'correct', context)).resolves.toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
            retryable: false,
        })
    })

    it('preserves a valid unavailable envelope with its code and retryability', async () => {
        const envelope = {
            status: 'unavailable',
            requestId: REQUEST_ID,
            binding,
            code: 'unconfigured',
            retryable: false,
        }
        const { fetch } = scriptedFetch(async () => jsonResponse(envelope, 503))

        await expect(client({ fetch }).check(binding, 'correct', context)).resolves.toEqual({
            status: 'unavailable',
            requestId: REQUEST_ID,
            binding,
            code: 'unconfigured',
            retryable: false,
        })
    })

    it('maps non-envelope failures by status and retries nothing', async () => {
        const server = scriptedFetch(async () => new Response('internal detail', { status: 500 }))

        await expect(client({ fetch: server.fetch }).check(binding, 'correct', context)).resolves.toMatchObject({
            code: 'provider_error',
            retryable: true,
        })
        expect(server.calls).toHaveLength(1)

        const rejected = scriptedFetch(async () => new Response('', { status: 400 }))

        await expect(client({ fetch: rejected.fetch }).check(binding, 'correct', context)).resolves.toMatchObject({
            code: 'invalid_input',
            retryable: false,
        })
    })

    it('treats a body that is not JSON as invalid output and never leaks its text', async () => {
        const { fetch } = scriptedFetch(async () => new Response('<html>oops</html>', { status: 200 }))

        const result = await client({ fetch }).check(binding, 'correct', context)

        expect(result).toMatchObject({ code: 'invalid_output', retryable: false })
        expect(JSON.stringify(result)).not.toContain('oops')
    })

    it('rejects a body that is not valid UTF-8 as invalid output', async () => {
        const { fetch } = scriptedFetch(async () => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200 }))

        await expect(client({ fetch }).check(binding, 'correct', context)).resolves.toMatchObject({
            code: 'invalid_output',
        })
    })
})

describe('BoundedApiClient response size bounds', () => {
    it('rejects a response that declares a length above the cap before reading it', async () => {
        const headers = { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) }
        const { fetch } = scriptedFetch(async () => new Response('{}', { status: 200, headers }))

        await expect(client({ fetch }).check(binding, 'correct', context)).resolves.toMatchObject({
            code: 'invalid_output',
            retryable: false,
        })
    })

    it('rejects a streamed body that exceeds the cap even without a declared length', async () => {
        const oversized = new Uint8Array(MAX_RESPONSE_BYTES + 1).fill(0x20)
        const { fetch } = scriptedFetch(async () => new Response(oversized, { status: 200 }))

        await expect(client({ fetch }).check(binding, 'correct', context)).resolves.toMatchObject({
            code: 'invalid_output',
        })
    })
})

describe('BoundedApiClient cancellation and deadline', () => {
    it('cancels a stalled response reader when the caller aborts', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        let source: ReadableStreamDefaultController<Uint8Array> | undefined
        let cancelled = false
        let settled: ApiResult<CheckResult> | undefined
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(stream): void {
                    source = stream
                },
                cancel(): void {
                    cancelled = true
                },
            }),
            { headers: { 'content-type': 'application/json' } },
        )
        const { fetch } = scriptedFetch(async () => response)
        const pending = client({ fetch }).check(binding, 'correct', {
            requestId: REQUEST_ID,
            signal: controller.signal,
        })
        void pending.then((result): void => {
            settled = result
        })
        await vi.advanceTimersByTimeAsync(0)
        controller.abort()
        await vi.advanceTimersByTimeAsync(0)

        try {
            expect(settled).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
            expect(cancelled).toBe(true)
        } finally {
            if (!cancelled) {
                source?.close()
            }
            await pending
        }
    })

    it('settles on deadline and discards a response arriving after fetch ignored cancellation', async () => {
        vi.useFakeTimers()
        let resolveFetch: ((response: Response) => void) | undefined
        let settled: ApiResult<CheckResult> | undefined
        const fetch: FetchLike = (): Promise<Response> =>
            new Promise((resolve): void => {
                resolveFetch = resolve
            })
        const pending = client({ fetch }).check(binding, 'correct', context)
        void pending.then((result): void => {
            settled = result
        })
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
        const response = jsonResponse(okEnvelope(passCheck()))
        const body = response.body

        if (body === null) {
            throw new Error('Expected a test response body')
        }
        const cancellation = vi.spyOn(body, 'cancel')

        try {
            expect(settled).toMatchObject({ status: 'unavailable', code: 'timeout' })
            resolveFetch?.(response)
            await vi.advanceTimersByTimeAsync(0)
            expect(cancellation).toHaveBeenCalledOnce()
        } finally {
            resolveFetch?.(response)
            await pending
            cancellation.mockRestore()
        }
    })

    it.each(['deadline', 'caller abort'] as const)(
        'refuses success when %s occurs during interpretation',
        async (cause) => {
            let elapsed = 0
            const controller = new AbortController()
            const payload = JSON.stringify(okEnvelope(passCheck()))
            const originalParse: (text: string) => unknown = JSON.parse
            const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed)
            const monotonicClock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
            const parse = vi.spyOn(JSON, 'parse').mockImplementation((text: string): unknown => {
                const value = originalParse(text)

                if (text === payload) {
                    if (cause === 'deadline') {
                        elapsed = REQUEST_TIMEOUT_MS + 1
                    } else {
                        controller.abort()
                    }
                }

                return value
            })
            const { fetch, calls } = scriptedFetch(
                async () =>
                    new Response(payload, {
                        headers: { 'content-type': 'application/json' },
                    }),
            )

            try {
                await expect(
                    client({ fetch }).check(binding, 'correct', {
                        requestId: REQUEST_ID,
                        signal: controller.signal,
                    }),
                ).resolves.toMatchObject({
                    status: 'unavailable',
                    code: cause === 'deadline' ? 'timeout' : 'invalid_input',
                })
                expect(calls).toHaveLength(1)
            } finally {
                parse.mockRestore()
                monotonicClock.mockRestore()
                wallClock.mockRestore()
            }
        },
    )

    it('returns without any dispatch when the caller signal is already aborted', async () => {
        const controller = new AbortController()
        controller.abort()
        const { fetch, calls } = scriptedFetch(async () => jsonResponse(okEnvelope(passCheck())))

        await expect(
            client({ fetch }).check(binding, 'correct', { requestId: REQUEST_ID, signal: controller.signal }),
        ).resolves.toMatchObject({ status: 'unavailable', code: 'invalid_input', retryable: false })
        expect(calls).toHaveLength(0)
    })

    it('cancels an in-flight request when the caller aborts and never publishes a success', async () => {
        const controller = new AbortController()
        const { fetch, calls } = scriptedFetch(() => new Promise<Response>(() => undefined))

        const pending = client({ fetch }).check(binding, 'correct', {
            requestId: REQUEST_ID,
            signal: controller.signal,
        })

        controller.abort()

        await expect(pending).resolves.toMatchObject({ code: 'invalid_input', retryable: false })
        expect(calls).toHaveLength(1)
    })

    it('reports one absolute retryable timeout when the response never arrives', async () => {
        vi.useFakeTimers()
        const { fetch, calls } = scriptedFetch(() => new Promise<Response>(() => undefined))

        const pending = client({ fetch }).check(binding, 'correct', context)

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)

        await expect(pending).resolves.toMatchObject({ code: 'timeout', retryable: true })
        expect(calls).toHaveLength(1)
    })

    it('does not publish a response that arrives after the deadline even if fetch ignores the abort', async () => {
        vi.useFakeTimers()
        const { fetch } = scriptedFetch(
            async () => {
                await new Promise<void>((resolve): void => {
                    setTimeout(resolve, REQUEST_TIMEOUT_MS + 500)
                })
                return jsonResponse(okEnvelope(passCheck()))
            },
            { ignoresSignal: true },
        )

        const pending = client({ fetch }).check(binding, 'correct', context)

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000)

        await expect(pending).resolves.toMatchObject({ code: 'timeout', retryable: true })
    })

    it('classifies a network failure as a retryable provider error without a second attempt', async () => {
        const { fetch, calls } = scriptedFetch(async () => {
            throw new TypeError('fetch failed')
        })

        await expect(client({ fetch }).check(binding, 'correct', context)).resolves.toMatchObject({
            code: 'provider_error',
            retryable: true,
        })
        expect(calls).toHaveLength(1)
    })
})

describe('BoundedApiClient input, mode and origin boundaries', () => {
    it('returns unconfigured in model mode without any I/O', async () => {
        const { fetch, calls } = scriptedFetch(async () => jsonResponse(okEnvelope(passCheck())))

        await expect(client({ fetch, mode: 'model' }).check(binding, 'correct', context)).resolves.toMatchObject({
            code: 'unconfigured',
            retryable: false,
        })
        expect(calls).toHaveLength(0)
    })

    it('rejects malformed input before dispatch', async () => {
        const { fetch, calls } = scriptedFetch(async () => jsonResponse(okEnvelope(passCheck())))
        const invalid = client({ fetch })

        // The type boundary is the first line of defence; the runtime check is the second, so both are exercised.
        // @ts-expect-error a manual binding is not a capture binding
        await expect(invalid.check(manualRef, 'correct', context)).resolves.toMatchObject({ code: 'invalid_input' })
        // @ts-expect-error an unlisted scenario must be rejected at runtime
        await expect(invalid.check(binding, 'obviously-wrong', context)).resolves.toMatchObject({
            code: 'invalid_input',
        })
        await expect(
            invalid.questions(binding, '   ', { kind: 'point', x: 0.5, y: 0.5 }, context),
        ).resolves.toMatchObject({ code: 'invalid_input' })
        expect(calls).toHaveLength(0)
    })

    it.each([
        'http://example.com:3001',
        'https://user:secret@example.com',
        'http://user:secret@127.0.0.1:3001',
        'http://127.0.0.1:3001/api',
        'http://127.0.0.1:3001?x=1',
    ])('refuses the plain-http public, credentialed, path or query base URL %s', (baseUrl: string) => {
        expect(() => client({ baseUrl })).toThrow(/origin/)
    })

    it('accepts https origins and loopback or LAN http origins for development', () => {
        expect(() => client({ baseUrl: 'https://api.example.com' })).not.toThrow()
        expect(() => client({ baseUrl: 'http://localhost:3001' })).not.toThrow()
        expect(() => client({ baseUrl: 'http://127.0.0.1:3001' })).not.toThrow()
        expect(() => client({ baseUrl: 'http://192.168.1.20:3001' })).not.toThrow()
    })
})

describe('BoundedApiClient segment stream', () => {
    const snapshotEvent = (eventBinding: CaptureBinding): SegmentEvent => ({
        type: 'snapshot',
        snapshot: {
            binding: eventBinding,
            streamId: 'demo-stream',
            frameIndex: 0,
            capturedAt: '2026-01-01T00:00:00.000Z',
            records: [],
            complete: true,
        },
    })
    const stream = (events: SegmentEvent[]): Record<string, unknown> => ({
        label: SIMULATED_LABEL,
        transport: 'finite-json-precursor',
        events,
    })

    it('accepts the approved labelled finite envelope', async () => {
        const { fetch } = scriptedFetch(async () =>
            jsonResponse(okEnvelope(stream([snapshotEvent(binding), { type: 'completed' }]))),
        )

        await expect(client({ fetch }).segments(binding, 'normal', context)).resolves.toMatchObject({
            status: 'ok',
            value: { label: SIMULATED_LABEL, events: [{ type: 'snapshot' }, { type: 'completed' }] },
        })
    })

    it('rejects a bare event array, which is not the approved shape', async () => {
        const { fetch } = scriptedFetch(async () =>
            jsonResponse(okEnvelope([snapshotEvent(binding), { type: 'completed' }])),
        )

        await expect(client({ fetch }).segments(binding, 'normal', context)).resolves.toMatchObject({
            code: 'invalid_output',
        })
    })

    it('rejects a snapshot bound to a different capture than the one requested', async () => {
        const other: CaptureBinding = { ...binding, captureId: 'capture-2' }
        const { fetch } = scriptedFetch(async () =>
            jsonResponse(okEnvelope(stream([snapshotEvent(other), { type: 'completed' }]))),
        )

        await expect(client({ fetch }).segments(binding, 'normal', context)).resolves.toMatchObject({
            code: 'invalid_output',
        })
    })

    it('rejects a stream that does not end with exactly one terminal event', async () => {
        const { fetch } = scriptedFetch(async () => jsonResponse(okEnvelope(stream([snapshotEvent(binding)]))))

        await expect(client({ fetch }).segments(binding, 'normal', context)).resolves.toMatchObject({
            code: 'invalid_output',
        })
    })
})
