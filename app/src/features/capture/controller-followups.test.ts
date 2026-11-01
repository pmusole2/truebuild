import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createDemoManual,
    type ApiResult,
    type CheckResult,
    type ManualBinding,
    type ParsedManual,
    type SegmentEvent,
} from '@truebuild/contracts'
import {
    modelCheckMetadataSchema,
    modelOverlayMetadataSchema,
    modelQuestionJobMetadataSchema,
    modelParseMetadataSchema,
    modelQuestionMetadataSchema,
    modelSecondOpinionMetadataSchema,
} from '@truebuild/contracts/model'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'
import type { locateInPhoto } from '../assembly/localize'
import { CaptureController } from './controller'
import { LibraryStorage, type KeyValueStorage } from './library'

const fixture = createDemoManual()
const image = {
    bytes: new Uint8Array([1, 2, 3]),
    width: 600,
    height: 800,
    mimeType: 'image/jpeg' as const,
    uri: 'file:///n.jpg',
}
const photo = { uri: 'file:///source.jpg', width: 4032, height: 3024 }
const digest = async (bytes: Uint8Array): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('')

function storage(): LibraryStorage {
    const data = new Map<string, string>()
    const kv: KeyValueStorage = {
        getItem: async (key) => data.get(key) ?? null,
        setItem: async (key, value) => void data.set(key, value),
        removeItem: async (key) => void data.delete(key),
        getAllKeys: async () => [...data.keys()],
    }
    return new LibraryStorage(kv, digest)
}

function parsed(pageId: string): ParsedManual {
    const value = JSON.parse(
        JSON.stringify({ parts: fixture.parts, steps: fixture.reviewedSteps, unknowns: [] }).replaceAll(
            'demo-page-1',
            pageId,
        ),
    ) as ParsedManual
    for (const step of value.steps) if (step.correction !== null) step.correction.reviewed = false
    return value
}

type Script = {
    decision?: CheckResult['decision']
    primaryRegion?: CheckResult['observedRegion']
    offers?: CheckResult['followUps'] | null
    /** Answers the overlay call. `reply` wraps a value in the envelope that echoes the request, as the server does. */
    overlay?: (call: {
        signal: AbortSignal | null | undefined
        reply: (value: unknown, mode?: 'model' | 'fixture') => Response
    }) => Promise<Response>
    secondOpinion?: (reply: (value: unknown) => Response) => Promise<Response>
    locate?: typeof locateInPhoto
    /** Answers a question call with the pending ticket (202) or the final envelope. */
    question?: (call: { path: string; pending: Response; answer: Response }) => Promise<Response>
}

const overlayBody = {
    model: 'muse-wonder-1.0',
    effort: 'max',
    observedRegion: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
}
const nextPartRegion = { partId: 'side-panel', region: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } }

