import { createDemoManual, type ManualBinding, type ScreenDocument, type ScreensResult } from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'
import { hex, makeDocument } from '../features/screens/test-support/documents'
import { ModelApiClient, interpretScreens, type ModelFetch, type ScreenRequest } from './model-client'

const session = createDemoManual()
const stepId = session.reviewedSteps[0]!.stepId
const binding: ManualBinding = { kind: 'manual', manualId: session.manualId, revision: session.revision }

function client(fetch: ModelFetch): ModelApiClient {
    return new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: 'public-demo-key-for-tests', fetch })
}

function ok(
    document: ScreenDocument | null,
    extra: Partial<Extract<ScreensResult, { status: 'ok' }>['value']> = {},
): unknown {
    return {
        status: 'ok',
        requestId: 'r1',
        mode: 'fixture',
        value: { document, progress: null, documents: [], ...extra },
    }
}

const generate: ScreenRequest = {
    op: 'generate',
    kind: 'guide',
    session,
    stepId,
    captureId: null,
    result: null,
    failure: null,
}

describe('screens request', () => {
    it('sends exactly one metadata field and no files, to the screens route, with the key only in the header', async () => {
        const fetch = vi.fn<ModelFetch>(async () => Response.json(ok(makeDocument())))
        await client(fetch).screens(generate, { requestId: 'r1' })
        expect(fetch).toHaveBeenCalledTimes(1)
        const [url, init] = fetch.mock.calls[0]!
        expect(new URL(url).pathname).toBe('/api/screens')
        expect(new URL(url).searchParams.get('guideRepair')).toBe('1')
        const form = init.body as FormData
        expect(form.get('metadata')).toBeTypeOf('string')
        expect(form.has('observation')).toBe(false)
        expect(form.has('source-0')).toBe(false)
        const metadata = JSON.parse(String(form.get('metadata'))) as Record<string, unknown>
        expect(metadata).toMatchObject({ mode: 'model', op: 'generate', kind: 'guide', stepId, captureId: null })
        expect(JSON.stringify(metadata)).not.toContain('public-demo-key')
        expect(init.headers).toMatchObject({ 'x-truebuild-key': 'public-demo-key-for-tests' })
    })

    it('sends no unreviewed correction text and leaves the saved session exactly as it was', async () => {
        const proposed = 'A proposed fix that no person has reviewed.'
        const unreviewed = {
            reviewed: false,
            actions: [
                { actionId: 'proposed', instruction: proposed, sourceRefs: session.reviewedSteps[0]!.sourceRefs },
            ],
        }
        const saved = structuredClone(session)
        saved.reviewedSteps[0] = { ...saved.reviewedSteps[0]!, correction: unreviewed }
        const before = structuredClone(saved)
        const fetch = vi.fn<ModelFetch>(async () => Response.json(ok(makeDocument())))
        await client(fetch).screens({ ...generate, session: saved }, { requestId: 'r1' })
        const form = fetch.mock.calls[0]![1].body as FormData
        expect(String(form.get('metadata'))).not.toContain(proposed)
        expect(saved).toEqual(before)
    })

    it('accepts a document for exactly the identity it asked for and returns the fixture mode untouched', async () => {
        const fetch = vi.fn<ModelFetch>(async () => Response.json(ok(makeDocument())))
        const result = await client(fetch).screens(generate, { requestId: 'r1' })
        expect(result).toMatchObject({ status: 'ok', mode: 'fixture' })
    })

    it.each([
        ['another kind', makeDocument({ kind: 'result', captureId: 'c', stepId })],
        ['another step', makeDocument({ stepId: 'step-2' })],
        ['another revision', makeDocument({ session: { ...session, revision: session.revision + 1 } })],
        ['another capture', makeDocument({ captureId: 'capture-9' })],
        ['no manual', makeDocument({ session: null, stepId: null })],
    ])('rejects a document for %s as invalid output and publishes nothing', async (_name, document) => {
        const fetch = vi.fn<ModelFetch>(async () => Response.json(ok(document)))
        expect(await client(fetch).screens(generate, { requestId: 'r1' })).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
    })

    it('rejects an unknown version, an extra field and a null document on generate', async () => {
        for (const body of [
            ok({ ...makeDocument(), version: 2 } as unknown as ScreenDocument),
            ok({ ...makeDocument(), extra: true } as unknown as ScreenDocument),
            ok(null),
        ]) {
            const fetch = vi.fn<ModelFetch>(async () => Response.json(body))
            expect(await client(fetch).screens(generate, { requestId: 'r1' })).toMatchObject({
                status: 'unavailable',
                code: 'invalid_output',
            })
        }
    })

    it('does not dispatch a request the contract would reject', async () => {
        const fetch = vi.fn<ModelFetch>()
        const result = await client(fetch).screens({ ...generate, kind: 'result' }, { requestId: 'r1' })
        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_input', retryable: false })
        expect(fetch).not.toHaveBeenCalled()
    })

    it('maps HTTP failures without retrying and never as a document', async () => {
        for (const [status, code] of [
            [401, 'unauthorized'],
            [409, 'duplicate_request'],
            [429, 'budget_exhausted'],
            [500, 'provider_error'],
            [504, 'timeout'],
        ] as const) {
            const fetch = vi.fn<ModelFetch>(async () => new Response('', { status }))
            expect(await client(fetch).screens(generate, { requestId: 'r1' })).toMatchObject({
                status: 'unavailable',
                code,
            })
            expect(fetch).toHaveBeenCalledTimes(1)
        }
    })

    it('stops a call on the caller signal and reports it as a stop, not a document', async () => {
        const controller = new AbortController()
        const fetch = vi.fn<ModelFetch>(
            (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
                }),
        )
        const pending = client(fetch).screens(generate, { requestId: 'r1', signal: controller.signal })
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
        controller.abort()
        expect(await pending).toMatchObject({ status: 'unavailable', code: 'invalid_input', retryable: false })
    })
})

