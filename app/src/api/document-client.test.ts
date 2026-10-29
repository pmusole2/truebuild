import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
    composeFallbackDocumentV2,
    createDemoManual,
    screenContextJsonV2,
    screenDocumentV2Schema,
    screenManualJsonV2,
    questionResultSchema,
    type ScreenContextInputsV2,
} from '@truebuild/contracts'
import { type ScreensV2Result, screensV2GenerateRequest } from '@truebuild/contracts/model'
import { createHeroResponse } from '@truebuild/contracts/hero'
import { sha256Hex } from '../features/documents/sha256'
import { ModelApiClient, type ModelFetch } from './model-client'
import {
    DOCUMENT_RESPONSE_MAX_BYTES,
    documentJobContextKey,
    documentPrecomputeInputs,
    documentRequest,
    inputsFromDocumentMetadata,
} from './document-client'

const session = createDemoManual()
const inputs: ScreenContextInputsV2 = {
    kind: 'guide',
    session,
    stepId: 'step-1',
    captureId: null,
    result: null,
    failure: null,
}
const metadata = screensV2GenerateRequest('v2-1', inputs, sha256Hex)
const document = composeFallbackDocumentV2(inputs, {
    sha256Hex,
    now: () => new Date('2026-01-01T00:00:00Z'),
    reason: 'fixture',
    evidence: 'synthetic-fixture',
})
const envelope = (doc = document): Extract<ScreensV2Result, { status: 'ok' }> => ({
    status: 'ok',
    requestId: 'v2-1',
    mode: 'fixture',
    value: { document: doc, documents: [], progress: null },
})
const client = (fetch: ModelFetch): ModelApiClient =>
    new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: 'public-fixture-key', fetch })

describe('portable document SHA256', () => {
    it.each([
        '',
        'abc',
        'a'.repeat(55),
        'b'.repeat(56),
        'c'.repeat(64),
        'd'.repeat(1_000),
        '中文 é 🛠️',
        '\ud800x\udfff',
        screenContextJsonV2(inputs),
        screenManualJsonV2(session),
    ])('matches Node crypto for exact UTF8 bytes %#', (text) => {
        expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'))
    })
})