async function ready(script: Script = {}): Promise<{
    controller: CaptureController
    calls: string[]
    overlayForms: FormData[]
    locateCalls: string[]
}> {
    let id = 0
    let askedPage = 'p'
    const calls: string[] = []
    const overlayForms: FormData[] = []
    const locateCalls: string[] = []
    const fetch: ModelFetch = async (url, init) => {
        const path = new URL(url).pathname
        calls.push(path)
        // Ticket calls are JSON; every other call is the multipart form with one metadata field.
        const form = init.body as FormData
        const raw = JSON.parse(typeof init.body === 'string' ? init.body : String(form.get('metadata'))) as Record<
            string,
            unknown
        >
        if (path === '/api/manuals/parse') {
            const meta = modelParseMetadataSchema.parse(raw)
            return Response.json({
                status: 'ok',
                mode: 'model',
                requestId: meta.requestId,
                binding: meta.binding,
                value: parsed(meta.pages[0]!.pageId),
            })
        }
        if (path === '/api/questions' || path === '/api/questions/result') {
            const meta = (
                path === '/api/questions' ? modelQuestionMetadataSchema : modelQuestionJobMetadataSchema
            ).parse(raw)
            const common = { requestId: meta.requestId, binding: meta.binding }
            // The ticket call carries no pages; the answer cites the page the question was asked with.
            if ('sourcePageIds' in meta) askedPage = meta.sourcePageIds[0] ?? askedPage
            return script.question!({
                path,
                pending: Response.json(
                    { status: 'pending', ...common, ticket: 'job-1', retryAfterMs: 500, expiresInMs: 60_000 },
                    { status: 202 },
                ),
                answer: Response.json({
                    status: 'ok',
                    mode: 'model',
                    ...common,
                    value: {
                        answer: 'The groove faces inward.',
                        sourceRefs: [{ pageId: askedPage, region: null }],
                        missingEvidence: [],
                    },
                }),
            })
        }
        if (path === '/api/checks/overlay') {
            const meta = modelOverlayMetadataSchema.parse(raw)
            overlayForms.push(form)
            const reply = (value: unknown, mode: 'model' | 'fixture' = 'model'): Response =>
                Response.json({ status: 'ok', mode, requestId: meta.requestId, binding: meta.binding, value })
            return script.overlay === undefined
                ? reply({ ...overlayBody, nextPartRegion })
                : script.overlay({ signal: init.signal, reply })
        }
        if (path === '/api/checks/second-opinion' && script.secondOpinion !== undefined) {
            const meta = modelSecondOpinionMetadataSchema.parse(raw)
            return script.secondOpinion((value) =>
                Response.json({
                    status: 'ok',
                    mode: 'model',
                    requestId: meta.requestId,
                    binding: meta.binding,
                    // A refusal or pass must cite the manual page it was judged against.
                    value: { sourceRefs: [{ pageId: meta.sourcePageIds[0]!, region: null }], ...(value as object) },
                }),
            )
        }
        const meta = modelCheckMetadataSchema.parse(raw)
        const decision = script.decision ?? 'refuse'
        const offers =
            script.offers === null
                ? undefined
                : (script.offers ?? {
                      overlay: { status: 'available', model: 'muse-wonder-1.0', token: 'overlay-ticket' },
                      segments: { status: 'available', model: 'sam-3.1', prompts: ['side panel'] },
                  })
        return Response.json({
            status: 'ok',
            mode: 'model',
            requestId: meta.requestId,
            binding: meta.binding,
            value: {
                decision,
                reason: 'Primary Spark result.',
                sourceRefs: [{ pageId: meta.sourcePageIds[0]!, region: null }],
                observedRegion: script.primaryRegion ?? null,
                missingEvidence: decision === 'cannot_verify' ? ['Groove is obscured.'] : [],
                model: 'muse-spark-1.3',
                ...(decision === 'cannot_verify'
                    ? { secondOpinion: { status: 'available', model: 'muse-wonder-1.0', token: 'second-ticket' } }
                    : {}),
                ...(offers === undefined ? {} : { followUps: offers }),
            },
        })
    }
    const controller = new CaptureController({
        storage: storage(),
        client: new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: '', fetch }),
        digest,
        normalize: async (): Promise<typeof image> => image,
        id: (): string => `t-${++id}`,
        locate:
            script.locate ??
            async function* (request): AsyncGenerator<ApiResult<SegmentEvent>, void, void> {
                locateCalls.push(request.prompt)
                const binding = request.binding
                yield {
                    status: 'ok',
                    requestId: request.requestId,
                    mode: 'model',
                    binding,
                    value: {
                        type: 'snapshot',
                        snapshot: {
                            binding,
                            streamId: 'stream-1',
                            frameIndex: 0,
                            capturedAt: '2026-01-01T00:00:00.000Z',
                            complete: true,
                            stage: { model: 'sam-3.1', elapsedMs: 412 },
                            records: [
                                {
                                    objectId: 'o1',
                                    label: 'side panel',
                                    box: { x: 0.1, y: 0.1, width: 0.4, height: 0.5 },
                                    mask: { width: 4, height: 4, path: 'M0 0H4V4H0Z' },
                                },
                            ],
                        },
                    },
                }
                yield {
                    status: 'ok',
                    requestId: request.requestId,
                    mode: 'model',
                    binding,
                    value: { type: 'completed' },
                }
            },
    })
    controllers.push(controller)
    await controller.restore()
    await controller.createManual()
    await controller.importPages(async () => [photo])
    await controller.parse()
    await controller.confirm()
    return { controller, calls, overlayForms, locateCalls }
}

