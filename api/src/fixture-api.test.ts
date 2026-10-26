import { createDemoManual } from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'

import { GET } from './app/api/health/route'
import { POST as checkRoute } from './app/api/checks/route'
import { OPTIONS as checkOptions } from './app/api/checks/route'
import { POST as parseRoute } from './app/api/manuals/parse/route'
import { POST as questionRoute } from './app/api/questions/route'
import { POST as segmentRoute } from './app/api/segments/route'
import { createFixtureProvider } from './providers/fixture'
import { createApiHandlers } from './server/handlers'

const manualBinding = { kind: 'manual', manualId: 'demo-divider', revision: 1 } as const
const captureBinding = {
    kind: 'capture',
    manualId: 'demo-divider',
    revision: 1,
    stepId: 'step-1',
    captureId: 'capture-1',
} as const

function request(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/api/checks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

function checkInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { mode: 'fixture', requestId: 'request-1', binding: captureBinding, scenario: 'correct', ...overrides }
}

describe('fixture API request boundary', () => {
    it('exercises the actual health and parse route exports', async () => {
        expect(await GET().json()).toMatchObject({ status: 'ok', live: 'unconfigured', fixture: 'available' })
        const response = await parseRoute(request({ mode: 'fixture', requestId: 'parse-1', binding: manualBinding }))

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            status: 'ok',
            mode: 'fixture',
            binding: manualBinding,
            value: { unknowns: expect.arrayContaining(['Demo data — simulated results']) },
        })
    })

    it('returns live unconfigured without provider dispatch or outbound requests', async () => {
        const provider = createFixtureProvider()
        const dispatch = vi.spyOn(provider, 'check')
        const handlers = createApiHandlers(provider)
        const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No outbound access allowed'))

        try {
            const response = await handlers.check(request(checkInput({ mode: 'model' })))

            expect(response.status).toBe(503)
            expect(await response.json()).toMatchObject({
                status: 'unavailable',
                code: 'unconfigured',
                retryable: false,
            })
            expect(dispatch).not.toHaveBeenCalled()
            expect(outbound).not.toHaveBeenCalled()
        } finally {
            outbound.mockRestore()
        }
    })

    it('allows only the two local Expo origins and supported preflight headers', async () => {
        for (const origin of ['http://localhost:8081', 'http://127.0.0.1:8081']) {
            const response = checkOptions(
                new Request('http://localhost/api/checks', {
                    method: 'OPTIONS',
                    headers: {
                        origin,
                        'access-control-request-method': 'POST',
                        'access-control-request-headers': 'content-type, authorization',
                    },
                }),
            )

            expect(response.status).toBe(204)
            expect(response.headers.get('access-control-allow-origin')).toBe(origin)
            expect(response.headers.get('vary')).toBe('Origin')
            expect(response.headers.get('access-control-allow-headers')).toBe(
                'Content-Type, Authorization, X-TrueBuild-Key',
            )
            expect(response.headers.has('access-control-allow-credentials')).toBe(false)
        }

        const deniedHeader = checkOptions(
            new Request('http://localhost/api/checks', {
                method: 'OPTIONS',
                headers: {
                    origin: 'http://localhost:8081',
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'x-unsupported',
                },
            }),
        )

        expect(deniedHeader.status).toBe(401)
    })

    it('rejects foreign origins before provider dispatch and reflects allowed POST origins', async () => {
        const provider = createFixtureProvider()
        const dispatch = vi.spyOn(provider, 'check')
        const handlers = createApiHandlers(provider)
        const rejected = await handlers.check(request(checkInput(), { origin: 'https://foreign.example' }))

        expect(rejected.status).toBe(403)
        expect(rejected.headers.has('access-control-allow-origin')).toBe(false)
        expect(dispatch).not.toHaveBeenCalled()

        const accepted = await handlers.check(request(checkInput(), { origin: 'http://localhost:8081' }))

        expect(accepted.status).toBe(200)
        expect(accepted.headers.get('access-control-allow-origin')).toBe('http://localhost:8081')
        expect(dispatch).toHaveBeenCalledTimes(1)
    })

    it('exercises check, question and segment route exports without outbound calls', async () => {
        const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No outbound access allowed'))

        try {
            const checked = await checkRoute(request(checkInput()))
            const answered = await questionRoute(
                request({
                    mode: 'fixture',
                    requestId: 'question-1',
                    binding: captureBinding,
                    question: 'Where does this go?',
                    target: { kind: 'point', x: 0.4, y: 0.5 },
                }),
            )
            const segmented = await segmentRoute(
                request({
                    mode: 'fixture',
                    requestId: 'segment-1',
                    binding: captureBinding,
                }),
            )

            expect(await checked.json()).toMatchObject({ status: 'ok', value: { decision: 'pass' } })
            expect(await answered.json()).toMatchObject({
                status: 'ok',
                value: { answer: expect.stringContaining('Demo data — simulated results') },
            })
            expect(await segmented.json()).toMatchObject({
                status: 'ok',
                value: { transport: 'finite-json-precursor' },
            })
            expect(outbound).not.toHaveBeenCalled()
        } finally {
            outbound.mockRestore()
        }
    })

    it('rejects unresolved question parts and oversized questions without dispatch', async () => {
        const provider = createFixtureProvider()
        const dispatch = vi.spyOn(provider, 'question')
        const question = createApiHandlers(provider).question

        for (const input of [
            { question: 'Where?', target: { kind: 'part', partId: 'missing-part' } },
            { question: 'x'.repeat(501), target: { kind: 'part', partId: 'divider' } },
        ]) {
            const response = await question(
                request({
                    mode: 'fixture',
                    requestId: 'question-1',
                    binding: captureBinding,
                    ...input,
                }),
            )

            expect(response.status).toBe(400)
        }

        expect(dispatch).not.toHaveBeenCalled()
    })

    it.each([
        { scenario: 'analyze-photo' },
        { binding: { ...captureBinding, manualId: 'imported-private-manual' } },
        { binding: { ...captureBinding, revision: 2 } },
        { binding: { ...captureBinding, stepId: 'unknown-step' } },
        { url: 'https://example.test/photo.jpg' },
        { image: 'base64-image' },
    ])('rejects unsupported input before provider dispatch: %j', async (overrides) => {
        const provider = createFixtureProvider()
        const dispatch = vi.spyOn(provider, 'check')
        const response = await createApiHandlers(provider).check(request(checkInput(overrides)))

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('rejects wrong content type, malformed JSON and bodies over 64KiB', async () => {
        const handlers = createApiHandlers(createFixtureProvider())
        const wrongType = await handlers.check(request(checkInput(), { 'content-type': 'text/plain' }))
        const malformed = await handlers.check(
            new Request('http://localhost', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{',
            }),
        )
        const oversized = await handlers.check(request(checkInput({ padding: 'x'.repeat(65_536) })))

        expect(wrongType.status).toBe(415)
        expect(malformed.status).toBe(400)
        expect(oversized.status).toBe(413)
    })

    it('bounds streamed reads even without content-length and cancels at the limit', async () => {
        let chunks = 0
        let cancelled = false
        const body = new ReadableStream<Uint8Array>({
            pull(controller): void {
                chunks += 1
                controller.enqueue(new Uint8Array(32_769).fill(120))
            },
            cancel(): void {
                cancelled = true
            },
        })
        const streamed = new Request('http://localhost', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            // Node requires duplex for a streaming request; RequestInit in DOM excludes it.
            ...{ duplex: 'half' },
        })
        const response = await createApiHandlers(createFixtureProvider()).check(streamed)

        expect(response.status).toBe(413)
        expect(cancelled).toBe(true)
        expect(chunks).toBeLessThanOrEqual(3)
    })

    it('dispatches once and validates provider output instead of returning malformed success', async () => {
        const provider = createFixtureProvider()
        const dispatch = vi.spyOn(provider, 'check').mockResolvedValue({
            decision: 'pass',
            reason: 'bad provider output',
            sourceRefs: [],
            observedRegion: null,
            missingEvidence: [],
        })
        const response = await createApiHandlers(provider).check(request(checkInput()))

        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(response.status).toBe(502)
        expect(await response.json()).toMatchObject({ status: 'unavailable', code: 'invalid_output', retryable: false })
    })

    it('sanitizes provider failure without retries or leaking its message', async () => {
        const provider = createFixtureProvider()
        const dispatch = vi.spyOn(provider, 'check').mockRejectedValue(new Error('private provider detail'))
        const response = await createApiHandlers(provider).check(request(checkInput()))

        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(await response.text()).not.toContain('private provider detail')
        expect(response.status).toBe(502)
    })

    it.each([
        { reason: 'Unlabelled result', sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
        { reason: 'Demo data — simulated results', sourceRefs: [{ pageId: 'private-page', region: null }] },
    ])('rejects provider citations or labels outside fixture context: %j', async (output) => {
        const provider = createFixtureProvider()
        vi.spyOn(provider, 'check').mockResolvedValue({
            decision: 'pass',
            ...output,
            observedRegion: null,
            missingEvidence: [],
        })
        const response = await createApiHandlers(provider).check(request(checkInput()))

        expect(await response.json()).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
    })

    it('rejects a segment snapshot bound to another capture', async () => {
        const provider = createFixtureProvider()
        const result = await provider.segment({
            mode: 'fixture',
            requestId: 'segment-1',
            binding: captureBinding,
            stream: 'normal',
        })

        for (const event of result.events) {
            if (event.type === 'snapshot') {
                event.snapshot.binding = { ...event.snapshot.binding, captureId: 'other-capture' }
            }
        }

        vi.spyOn(provider, 'segment').mockResolvedValue(result)
        const response = await createApiHandlers(provider).segment(
            request({
                mode: 'fixture',
                requestId: 'segment-1',
                binding: captureBinding,
            }),
        )

        expect(await response.json()).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
    })
})