describe('v2 document transport', () => {
    it('binds contextual More to the immutable companion question and authoritative answer facts', async () => {
        const companionAnswer = {
            question: 'Which way does the groove face?',
            value: questionResultSchema.parse({
                answer: 'The groove faces inward.',
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                missingEvidence: ['The far edge is not visible.'],
            }),
        }
        const contextual = {
            ...inputs,
            kind: 'more' as const,
            captureId: 'held-photo',
            result: { kind: 'check' as const, value: createHeroResponse('correct') },
            companionAnswer,
        }
        const request = documentRequest({ op: 'generate', inputs: contextual }, 'v2-1')
        expect(request).toMatchObject({ companionAnswer })
        expect(inputsFromDocumentMetadata(request)).toMatchObject({ companionAnswer })
        const complete = screenDocumentV2Schema.parse(
            composeFallbackDocumentV2(contextual, {
                sha256Hex,
                now: (): Date => new Date('2026-01-01T00:00:00Z'),
                reason: 'fixture',
                evidence: 'synthetic-fixture',
            }),
        )
        const fetch = vi.fn<ModelFetch>(async () => Response.json(envelope(complete)))
        const result = await client(fetch).screensV2(request, { requestId: 'v2-1' })
        expect(result).toMatchObject({ status: 'ok', value: { document: { bound: complete.bound } } })
        const changedQuestion = documentRequest(
            {
                op: 'generate',
                inputs: { ...contextual, companionAnswer: { ...companionAnswer, question: 'Is the edge visible?' } },
            },
            'v2-1',
        )
        expect(changedQuestion.contextKey).not.toBe(request.contextKey)
        expect(await client(fetch).screensV2(changedQuestion, { requestId: 'v2-1' })).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
        const forged = structuredClone(complete)
        const answer = forged.facts.find((fact) => fact.factId === 'result:answer')
        if (answer === undefined) throw new Error('missing companion answer')
        answer.text = 'The groove faces outward.'
        expect(screenDocumentV2Schema.safeParse(forged).success).toBe(true)
        const tampered = vi.fn<ModelFetch>(async () => Response.json(envelope(forged)))
        expect(await client(tampered).screensV2(request, { requestId: 'v2-1' })).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
        expect(tampered).toHaveBeenCalledTimes(1)
    })

    it.each([20, 100])(
        'accepts a valid large complete document with %s references per safety note',
        async (refsPerNote) => {
            const large = createDemoManual()
            const sourceRefs = Array.from({ length: refsPerNote }, (_, index) => ({
                pageId: 'demo-page-1',
                region: { x: (index % 10) / 10, y: Math.floor(index / 10) / 10, width: 0.02, height: 0.02 },
            }))
            large.reviewedSteps[0]!.safetyNotes = Array.from({ length: 100 }, (_, index) => ({
                noteId: `safety-${index}`,
                note: {
                    state: 'known',
                    value: `Safety note ${index + 1}: Keep clear of moving parts while attaching the panel. Keep the work on a steady surface and hold the loose panel securely until its connection is seated. Make sure nobody is reaching into the groove while the panel is moving. Check that each support remains stable before taking your hands away.`,
                    sourceRefs,
                },
            }))
            const context = { ...inputs, session: large }
            const request = screensV2GenerateRequest('v2-1', context, sha256Hex)
            const complete = screenDocumentV2Schema.parse(
                composeFallbackDocumentV2(context, {
                    sha256Hex,
                    now: (): Date => new Date('2026-01-01T00:00:00Z'),
                    reason: 'fixture',
                    evidence: 'synthetic-fixture',
                }),
            )
            const bytes = new TextEncoder().encode(JSON.stringify(envelope(complete))).byteLength
            expect(bytes).toBeGreaterThan(262_144)
            expect(bytes).toBeLessThan(DOCUMENT_RESPONSE_MAX_BYTES)
            const fetch = vi.fn<ModelFetch>(async () => Response.json(envelope(complete)))
            const result = await client(fetch).screensV2(request, { requestId: request.requestId })
            expect(result.status).toBe('ok')
            if (result.status !== 'ok' || result.value.document === null) throw new Error('missing large document')
            expect(result.value.document.bound.contextKey).toBe(request.contextKey)
            expect(sha256Hex(JSON.stringify(result.value.document.facts))).toBe(
                sha256Hex(JSON.stringify(complete.facts)),
            )
            expect(fetch).toHaveBeenCalledTimes(1)
        },
    )

    it('rejects schema-valid fact fabrication even when the response echoes the correct context hash', async () => {
        const forged = structuredClone(document)
        if (forged.facts[0] === undefined) throw new Error('missing fixture fact')
        forged.facts[0].text = 'Install the bracket upside down.'
        expect(screenDocumentV2Schema.safeParse(forged).success).toBe(true)
        const fetch = vi.fn<ModelFetch>(async () => Response.json(envelope(forged)))
        expect(await client(fetch).screensV2(metadata, { requestId: metadata.requestId })).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it.each([false, true])(
        'binds control operations to the current manual/group and rejects altered progress (guide selector %s)',
        async (onlyGuides) => {
            const common = { session, ...(onlyGuides ? { requestedKinds: ['guide'] as const } : {}) }
            const progress = {
                manualId: session.manualId,
                revision: session.revision,
                contextKey: documentJobContextKey(common),
                mode: 'full' as const,
                items: documentPrecomputeInputs(common).map(({ key, inputs }) => ({
                    key,
                    kind: inputs.kind,
                    stepId: inputs.stepId,
                    state: 'queued' as const,
                    screenId: null,
                })),
            }
            for (const op of ['precompute', 'progress', 'cancel'] as const) {
                const request =
                    op === 'precompute'
                        ? documentRequest({ ...common, op, focusKey: 'guide:step-1' }, `job-${op}`)
                        : op === 'progress'
                          ? documentRequest(
                                { ...common, op, want: [], jobContextKey: progress.contextKey },
                                `job-${op}`,
                            )
                          : documentRequest({ ...common, op }, `job-${op}`)
                const fetch = vi.fn<ModelFetch>(async () =>
                    Response.json({
                        status: 'ok',
                        requestId: request.requestId,
                        mode: 'fixture',
                        value: { document: null, documents: [], progress },
                    }),
                )
                expect(await client(fetch).screensV2(request, { requestId: request.requestId })).toMatchObject({
                    status: 'ok',
                    value: { progress },
                })
                expect(fetch).toHaveBeenCalledTimes(1)
                const sent = JSON.parse(String((fetch.mock.calls[0]![1].body as FormData).get('metadata')))
                expect(sent).toEqual(request)
                expect(sent.manualHash).toBe(sha256Hex(screenManualJsonV2(session)))
            }
            const request = documentRequest(
                { ...common, op: 'progress', want: [], jobContextKey: progress.contextKey },
                'read',
            )
            for (const patch of [
                { contextKey: 'f'.repeat(64) },
                { revision: session.revision + 1 },
                { items: progress.items.slice(1) },
                { items: [...progress.items.slice(1), progress.items[1]] },
                { items: progress.items.map((item, index) => (index === 0 ? { ...item, kind: 'home' } : item)) },
            ]) {
                const fetch = vi.fn<ModelFetch>(async () =>
                    Response.json({
                        status: 'ok',
                        requestId: 'read',
                        mode: 'fixture',
                        value: { document: null, documents: [], progress: { ...progress, ...patch } },
                    }),
                )
                expect(await client(fetch).screensV2(request, { requestId: 'read' })).toMatchObject({
                    status: 'unavailable',
                    code: 'invalid_output',
                })
            }
            expect(() =>
                documentRequest({ ...common, op: 'progress', want: [], jobContextKey: 'f'.repeat(64) }, 'read'),
            ).toThrow('stale_document_job')
        },
    )

    it('fails closed on oversized response and stopped body reads without retrying', async () => {
        let overrunCancelled = false
        const oversized = vi.fn<ModelFetch>(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller): void {
                            controller.enqueue(new Uint8Array(DOCUMENT_RESPONSE_MAX_BYTES + 1))
                        },
                        cancel(): void {
                            overrunCancelled = true
                        },
                    }),
                ),
        )
        expect(await client(oversized).screensV2(metadata, { requestId: metadata.requestId })).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
        expect(oversized).toHaveBeenCalledTimes(1)
        expect(overrunCancelled).toBe(true)
        const abort = new AbortController()
        let cancelled = false
        const stalled = vi.fn<ModelFetch>(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller): void {
                            controller.enqueue(new TextEncoder().encode('{'))
                        },
                        cancel(): void {
                            cancelled = true
                        },
                    }),
                ),
        )
        const pending = client(stalled).screensV2(metadata, { requestId: metadata.requestId, signal: abort.signal })
        await vi.waitFor(() => expect(stalled).toHaveBeenCalledTimes(1))
        abort.abort()
        expect(await pending).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        await vi.waitFor(() => expect(cancelled).toBe(true))
        expect(stalled).toHaveBeenCalledTimes(1)
    })

    it('collects only a requested exact document whose progress identity and terminal state agree', async () => {
        const contextKey = documentJobContextKey({ session })
        const request = documentRequest(
            { op: 'progress', session, want: ['guide:step-1'], jobContextKey: contextKey },
            'collection',
        )
        const progress = {
            manualId: session.manualId,
            revision: session.revision,
            contextKey,
            mode: 'full' as const,
            items: documentPrecomputeInputs({ session }).map((item) => ({
                key: item.key,
                kind: item.inputs.kind,
                stepId: item.inputs.stepId,
                state: 'fallback' as const,
                screenId: document.screenId,
            })),
        }
        const value = { document: null, documents: [document], progress }
        const fetch = vi.fn<ModelFetch>(async () =>
            Response.json({ status: 'ok', requestId: request.requestId, mode: 'fixture', value }),
        )
        expect(await client(fetch).screensV2(request, { requestId: request.requestId })).toMatchObject({
            status: 'ok',
            value: { documents: [document] },
        })
        for (const patch of [
            { progress: null },
            { documents: [document, document] },
            {
                progress: {
                    ...progress,
                    items: progress.items.map((item) =>
                        item.key === 'guide:step-1' ? { ...item, state: 'ready' } : item,
                    ),
                },
            },
            {
                progress: {
                    ...progress,
                    items: progress.items.map((item) =>
                        item.key === 'guide:step-1' ? { ...item, screenId: 'f'.repeat(64) } : item,
                    ),
                },
            },
            {
                progress: {
                    ...progress,
                    items: progress.items.map((item) =>
                        item.key === 'guide:step-1' ? { ...item, state: 'queued' } : item,
                    ),
                },
            },
        ]) {
            const invalid = vi.fn<ModelFetch>(async () =>
                Response.json({
                    status: 'ok',
                    requestId: request.requestId,
                    mode: 'fixture',
                    value: { ...value, ...patch },
                }),
            )
            expect(await client(invalid).screensV2(request, { requestId: request.requestId })).toMatchObject({
                status: 'unavailable',
                code: 'invalid_output',
            })
            expect(invalid).toHaveBeenCalledTimes(1)
        }
        const unwanted = { ...request, want: [] }
        expect(await client(fetch).screensV2(unwanted, { requestId: unwanted.requestId })).toMatchObject({
            status: 'unavailable',
            code: 'invalid_output',
        })
    })

    it('sends exactly one zero-file request with guarded origin settings and preserves truthful fixture metadata', async () => {
        const fetch = vi.fn<ModelFetch>(async () => Response.json(envelope()))
        expect(await client(fetch).screensV2(metadata, { requestId: 'v2-1' })).toMatchObject({
            status: 'ok',
            value: { document: { version: 2, metadata: { evidence: 'synthetic-fixture', model: null } } },
        })
        expect(fetch).toHaveBeenCalledTimes(1)
        const [url, init] = fetch.mock.calls[0]!
        expect(new URL(url).pathname).toBe('/api/screens/v2')
        expect(init).toMatchObject({
            credentials: 'omit',
            redirect: 'error',
            headers: { 'x-truebuild-key': 'public-fixture-key' },
        })
        const form = init.body as FormData
        const keys: string[] = []
        form.forEach((_value, key): void => {
            keys.push(key)
        })
        expect(keys).toEqual(['metadata'])
        expect(JSON.parse(String(form.get('metadata')))).toEqual(metadata)
        expect(String(form.get('metadata'))).not.toContain('public-fixture-key')
    })

    it.each(['request', 'kind', 'manual', 'revision', 'step', 'capture', 'context'] as const)(
        'rejects a corrupt %s response identity',
        async (which) => {
            const value = structuredClone(envelope())
            if (value.value.document === null) throw new Error('missing fixture document')
            if (which === 'request') value.requestId = 'foreign'
            if (which === 'kind') value.value.document.kind = 'reading'
            if (which === 'manual') value.value.document.bound.manualId = 'foreign'
            if (which === 'revision') value.value.document.bound.revision = 9
            if (which === 'step') value.value.document.bound.stepId = 'step-2'
            if (which === 'capture') value.value.document.bound.captureId = 'foreign'
            if (which === 'context') value.value.document.bound.contextKey = 'a'.repeat(64)
            const fetch = vi.fn<ModelFetch>(async () => Response.json(value))
            expect(await client(fetch).screensV2(metadata, { requestId: 'v2-1' })).toMatchObject({
                status: 'unavailable',
                code: 'invalid_output',
            })
            expect(fetch).toHaveBeenCalledTimes(1)
        },
    )

    it('rejects stale manual/context hashes and request-id mismatch before dispatch', async () => {
        const fetch = vi.fn<ModelFetch>()
        for (const request of [
            { ...metadata, manualHash: 'f'.repeat(64) },
            { ...metadata, contextKey: 'f'.repeat(64) },
            { ...metadata, requestId: 'other' },
        ]) {
            expect(await client(fetch).screensV2(request, { requestId: 'v2-1' })).toMatchObject({
                status: 'unavailable',
                code: 'invalid_input',
            })
        }
        expect(fetch).not.toHaveBeenCalled()
    })

    it('does not retry failures or accept a late ignored-abort response', async () => {
        const failed = vi.fn<ModelFetch>(async () => new Response('', { status: 503 }))
        expect(await client(failed).screensV2(metadata, { requestId: 'v2-1' })).toMatchObject({
            status: 'unavailable',
            code: 'unconfigured',
            retryable: false,
        })
        expect(failed).toHaveBeenCalledTimes(1)
        let finish: ((response: Response) => void) | undefined
        const abort = new AbortController()
        const fetch = vi.fn<ModelFetch>(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                }),
        )
        const pending = client(fetch).screensV2(metadata, { requestId: 'v2-1', signal: abort.signal })
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
        abort.abort()
        expect(await pending).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        finish?.(Response.json(envelope()))
    })
})