const controllers: CaptureController[] = []
afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose()
    vi.useRealTimers()
})
const binding = (controller: CaptureController): ManualBinding => ({
    kind: 'manual',
    manualId: controller.current!.session.manualId,
    revision: controller.current!.session.revision,
})

async function check(controller: CaptureController): Promise<void> {
    controller.camera({ kind: 'check' })
    await controller.shutter(async () => photo)
}

describe('follow-ups after a published verdict', () => {
    it('publishes the verdict with the offers, then lands the overlay regions and the SAM mask without touching the decision', async () => {
        const { controller, overlayForms } = await ready()
        await check(controller)
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.overlay.status).toBe('landed'))
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.segments.status).toBe('landed'))
        const state = controller.getSnapshot()
        expect(state.check?.decision).toBe('refuse')
        expect(state.check?.reason).toBe('Primary Spark result.')
        expect(state.check?.nextPartRegion).toEqual(nextPartRegion)
        expect(state.check?.observedRegion).toEqual(overlayBody.observedRegion)
        expect(state.pending).toBeNull()
        expect(state.stages).toMatchObject({
            captureId: state.capture?.binding.captureId,
            overlay: { status: 'landed', model: 'muse-wonder-1.0', effort: 'max' },
            segments: { status: 'landed', modelElapsedMs: 412, model: 'sam-3.1' },
        })
        expect(state.stages?.masks).toEqual([
            {
                label: 'side panel',
                box: { x: 0.1, y: 0.1, width: 0.4, height: 0.5 },
                mask: { width: 4, height: 4, path: 'M0 0H4V4H0Z' },
            },
        ])
        const meta = JSON.parse(String(overlayForms[0]!.get('metadata'))) as { overlayToken: string; requestId: string }
        expect(meta.overlayToken).toBe('overlay-ticket')
        expect(binding(controller).manualId).toBeDefined()
    })

    it('lands a fixture overlay that names no model or effort without inventing either, and keeps the decision', async () => {
        const { controller } = await ready({
            overlay: async ({ reply }) =>
                reply(
                    { evidence: 'synthetic-fixture', observedRegion: overlayBody.observedRegion, nextPartRegion },
                    'fixture',
                ),
        })
        await check(controller)
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.overlay.status).toBe('landed'))
        const { stages, check: held } = controller.getSnapshot()
        expect(stages?.overlay).toMatchObject({ status: 'landed' })
        expect(stages?.overlay).not.toHaveProperty('model')
        expect(stages?.overlay).not.toHaveProperty('effort')
        expect(held?.decision).toBe('refuse')
        expect(held?.nextPartRegion).toEqual(nextPartRegion)
        expect(stages?.publishedAt).toEqual(expect.any(Number))
    })

    it('keeps the verdict own observed region when the overlay supplies none, and replaces it when it does', async () => {
        const own = { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }
        const without = await ready({
            primaryRegion: own,
            overlay: async ({ reply }) => reply({ ...overlayBody, observedRegion: null }),
        })
        await check(without.controller)
        await vi.waitFor(() => expect(without.controller.getSnapshot().stages?.overlay.status).toBe('landed'))
        expect(without.controller.getSnapshot().check?.observedRegion).toEqual(own)
        const withOne = await ready({ primaryRegion: own })
        await check(withOne.controller)
        await vi.waitFor(() => expect(withOne.controller.getSnapshot().stages?.overlay.status).toBe('landed'))
        expect(withOne.controller.getSnapshot().check?.observedRegion).toEqual(overlayBody.observedRegion)
    })

    it('adds nothing and records no stage when the server offered nothing (generated screens off)', async () => {
        const { controller, calls } = await ready({ offers: null })
        await check(controller)
        expect(controller.getSnapshot().stages).toBeUndefined()
        expect(calls).not.toContain('/api/checks/overlay')
    })

    it('stays honest about what was skipped', async () => {
        const { controller, calls } = await ready({ offers: { overlay: { status: 'unavailable' } } })
        await check(controller)
        expect(controller.getSnapshot().stages).toMatchObject({
            overlay: { status: 'skipped', reason: 'unavailable' },
            segments: { status: 'skipped', reason: 'not_offered' },
            masks: [],
        })
        expect(calls).not.toContain('/api/checks/overlay')
    })

    it('does not delay the verdict, the busy state or the next action for a slow overlay', async () => {
        let finish: (value: unknown) => void = () => undefined
        const { controller } = await ready({
            overlay: ({ reply }) =>
                new Promise<Response>((resolve) => (finish = (value: unknown): void => resolve(reply(value)))),
        })
        await check(controller)
        const state = controller.getSnapshot()
        expect(state.pending).toBeNull()
        expect(state.check?.decision).toBe('refuse')
        expect(state.stages?.overlay).toEqual({ status: 'pending' })
        expect(controller.canCompose).toBe(true)
        finish(overlayBody)
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.overlay.status).toBe('landed'))
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
    })

    it('uses the one-use ticket once: a refused overlay is not retried', async () => {
        const { controller, overlayForms } = await ready({ overlay: async () => new Response('', { status: 409 }) })
        await check(controller)
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.overlay.status).toBe('failed'))
        expect(controller.getSnapshot().stages?.overlay).toMatchObject({ status: 'failed', code: 'duplicate_request' })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(overlayForms).toHaveLength(1)
    })

    it('drops a late overlay and mask when the person takes a new photo', async () => {
        let finish: (value: unknown) => void = () => undefined
        let aborted = false
        const { controller } = await ready({
            overlay: ({ signal, reply }) => {
                signal?.addEventListener('abort', () => (aborted = true))
                return new Promise<Response>((resolve) => (finish = (value: unknown): void => resolve(reply(value))))
            },
        })
        await check(controller)
        expect(controller.getSnapshot().stages?.overlay.status).toBe('pending')
        controller.camera({ kind: 'check' })
        await vi.waitFor(() => expect(aborted).toBe(true))
        finish(overlayBody)
        await new Promise((resolve) => setTimeout(resolve, 20))
        const state = controller.getSnapshot()
        expect(state.check).toBeNull()
        expect(state.stages === undefined || state.stages === null).toBe(true)
    })

    it('drops a late overlay when the person moves to another step', async () => {
        let finish: (value: unknown) => void = () => undefined
        const { controller } = await ready({
            overlay: ({ reply }) =>
                new Promise<Response>((resolve) => (finish = (value: unknown): void => resolve(reply(value)))),
        })
        await check(controller)
        await controller.step(0)
        finish(overlayBody)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(controller.getSnapshot().check).toBeNull()
        expect(controller.getSnapshot().stages === undefined || controller.getSnapshot().stages === null).toBe(true)
    })

    it('rejects an overlay whose merged verdict would not validate rather than publishing it', async () => {
        const { controller } = await ready({
            overlay: async ({ reply }) =>
                reply({ ...overlayBody, observedRegion: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 } }),
        })
        await check(controller)
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.overlay.status).toBe('failed'))
        expect(controller.getSnapshot().check?.observedRegion).toBeNull()
    })

    it('reports a mask stage that failed as failed and keeps the boxes out of the mask list', async () => {
        const { controller } = await ready({
            locate: async function* (request) {
                yield {
                    status: 'unavailable',
                    requestId: request.requestId,
                    binding: request.binding,
                    code: 'timeout',
                    retryable: true,
                }
            },
        })
        await check(controller)
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.segments.status).toBe('failed'))
        expect(controller.getSnapshot().stages).toMatchObject({
            segments: { status: 'failed', code: 'timeout' },
            masks: [],
        })
    })

    it('shows only masks the server returned: a box without a mask is carried but not drawn as one', async () => {
        const { controller } = await ready({
            locate: async function* (request) {
                const binding = request.binding
                yield {
                    status: 'ok',
                    requestId: request.requestId,
                    mode: 'model',
                    binding,
                    value: {
                        type: 'snapshot',
                        snapshot: {
                            binding,
                            streamId: 'stream-1',
                            frameIndex: 0,
                            capturedAt: '2026-01-01T00:00:00.000Z',
                            complete: true,
                            records: [
                                {
                                    objectId: 'o1',
                                    label: 'side panel',
                                    box: { x: 0.1, y: 0.1, width: 0.4, height: 0.5 },
                                },
                            ],
                        },
                    },
                }
                yield {
                    status: 'ok',
                    requestId: request.requestId,
                    mode: 'model',
                    binding,
                    value: { type: 'completed' },
                }
            },
        })
        await check(controller)
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.segments.status).toBe('landed'))
        const stages = controller.getSnapshot().stages
        expect(stages?.masks.every((mark) => mark.mask === undefined)).toBe(true)
        expect(stages?.segments).toMatchObject({ modelElapsedMs: null })
    })
})