describe('deterministic fixture provider', () => {
    it.each([
        ['correct', 'pass'],
        ['wrong', 'refuse'],
        ['unclear', 'cannot_verify'],
    ] as const)('returns labelled %s check outcome', async (scenario, decision) => {
        const result = await createFixtureProvider().check({
            mode: 'fixture',
            requestId: 'request-1',
            binding: captureBinding,
            scenario,
        })

        expect(result.decision).toBe(decision)
        expect(result.reason).toContain('Demo data — simulated results')

        if (decision === 'pass') {
            expect(result.sourceRefs.length).toBeGreaterThan(0)
            expect(result.missingEvidence).toEqual([])
        }
    })

    it('keeps extraction correction unreviewed and answers only from demo citations', async () => {
        const provider = createFixtureProvider()
        const parsed = await provider.parse({ mode: 'fixture', requestId: 'parse-1', binding: manualBinding })
        const answer = await provider.question({
            mode: 'fixture',
            requestId: 'question-1',
            binding: captureBinding,
            question: 'Which part?',
            target: { kind: 'part', partId: 'divider' },
        })

        expect(parsed.steps).toHaveLength(createDemoManual().reviewedSteps.length)
        expect(parsed.steps.every((step) => step.correction === null || !step.correction.reviewed)).toBe(true)
        expect(answer.answer).toContain('Demo data — simulated results')
        expect(answer.sourceRefs[0]?.pageId).toBe('demo-page-1')
    })

    it.each(['normal', 'empty', 'incomplete'] as const)(
        'terminates the finite %s stream exactly once',
        async (stream) => {
            const handlers = createApiHandlers(createFixtureProvider())
            const response = await handlers.segment(
                request({
                    mode: 'fixture',
                    requestId: 'segment-1',
                    binding: captureBinding,
                    stream,
                }),
            )
            const body: unknown = await response.json()

            expect(response.headers.get('content-type')).toContain('application/json')
            expect(body).toMatchObject({
                status: 'ok',
                mode: 'fixture',
                value: { label: 'Demo data — simulated results', transport: 'finite-json-precursor' },
            })
            const result = await createFixtureProvider().segment({
                mode: 'fixture',
                requestId: 'segment-1',
                binding: captureBinding,
                stream,
            })

            expect(result.events.filter((event) => event.type !== 'snapshot')).toHaveLength(1)
            expect(result.events.at(-1)?.type).toBe(stream === 'incomplete' ? 'unavailable' : 'completed')
            expect(result.events.filter((event) => event.type === 'snapshot')).toHaveLength(stream === 'empty' ? 0 : 1)
        },
    )
})
