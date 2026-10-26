import { createDemoManual, manualSessionSchema, type ManualSession } from '@truebuild/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'
import { askModelQuestion, citedPageIds, runModelCheck, type ModelCheckRequest } from './model-check'
import type { ApiResult, CheckResult, QuestionResult } from '@truebuild/contracts'
import type { StoredPageAsset } from '../../storage/manual-store.types'
import type { Observation } from './observation'

const observation: Observation = {
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/jpeg',
    width: 4,
    height: 3,
    uri: 'file:///tmp/obs.jpg',
}

function clientWith(fetch: ModelFetch): ModelApiClient {
    return new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', token: 'owner-token-for-tests', fetch })
}

function request(
    session: ManualSession,
    client: ModelApiClient,
    loadPageAsset: ModelCheckRequest['loadPageAsset'],
): ModelCheckRequest {
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === 'step-1')
    if (step === undefined) {
        throw new Error('fixture step missing')
    }
    return {
        client,
        requestId: 'check-1',
        binding: {
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: 'step-1',
            captureId: 'capture-1',
        },
        session,
        step,
        observation,
        loadPageAsset,
        signal: new AbortController().signal,
    }
}

describe('citedPageIds', () => {
    it('returns the pages the reviewed step cites, sorted and unique', () => {
        const session = createDemoManual()
        const step = session.reviewedSteps.find((candidate) => candidate.stepId === 'step-1')
        expect(step).toBeDefined()
        expect(citedPageIds(session, step!)).toEqual(['demo-page-1'])
    })
})

describe('runModelCheck', () => {
    it('sends nothing when the stored page image for a cited page is missing', async () => {
        const fetch = vi.fn<ModelFetch>()
        const session = createDemoManual()

        const result = await runModelCheck(request(session, clientWith(fetch), () => Promise.resolve(null)))

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(fetch).not.toHaveBeenCalled()
    })

    it('sends nothing when the step would cite more than two pages', async () => {
        const fetch = vi.fn<ModelFetch>()
        const base = createDemoManual()
        const extra = [1, 2, 3].map((index) => ({
            pageId: `extra-${index}`,
            assetId: `extra-asset-${index}`,
            width: 100,
            height: 100,
            mimeType: 'image/jpeg' as const,
            contentHash: 'b'.repeat(64),
        }))
        const session = manualSessionSchema.parse({ ...base, pages: [...base.pages, ...extra] })
        const step = session.reviewedSteps.find((candidate) => candidate.stepId === 'step-1')!
        const cited = {
            ...step,
            sourceRefs: [
                { pageId: 'demo-page-1', region: null },
                { pageId: 'extra-1', region: null },
                { pageId: 'extra-2', region: null },
            ],
        }
        const widened = { ...session, reviewedSteps: [cited] }

        const result = await runModelCheck({
            ...request(widened, clientWith(fetch), () => Promise.resolve(null)),
            step: cited,
        })

        expect(result).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(fetch).not.toHaveBeenCalled()
    })
})

describe('complete model action deadline', () => {
    afterEach((): void => {
        vi.clearAllTimers()
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it.each(['check', 'question'] as const)(
        'includes seven seconds of source loading in the eight-second %s budget',
        async (action) => {
            vi.useFakeTimers()
            let releaseSource: (asset: StoredPageAsset) => void = (): void => undefined
            let releaseFetch: (response: Response) => void = (): void => undefined
            const fetch = vi.fn<ModelFetch>(
                () =>
                    new Promise<Response>((resolve): void => {
                        releaseFetch = resolve
                    }),
            )
            const session = createDemoManual()
            const spec = request(
                session,
                clientWith(fetch),
                () =>
                    new Promise<StoredPageAsset>((resolve): void => {
                        releaseSource = resolve
                    }),
            )
            const settled: ApiResult<CheckResult | QuestionResult>[] = []
            const work =
                action === 'check'
                    ? runModelCheck(spec)
                    : askModelQuestion({
                          ...spec,
                          question: 'Which way?',
                          target: { kind: 'part', partId: 'side-panel' },
                      })
            void work.then((result): void => {
                settled.push(result)
            })
            await vi.advanceTimersByTimeAsync(7000)
            releaseSource({ assetId: 'demo-asset-1', mimeType: 'image/png', bytes: new Uint8Array([4, 5, 6]) })
            await vi.advanceTimersByTimeAsync(0)
            expect(fetch).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(1001)

            expect(settled).toMatchObject([{ status: 'unavailable', code: 'timeout', retryable: true }])
            let cancelled = false
            releaseFetch(
                new Response(
                    new ReadableStream<Uint8Array>({
                        cancel(): void {
                            cancelled = true
                        },
                    }),
                ),
            )
            await vi.advanceTimersByTimeAsync(0)
            expect(cancelled).toBe(true)
            expect(fetch).toHaveBeenCalledTimes(1)
        },
    )

    it('dispatches zero requests when preparation crosses the absolute deadline before timer callbacks', async () => {
        let now = 100
        vi.spyOn(performance, 'now').mockImplementation((): number => now)
        const fetch = vi.fn<ModelFetch>().mockResolvedValue(new Response('', { status: 502 }))
        const session = createDemoManual()
        const result = await runModelCheck(
            request(session, clientWith(fetch), async (): Promise<StoredPageAsset> => {
                now += 8001
                return { assetId: 'demo-asset-1', mimeType: 'image/png', bytes: new Uint8Array([4, 5, 6]) }
            }),
        )

        expect(result).toMatchObject({ status: 'unavailable', code: 'timeout' })
        expect(fetch).not.toHaveBeenCalled()
    })
})