describe('closer look keeps its guards', () => {
    it('keeps landed overlay regions when the closer look replaces the verdict, and never promotes to pass', async () => {
        const { controller } = await ready({
            decision: 'cannot_verify',
            secondOpinion: async (reply) =>
                reply({
                    decision: 'pass',
                    reason: 'Looks right.',
                    observedRegion: null,
                    missingEvidence: [],
                    model: 'muse-wonder-1.0',
                    secondOpinion: { status: 'completed', model: 'muse-wonder-1.0' },
                }),
        })
        await check(controller)
        await vi.waitFor(() => expect(controller.getSnapshot().stages?.overlay.status).toBe('landed'))
        const state = controller.getSnapshot()
        expect(state.check?.decision).toBe('cannot_verify')
        expect(state.check?.secondOpinion?.status).toBe('completed')
        expect(state.check?.nextPartRegion).toEqual(nextPartRegion)
        expect(state.pending).toBeNull()
    })

    it('keeps the verdict usable while the closer look runs and applies its guarded result', async () => {
        let finish: (value: unknown) => void = () => undefined
        const { controller, calls } = await ready({
            decision: 'cannot_verify',
            secondOpinion: (reply) =>
                new Promise<Response>((resolve) => (finish = (value: unknown): void => resolve(reply(value)))),
        })
        const pending: (string | null)[] = []
        controller.subscribe(() => pending.push(controller.getSnapshot().pending))
        const work = check(controller)
        await vi.waitFor(() => expect(calls).toContain('/api/checks/second-opinion'))
        expect(controller.getSnapshot().check?.secondOpinion?.status).toBe('available')
        expect(controller.getSnapshot().pending).toBeNull()
        expect(pending.some((value) => value?.startsWith('Second opinion') === true)).toBe(false)
        expect(controller.getSnapshot().check?.decision).toBe('cannot_verify')
        finish({
            decision: 'refuse',
            reason: 'Panel faces outward.',
            observedRegion: null,
            missingEvidence: [],
            model: 'muse-wonder-1.0',
            secondOpinion: { status: 'completed', model: 'muse-wonder-1.0' },
        })
        await work
        expect(controller.getSnapshot().pending).toBeNull()
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
    })
})