describe('background step pages', () => {
    const progress = {
        manualId: session.manualId,
        revision: session.revision,
        contextKey: hex('d'),
        mode: 'full',
        steps: [{ stepId, state: 'ready', screenId: hex('b') }],
    }

    it('starts a precompute and reads progress with only the steps it asks for', async () => {
        const fetch = vi.fn<ModelFetch>(async () => Response.json(ok(null, { progress } as never)))
        const started = await client(fetch).screens(
            { op: 'precompute', session, focusStepId: stepId },
            { requestId: 'r1' },
        )
        expect(started).toMatchObject({ status: 'ok' })
        const metadata = JSON.parse(String((fetch.mock.calls[0]![1].body as FormData).get('metadata'))) as Record<
            string,
            unknown
        >
        expect(metadata).toMatchObject({ op: 'precompute', focusStepId: stepId })
    })

    it('accepts progress documents only for steps it asked about and for this manual revision', async () => {
        const good = makeDocument()
        const fetch = vi.fn<ModelFetch>(async () => Response.json(ok(null, { progress, documents: [good] } as never)))
        expect(
            await client(fetch).screens({ op: 'progress', binding, want: [stepId] }, { requestId: 'r1' }),
        ).toMatchObject({ status: 'ok' })
        const foreign = vi.fn<ModelFetch>(async () =>
            Response.json(ok(null, { progress, documents: [makeDocument({ stepId: 'step-9' })] } as never)),
        )
        expect(
            await client(foreign).screens({ op: 'progress', binding, want: [stepId] }, { requestId: 'r1' }),
        ).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
        const wrongRevision = vi.fn<ModelFetch>(async () =>
            Response.json(
                ok(null, { progress: { ...progress, revision: session.revision + 1 }, documents: [] } as never),
            ),
        )
        expect(
            await client(wrongRevision).screens({ op: 'progress', binding, want: [stepId] }, { requestId: 'r1' }),
        ).toMatchObject({ status: 'unavailable', code: 'invalid_output' })
    })

    it('cancels a job for exactly one binding', async () => {
        const fetch = vi.fn<ModelFetch>(async () =>
            Response.json(
                ok(null, {
                    progress: { ...progress, steps: [{ stepId, state: 'cancelled', screenId: null }] },
                } as never),
            ),
        )
        expect(await client(fetch).screens({ op: 'cancel', binding }, { requestId: 'r1' })).toMatchObject({
            status: 'ok',
        })
    })

    it('interprets a body that is not JSON by its status alone', () => {
        expect(interpretScreens(502, 'upstream', 'r1', generate)).toMatchObject({
            status: 'unavailable',
            code: 'provider_error',
        })
        expect(interpretScreens(200, 'not json', 'r1', generate)).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
    })
})

