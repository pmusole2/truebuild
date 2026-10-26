import type { ApiResult, CaptureBinding, SegmentEvent } from '@truebuild/contracts'
import { MODEL_SEGMENT_TIMEOUT_MS, type ModelApiClient } from '../../api/model-client'
import { awaitStopped, createCallGuard, unavailableResult } from '../../api/transport'
import { observationForSegmentation, type Observation } from './observation'
import { observationImage, stoppedResult } from './model-check'

export type LocateRequest = {
    readonly client: ModelApiClient
    readonly requestId: string
    readonly binding: CaptureBinding
    readonly prompt: string
    readonly observation: Observation
    readonly signal: AbortSignal
}

/**
 * Finds the named part in the one frozen photo. Image preparation failures end the stream as unavailable, so the
 * caller never sees an empty or fabricated result for a photo that could not be prepared.
 */
export async function* locateInPhoto(request: LocateRequest): AsyncGenerator<ApiResult<SegmentEvent>, void, void> {
    const guard = createCallGuard(MODEL_SEGMENT_TIMEOUT_MS, request.signal)
    const clientLifetime = new AbortController()
    const stopClient = (): void => clientLifetime.abort()
    guard.signal.addEventListener('abort', stopClient, { once: true })
    let iterator: AsyncGenerator<ApiResult<SegmentEvent>, void, void> | undefined
    let closing: Promise<void> | undefined
    let terminal = false

    function closeClient(): Promise<void> {
        stopClient()

        if (closing === undefined) {
            closing =
                iterator === undefined ? Promise.resolve() : iterator.return(undefined).then((): void => undefined)
            void closing.catch((): void => undefined)
        }

        return closing
    }

    try {
        guard.checkpoint()
        const prepared = await awaitStopped(observationForSegmentation(request.observation), guard.signal)
        guard.checkpoint()
        iterator = request.client.segments(
            request.binding,
            request.prompt,
            new Date().toISOString(),
            observationImage(prepared),
            { requestId: request.requestId, signal: clientLifetime.signal, checkpoint: guard.checkpoint },
        )

        for (;;) {
            guard.checkpoint()
            const next = await awaitStopped(iterator.next(), guard.signal)
            guard.checkpoint()

            if (next.done) {
                await awaitStopped(closeClient(), guard.signal)
                guard.checkpoint()
                terminal = true
                guard.dispose()
                yield unavailableResult(request.requestId, request.binding, 'invalid_output', false)
                return
            }

            const result = next.value

            if (result.status === 'unavailable' || result.value.type !== 'snapshot') {
                await awaitStopped(closeClient(), guard.signal)
                guard.checkpoint()
                terminal = true
                guard.dispose()
                yield result
                return
            }

            yield result
        }
    } catch {
        if (!terminal) {
            try {
                await awaitStopped(closeClient(), guard.signal)
            } catch {
                /* Cancellation cannot wait for an ignored cleanup promise. */
            }
            guard.dispose()
            yield stoppedResult<SegmentEvent>(
                request.requestId,
                request.binding,
                guard.callerAborted() ? 'caller' : guard.timedOut() ? 'timeout' : 'invalid_input',
            )
        }
    } finally {
        try {
            await awaitStopped(closeClient(), guard.signal)
        } catch {
            /* A stopped action cannot wait for an ignored cleanup promise. */
        }
        guard.dispose()
        guard.signal.removeEventListener('abort', stopClient)
    }
}