describe('a slow question', () => {
    it('says it is still thinking while the same question is followed to its answer, and then clears it', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        const paths: string[] = []
        const { controller } = await ready({
            offers: null,
            question: async ({ path, pending, answer }) => {
                paths.push(path)
                return path === '/api/questions' || paths.filter((p) => p === '/api/questions/result').length < 2
                    ? pending
                    : answer
            },
        })
        await check(controller)
        controller.targetChanged({ kind: 'part', partId: 'side-panel' })
        controller.questionChanged('Which way?')
        const asking = controller.ask()
        await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe('Still thinking about your question…'))
        expect(controller.getSnapshot().answer).toBeNull()
        await vi.advanceTimersByTimeAsync(600)
        await vi.advanceTimersByTimeAsync(600)
        await asking
        expect(controller.getSnapshot().answer?.answer).toBe('The groove faces inward.')
        expect(controller.getSnapshot().pending).toBeNull()
        expect(paths).toEqual(['/api/questions', '/api/questions/result', '/api/questions/result'])
    })

    it('cancels the server job and shows no late answer when the person cancels', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        const paths: string[] = []
        const { controller } = await ready({
            offers: null,
            question: async ({ path, pending }) => {
                paths.push(path)
                return pending
            },
        })
        await check(controller)
        controller.targetChanged({ kind: 'part', partId: 'side-panel' })
        controller.questionChanged('Which way?')
        const asking = controller.ask()
        await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe('Still thinking about your question…'))
        controller.cancel()
        await asking
        expect(controller.getSnapshot().answer).toBeNull()
        expect(controller.getSnapshot().pending).toBeNull()
        expect(paths.filter((path) => path === '/api/questions')).toHaveLength(1)
    })
})