describe('overlay and slow-question calls', () => {
    const capture = {
        kind: 'capture',
        manualId: session.manualId,
        revision: session.revision,
        stepId,
        captureId: 'c1',
    } as const
    const bytes = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', width: 4, height: 3 } as const
    const page = { bytes: new Uint8Array([4, 5, 6]), mimeType: 'image/jpeg', width: 10, height: 10 } as const

    it('posts the overlay with the same request identity, the one-use token and every file', async () => {
        const fetch = vi.fn<ModelFetch>(async () =>
            Response.json({
                status: 'ok',
                requestId: 'check-1',
                mode: 'model',
                binding: capture,
                value: { model: 'muse-wonder-1.0', effort: 'max', observedRegion: null },
            }),
        )
        const result = await client(fetch).overlay(capture, session, ['demo-page-1'], [page], bytes, 'tok-1', {
            requestId: 'check-1',
        })
        expect(result).toMatchObject({ status: 'ok', value: { model: 'muse-wonder-1.0', effort: 'max' } })
        const [url, init] = fetch.mock.calls[0]!
        expect(new URL(url).pathname).toBe('/api/checks/overlay')
        const form = init.body as FormData
        expect(form.get('metadata')).toBeTypeOf('string')
        expect(form.get('observation')).not.toBeNull()
        expect(form.get('source-0')).not.toBeNull()
        expect(form.has('source-1')).toBe(false)
        expect(JSON.parse(String(form.get('metadata')))).toMatchObject({ requestId: 'check-1', overlayToken: 'tok-1' })
    })

    it('reports a refused or replayed ticket as unavailable and does not resend', async () => {
        const fetch = vi.fn<ModelFetch>(async () => new Response('', { status: 409 }))
        const result = await client(fetch).overlay(capture, session, ['demo-page-1'], [page], bytes, 'tok-1', {
            requestId: 'check-1',
        })
        expect(result).toMatchObject({ status: 'unavailable', code: 'duplicate_request' })
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('returns a 202 as a pending ticket only when it echoes this request and capture', async () => {
        const pending = (overrides: Record<string, unknown> = {}): Response =>
            Response.json(
                {
                    status: 'pending',
                    requestId: 'q1',
                    binding: capture,
                    ticket: 't',
                    retryAfterMs: 1500,
                    expiresInMs: 60_000,
                    ...overrides,
                },
                { status: 202 },
            )
        const ask = (fetch: ModelFetch): ReturnType<ModelApiClient['questions']> =>
            client(fetch).questions(
                capture,
                session,
                ['demo-page-1'],
                [page],
                bytes,
                'Which way?',
                { kind: 'part', partId: 'side-panel' },
                {
                    requestId: 'q1',
                },
            )
        expect(await ask(async () => pending())).toMatchObject({ status: 'pending', ticket: 't' })
        expect(await ask(async () => pending({ requestId: 'someone-else' }))).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
        expect(await ask(async () => pending({ binding: { ...capture, captureId: 'c2' } }))).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
    })

    it('collects a ticket with JSON, never the photo, and cancels with a 204 only', async () => {
        const fetch = vi.fn<ModelFetch>(async (url) =>
            url.endsWith('/cancel')
                ? new Response(null, { status: 204 })
                : Response.json({
                      status: 'ok',
                      requestId: 'q1',
                      mode: 'model',
                      binding: capture,
                      value: {
                          answer: 'It faces inward.',
                          sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                          missingEvidence: [],
                      },
                  }),
        )
        const api = client(fetch)
        expect(await api.questionResult(capture, 'ticket', { requestId: 'q1' }, ['demo-page-1'])).toMatchObject({
            status: 'ok',
        })
        expect(fetch.mock.calls[0]![1].body).toBeTypeOf('string')
        expect(fetch.mock.calls[0]![1].headers).toMatchObject({ 'content-type': 'application/json' })
        expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({
            mode: 'model',
            requestId: 'q1',
            binding: capture,
            ticket: 'ticket',
        })
        expect(await api.questionCancel(capture, 'ticket', { requestId: 'q1' })).toBe(true)
        const refused = vi.fn<ModelFetch>(async () => new Response('', { status: 400 }))
        expect(await client(refused).questionCancel(capture, 'ticket', { requestId: 'q1' })).toBe(false)
    })
})
