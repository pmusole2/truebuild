import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoManual, type ApiResult, type CheckResult, type ParsedManual } from '@truebuild/contracts'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'
import { CaptureController, reviewedSession } from './controller'
import { LibraryStorage, type KeyValueStorage } from './library'

const fixture = createDemoManual()
const image = {
    bytes: new Uint8Array([1, 2, 3]),
    width: 600,
    height: 800,
    mimeType: 'image/jpeg' as const,
    uri: 'file:///normalized.jpg',
}
const photo = { uri: 'file:///source.jpg', width: 4032, height: 3024 }
const digest = async (bytes: Uint8Array): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('')
function storage(): LibraryStorage {
    const data = new Map<string, string>()
    const kv: KeyValueStorage = {
        getItem: async (key): Promise<string | null> => data.get(key) ?? null,
        setItem: async (key, value): Promise<void> => {
            data.set(key, value)
        },
        removeItem: async (key): Promise<void> => {
            data.delete(key)
        },
        getAllKeys: async (): Promise<string[]> => [...data.keys()],
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
    for (const step of value.steps) {
        if (step.correction !== null) {
            step.correction.reviewed = false
        }
    }
    return value
}
function setup(
    responder?: ModelFetch,
    normalize = async (): Promise<typeof image> => image,
): {
    controller: CaptureController
    calls: string[]
    store: LibraryStorage
} {
    let id = 0
    const calls: string[] = []
    const fetch: ModelFetch =
        responder ??
        (async (url, init): Promise<Response> => {
            calls.push(url)
            const form = init.body as FormData
            const meta = JSON.parse(String(form.get('metadata'))) as {
                requestId: string
                binding: ApiResult<unknown>['binding']
                pages?: { pageId: string }[]
                sourcePageIds?: string[]
            }
            const value = url.endsWith('/parse')
                ? parsed(meta.pages![0]!.pageId)
                : url.endsWith('/questions')
                  ? {
                        answer: 'Check the expected diagram.',
                        sourceRefs: [{ pageId: meta.sourcePageIds![0]!, region: null }],
                        missingEvidence: [],
                    }
                  : ({
                        decision: 'refuse',
                        reason: 'Panel faces outward.',
                        sourceRefs: [{ pageId: meta.sourcePageIds![0]!, region: null }],
                        observedRegion: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
                        missingEvidence: [],
                        orientationAssessment: 'reversed',
                    } satisfies CheckResult)
            return new Response(
                JSON.stringify({
                    status: 'ok',
                    mode: 'model',
                    ...meta,
                    pages: undefined,
                    sourcePageIds: undefined,
                    // Envelope deliberately includes only the public response fields.
                    value,
                }),
                { headers: { 'Content-Type': 'application/json' } },
            )
        })
    const boundary: ModelFetch = async (url, init): Promise<Response> => {
        const response = await fetch(url, init)
        const body: unknown = await response.clone().json()
        // Return the canonical server envelope for the default fixture; custom responses are preserved.
        if (responder !== undefined || typeof body !== 'object' || body === null) {
            return response
        }
        const { status, requestId, mode, binding, value } = body as Record<string, unknown>
        return new Response(JSON.stringify({ status, requestId, mode, binding, value }), {
            headers: { 'Content-Type': 'application/json' },
        })
    }
    const store = storage()
    const controller = new CaptureController({
        storage: store,
        client: new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: '', fetch: boundary }),
        digest,
        normalize,
        id: (): string => `test-${++id}`,
    })
    return { controller, calls, store }
}
const controllers: CaptureController[] = []
afterEach(() => {
    for (const controller of controllers.splice(0)) {
        controller.dispose()
    }
    vi.useRealTimers()
})
async function ready(): Promise<ReturnType<typeof setup>> {
    const runtime = setup()
    controllers.push(runtime.controller)
    await runtime.controller.restore()
    await runtime.controller.createManual()
    await runtime.controller.importPages(async () => [photo])
    await runtime.controller.parse()
    await runtime.controller.confirm()
    return runtime
}

