import { describe, expect, it, vi } from 'vitest'
import { createDemoManual, type ScreenContextInputsV2 } from '@truebuild/contracts'
import type { ScreensV2Result } from '@truebuild/contracts/model'
import { documentUnavailable } from '../../api/document-client'
import type { ModelApiClient } from '../../api/model-client'
import { DocumentStore } from './store'
const session = createDemoManual()
const inputs: ScreenContextInputsV2 = {
    kind: 'reading',
    session,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
}
describe('v2 warm-up adoption and failure recovery', () => {
    it('shares the destination flight and retains its complete failure fallback without automatic retries', async () => {
        let finish: ((result: ScreensV2Result) => void) | undefined
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                }),
        )
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'warm' })
        store.warmup([inputs])
        const adopted = store.request(inputs)
        expect(adopted.status).toBe('pending')
        expect(screensV2).toHaveBeenCalledTimes(1)
        finish?.(documentUnavailable(screensV2.mock.calls[0]![0].requestId, 'provider_error'))
        await vi.waitFor(() => expect(store.peek(inputs)?.status).toBe('ready'))
        expect(store.peek(inputs)?.document.metadata.source).toBe('fallback')
        expect(store.peek(inputs)?.issue).toBe('provider_error')
        expect(store.request(inputs)).toBe(store.peek(inputs))
        expect(screensV2).toHaveBeenCalledTimes(1)
        store.retry(inputs)
        store.request(inputs)
        expect(screensV2).toHaveBeenCalledTimes(2)
        store.dispose()
    })
    it('does not dispatch reading warmup in off/steps modes and does not invent a step result', () => {
        for (const mode of ['off', 'steps'] as const) {
            const screensV2 = vi.fn<ModelApiClient['screensV2']>()
            const store = new DocumentStore({ client: { screensV2 }, mode, id: (): string => 'warm' })
            store.warmup([inputs])
            expect(screensV2).not.toHaveBeenCalled()
            expect(store.peek(inputs)?.document.metadata.source).toBe('fallback')
            expect(store.peek({ ...inputs, kind: 'result', captureId: 'unseen' })).toBeUndefined()
            store.dispose()
        }
    })
})
