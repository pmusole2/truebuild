import { describe, expect, it, vi } from 'vitest'
import { createDemoManual, type ScreenContextInputsV2 } from '@truebuild/contracts'
import type { ModelApiClient } from '../../api/model-client'
import { DocumentStore, localDocument } from './store'

it('aborts pending Reading documents and refuses a late completion after the person stops', async () => {
    const reading: ScreenContextInputsV2 = {
        kind: 'reading',
        session: createDemoManual(),
        stepId: null,
        captureId: null,
        result: null,
        failure: 'provider_error',
        uiState: { reading: { cancellation: 'confirm-before-stop' }, failure: { notice: true } },
    }
    let signal: AbortSignal | undefined
    let requestId = ''
    const late = Promise.withResolvers<Awaited<ReturnType<ModelApiClient['screensV2']>>>()
    const screensV2 = vi.fn<ModelApiClient['screensV2']>((metadata, options) => {
        signal = options.signal
        requestId = metadata.requestId
        return late.promise
    })
    const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'cancel-reading' })
    try {
        expect(store.request(reading).status).toBe('pending')
        expect(screensV2).toHaveBeenCalledOnce()
        store.cancelReading(reading.session!.manualId)
        expect(signal?.aborted).toBe(true)
        expect(store.peek(reading)).toBeUndefined()
        const published = vi.fn()
        const stop = store.subscribe(published)
        late.resolve({
            status: 'ok',
            requestId,
            mode: 'fixture',
            value: { document: localDocument(reading, 'timeout'), documents: [], progress: null },
        })
        await late.promise
        // The store registered its transport continuation before this await. Let that chain finish through the
        // next event-loop turn, rather than guessing how many promise reactions its validation needs.
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(store.peek(reading)).toBeUndefined()
        expect(published).not.toHaveBeenCalled()
        expect(screensV2).toHaveBeenCalledOnce()
        stop()
    } finally {
        store.dispose()
    }
})

describe('recorded initial states in full mode', () => {
    it('shows the actual stopped Pages document immediately without waiting for a new generation', () => {
        const session = createDemoManual()
        const stopped: ScreenContextInputsV2 = {
            kind: 'pages',
            session,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: {
                cancelled: { reading: true },
                pages: {
                    items: session.pages.map(({ pageId, width, height }) => ({ pageId, width, height })),
                    maxPages: 20,
                    canRead: true,
                    languageOptions: ['en', 'es'],
                },
            },
        }
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(() => new Promise(() => undefined))
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'stopped-pages' })
        try {
            const shown = store.request(stopped)
            expect(shown.status).toBe('ready')
            expect(shown.document.metadata.evidence).toBe('synthetic-fixture')
            expect(shown.document.metadata.authoring?.fixtureId).toBe('recorded-pages-cancelled-sol-v1')
            expect(shown.document.requirements.notice).toBe(true)
            expect(screensV2).not.toHaveBeenCalled()
        } finally {
            store.dispose()
        }
    })
})