describe('real manual workflow with provider-boundary fixture responses', () => {
    it('starts empty, parses a unique manual binding, requires review, and invalidates it on page edits', async () => {
        const { controller, calls, store } = setup()
        controllers.push(controller)
        await controller.restore()
        expect(controller.getSnapshot().entries).toEqual([])
        await controller.createManual()
        await controller.importPages(async () => [photo, photo])
        expect(calls).toEqual([])
        await controller.parse()
        expect(controller.current?.session.reviewStatus).toBe('unreviewed')
        expect(controller.current?.session.manualId).not.toBe('demo-divider')
        expect(controller.getSnapshot().route).toBe('overview')
        await controller.confirm()
        expect(controller.current?.session.reviewStatus).toBe('reviewed')
        const revision = controller.current!.session.revision
        await controller.editPage(1, 'up')
        expect(controller.current?.session.revision).toBe(revision + 1)
        expect(controller.current?.session.rawExtraction).toBeNull()
        expect(controller.current?.session.reviewStatus).toBe('unreviewed')
        expect((await store.restore()).entries[0]?.session.pages).toHaveLength(2)
    })

    it('blocks confirmation for unknown critical facts', () => {
        const session = createDemoManual()
        session.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Cannot read the arrow' }
        expect(reviewedSession(session)).toBeNull()
    })

    it('freezes normalized bytes, displays refusal geometry, and clears the verdict on a new camera action', async () => {
        const { controller, calls } = await ready()
        controller.camera({ kind: 'check' })
        await controller.shutter(async () => photo)
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
        expect(controller.getSnapshot().check?.observedRegion).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
        const captureId = controller.getSnapshot().capture!.binding.captureId
        expect(calls.some((url) => url.endsWith('/api/checks'))).toBe(true)
        controller.camera({ kind: 'question' })
        expect(controller.getSnapshot().check).toBeNull()
        expect(controller.getSnapshot().capture).toBeNull()
        await controller.shutter(async () => photo)
        expect(controller.getSnapshot().capture?.binding.captureId).not.toBe(captureId)
        controller.questionChanged('Which way should this panel face?')
        controller.targetChanged({ kind: 'point', x: 0.3, y: 0.5 })
        await controller.ask()
        expect(controller.getSnapshot().answer?.answer).toBe('Check the expected diagram.')
        controller.questionChanged('A different question')
        expect(controller.getSnapshot().answer).toBeNull()
    })

    it('discards a camera result after the step changes without dispatching a check', async () => {
        const { controller, calls } = await ready()
        let deliver: ((value: typeof photo) => void) | undefined
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(
            (): Promise<typeof photo> =>
                new Promise((resolve) => {
                    deliver = resolve
                }),
        )
        await controller.step(1)
        deliver?.(photo)
        await pending
        expect(controller.getSnapshot().capture).toBeNull()
        expect(controller.getSnapshot().check).toBeNull()
        expect(calls.filter((url) => url.endsWith('/api/checks'))).toHaveLength(0)
    })

    it('restores progress and photo bytes without restoring verification', async () => {
        const { controller, store } = await ready()
        controller.camera({ kind: 'check' })
        await controller.shutter(async () => photo)
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
        const entry = (await store.restore()).entries[0]!
        expect(entry.capture).not.toBeNull()
        // Same persistent adapter, new controller: a stored photo is view-only.
        const next = new CaptureController({
            storage: store,
            client: new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: '' }),
            digest,
            normalize: async (): Promise<typeof image> => image,
            id: (): string => 'restore',
        })
        controllers.push(next)
        await next.restore()
        await next.open(entry.session.manualId, 'guide')
        expect(next.getSnapshot().capture?.observation.bytes).toEqual(image.bytes)
        expect(next.getSnapshot().check).toBeNull()
        expect(next.getSnapshot().notice).toMatch(/Take a new photo/)
        await controller.completeStep()
        expect((await store.restore()).entries[0]?.completedStepIds).toHaveLength(1)
    })

    it('keeps a new question answer when target selection cancels an in-flight check', async () => {
        let checking = false
        let finishCheck: ((response: Response) => void) | undefined
        const { controller } = setup(async (url, init): Promise<Response> => {
            const meta = JSON.parse(String((init.body as FormData).get('metadata'))) as {
                requestId: string
                binding: unknown
                pages?: { pageId: string }[]
                sourcePageIds?: string[]
            }
            if (url.endsWith('/checks')) {
                checking = true
                return new Promise((resolve) => {
                    finishCheck = resolve
                })
            }
            return new Response(
                JSON.stringify({
                    status: 'ok',
                    mode: 'model',
                    requestId: meta.requestId,
                    binding: meta.binding,
                    value: url.endsWith('/parse')
                        ? parsed(meta.pages![0]!.pageId)
                        : {
                              answer: 'New question answer.',
                              sourceRefs: [{ pageId: meta.sourcePageIds![0]!, region: null }],
                              missingEvidence: [],
                          },
                }),
                { headers: { 'Content-Type': 'application/json' } },
            )
        })
        controllers.push(controller)
        await controller.restore()
        await controller.createManual()
        await controller.importPages(async () => [photo])
        await controller.parse()
        await controller.confirm()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(checking).toBe(true))
        controller.questionChanged('Which way?')
        controller.targetChanged({ kind: 'point', x: 0.5, y: 0.5 })
        await controller.ask()
        finishCheck?.(new Response('{}'))
        await pending
        expect(controller.getSnapshot().answer?.answer).toBe('New question answer.')
        expect(controller.getSnapshot().check).toBeNull()
    })

    it('expires a frozen verdict at eight seconds and requires a new photo to ask', async () => {
        const { controller } = await ready()
        vi.useFakeTimers()
        controller.camera({ kind: 'check' })
        await controller.shutter(async () => photo)
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
        await vi.advanceTimersByTimeAsync(8_001)
        expect(controller.getSnapshot().check).toBeNull()
        expect(controller.getSnapshot().answer).toBeNull()
        expect(controller.getSnapshot().notice).toMatch(/expired/)
        controller.questionChanged('Which way?')
        controller.targetChanged({ kind: 'point', x: 0.5, y: 0.5 })
        await controller.ask()
        expect(controller.getSnapshot().notice).toMatch(/expired/)
        expect(controller.getSnapshot().answer).toBeNull()
    })

    it('counts normalization inside the eight-second check budget and ignores its late completion', async () => {
        let count = 0
        let deliver: ((value: typeof image) => void) | undefined
        const { controller, calls } = setup(undefined, async (): Promise<typeof image> => {
            if (++count === 1) {
                return image
            }
            return new Promise((resolve) => {
                deliver = resolve
            })
        })
        controllers.push(controller)
        await controller.restore()
        await controller.createManual()
        await controller.importPages(async () => [photo])
        await controller.parse()
        await controller.confirm()
        vi.useFakeTimers()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.advanceTimersByTimeAsync(8_001)
        await pending
        deliver?.(image)
        await Promise.resolve()
        expect(controller.getSnapshot().capture).toBeNull()
        expect(controller.getSnapshot().check).toBeNull()
        expect(controller.getSnapshot().notice).toMatch(/8 seconds/)
        expect(calls.some((url) => url.endsWith('/api/checks'))).toBe(false)
    })

    it('cancels a parse that returns late, preserving the unparsed manual', async () => {
        let release: ((response: Response) => void) | undefined
        let metadata: Record<string, unknown> | undefined
        const { controller } = setup(async (_url, init) => {
            metadata = JSON.parse(String((init.body as FormData).get('metadata'))) as Record<string, unknown>
            return new Promise<Response>((resolve) => {
                release = resolve
            })
        })
        controllers.push(controller)
        await controller.restore()
        await controller.createManual()
        await controller.importPages(async () => [photo])
        const pending = controller.parse()
        await vi.waitFor(() => expect(metadata).toBeDefined())
        controller.cancel()
        release?.(
            new Response(
                JSON.stringify({
                    status: 'ok',
                    mode: 'model',
                    binding: metadata!.binding,
                    requestId: metadata!.requestId,
                    value: parsed(controller.current!.session.pages[0]!.pageId),
                }),
            ),
        )
        await pending
        expect(controller.current?.session.rawExtraction).toBeNull()
        expect(controller.getSnapshot().pending).toBeNull()
    })
})
