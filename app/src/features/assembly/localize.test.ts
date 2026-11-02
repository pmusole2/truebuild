import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, CaptureBinding, SegmentEvent } from '@truebuild/contracts'
import { ModelApiClient } from '../../api/model-client'
import type { StreamFetch } from '../../api/stream-fetch'
import { locateInPhoto, type LocateRequest } from './localize'
import { observationForSegmentation, type Observation } from './observation'

vi.mock('./observation', () => ({ observationForSegmentation: vi.fn() }))

const binding: CaptureBinding = {
    kind: 'capture',
    manualId: 'demo-divider',
    revision: 1,
    stepId: 'step-1',
    captureId: 'capture-1',
}
const observation: Observation = {
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/jpeg',
    width: 4,
    height: 3,
    uri: 'synthetic-observation',
}

function request(streamFetch: StreamFetch, signal = new AbortController().signal): LocateRequest {
    return {
        client: new ModelApiClient({
            baseUrl: 'https://localize.invalid',
            secret: 'public-demo-key-for-tests',
            streamFetch,
            fetch: async (): Promise<never> => {
                throw new Error('Only the injected stream belongs to localization tests.')
            },
        }),
        requestId: 'localize-1',
        binding,
        prompt: 'side panel',
        observation,
        signal,
    }
}

afterEach((): void => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('localization action lifetime', () => {
    it('shares thirty seconds across downsampling and a transport that ignores abort', async () => {
        vi.useFakeTimers()
        let releasePreparation: (value: Observation) => void = (): void => undefined
        let releaseFetch: (value: Response) => void = (): void => undefined
        vi.mocked(observationForSegmentation).mockImplementation(
            () =>
                new Promise<Observation>((resolve): void => {
                    releasePreparation = resolve
                }),
        )
        const fetch = vi.fn<StreamFetch>(
            () =>
                new Promise<Response>((resolve): void => {
                    releaseFetch = resolve
                }),
        )
        const iterator = locateInPhoto(request(fetch))
        const settled: IteratorResult<ApiResult<SegmentEvent>, void>[] = []
        void iterator.next().then((value): void => {
            settled.push(value)
        })
        await vi.advanceTimersByTimeAsync(29_000)
        releasePreparation(observation)
        await vi.advanceTimersByTimeAsync(0)
        expect(fetch).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1001)

        expect(settled).toMatchObject([{ done: false, value: { status: 'unavailable', code: 'timeout' } }])
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
        expect((await iterator.next()).done).toBe(true)
    })

    it('closes the client iterator at completion and never emits another terminal on a late resume', async () => {
        let now = 100
        vi.spyOn(performance, 'now').mockImplementation((): number => now)
        vi.mocked(observationForSegmentation).mockResolvedValue(observation)
        const transportSignals: AbortSignal[] = []
        const event: ApiResult<SegmentEvent> = {
            status: 'ok',
            requestId: 'localize-1',
            binding,
            mode: 'model',
            value: { type: 'completed' },
        }
        const fetch = vi.fn<StreamFetch>((_url, init): Promise<Response> => {
            if (init.signal) {
                transportSignals.push(init.signal)
            }

            return Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller): void {
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
                            controller.close()
                        },
                    }),
                ),
            )
        })
        const iterator = locateInPhoto(request(fetch))
        const first = await iterator.next()

        expect(first).toMatchObject({ done: false, value: { status: 'ok', value: { type: 'completed' } } })
        expect(transportSignals[0]?.aborted).toBe(true)
        now += 30_001
        expect((await iterator.next()).done).toBe(true)
    })

    it('settles caller cancellation during ignored downsampling as invalid input without dispatch', async () => {
        vi.mocked(observationForSegmentation).mockImplementation(() => new Promise<Observation>((): void => undefined))
        const caller = new AbortController()
        const fetch = vi.fn<StreamFetch>()
        const iterator = locateInPhoto(request(fetch, caller.signal))
        const pending = iterator.next()
        caller.abort()

        expect(await pending).toMatchObject({ done: false, value: { status: 'unavailable', code: 'invalid_input' } })
        expect(fetch).not.toHaveBeenCalled()
        expect((await iterator.next()).done).toBe(true)
    })

    it('rejects a buffered completion after preparation and a paused snapshot consume the action budget', async () => {
        let now = 100
        vi.spyOn(performance, 'now').mockImplementation((): number => now)
        vi.mocked(observationForSegmentation).mockImplementation(async (): Promise<Observation> => {
            now += 29_000
            return observation
        })
        const values: SegmentEvent[] = [
            {
                type: 'snapshot',
                snapshot: {
                    binding,
                    streamId: 'synthetic-stream',
                    capturedAt: '2026-01-01T00:00:00.000Z',
                    frameIndex: 0,
                    records: [],
                    complete: true,
                },
            },
            { type: 'completed' },
        ]
        const body = values
            .map(
                (value): string =>
                    `data: ${JSON.stringify({
                        status: 'ok',
                        requestId: 'localize-1',
                        binding,
                        mode: 'model',
                        value,
                    })}\n\n`,
            )
            .join('')
        const fetch = vi.fn<StreamFetch>().mockResolvedValue(new Response(body))
        const iterator = locateInPhoto(request(fetch))

        expect(await iterator.next()).toMatchObject({ value: { status: 'ok', value: { type: 'snapshot' } } })
        now += 1001
        expect(await iterator.next()).toMatchObject({ value: { status: 'unavailable', code: 'timeout' } })
        expect((await iterator.next()).done).toBe(true)
    })

    it('aborts and closes the client stream when a snapshot consumer returns', async () => {
        vi.mocked(observationForSegmentation).mockResolvedValue(observation)
        const signals: AbortSignal[] = []
        let cancelled = false
        const value: SegmentEvent = {
            type: 'snapshot',
            snapshot: {
                binding,
                streamId: 'synthetic-stream',
                capturedAt: '2026-01-01T00:00:00.000Z',
                frameIndex: 0,
                records: [],
                complete: true,
            },
        }
        const fetch = vi.fn<StreamFetch>((_url, init): Promise<Response> => {
            if (init.signal) {
                signals.push(init.signal)
            }

            return Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller): void {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    `data: ${JSON.stringify({
                                        status: 'ok',
                                        requestId: 'localize-1',
                                        binding,
                                        mode: 'model',
                                        value,
                                    })}\n\n`,
                                ),
                            )
                        },
                        cancel(): void {
                            cancelled = true
                        },
                    }),
                ),
            )
        })
        const iterator = locateInPhoto(request(fetch))
        expect(await iterator.next()).toMatchObject({ value: { status: 'ok', value: { type: 'snapshot' } } })
        expect((await iterator.return(undefined)).done).toBe(true)
        expect(signals[0]?.aborted).toBe(true)
        expect(cancelled).toBe(true)
    })
})
