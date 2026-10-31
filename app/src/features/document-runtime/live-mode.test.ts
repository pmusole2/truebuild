import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ScreenContextInputsV2 } from '@truebuild/contracts'
import type { ModelApiClient } from '../../api/model-client'
import { documentUnavailable } from '../../api/document-client'
import { recordedDocument } from './recorded-runtime'
import { DocumentStore } from './store'
import { answerContext, checkContext } from './test-support/result-layout-inputs'

const home: ScreenContextInputsV2 = {
    kind: 'home',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    uiState: { library: { entries: [], soleManualId: null } },
}
const contexts = [
    home,
    checkContext(),
    answerContext(),
    { ...checkContext(), kind: 'questions', result: null },
] as const

const fixtureFlags = ['EXPO_PUBLIC_RELEASE_FIXTURE', 'EXPO_PUBLIC_DOCUMENT_FIXTURES'] as const

beforeEach(() => {
    for (const flag of fixtureFlags) vi.stubEnv(flag, undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('explicit fixture boundary', () => {
    it.each(fixtureFlags.flatMap((name) => [undefined, '', '0', 'true'].map((value) => ({ name, value }))))(
        'requires exact fixture opt-in, $name=$value',
        async ({ name, value }) => {
            vi.stubEnv(name, value)
            const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) =>
                documentUnavailable(metadata.requestId, 'timeout'),
            )
            const recordings = vi.fn(recordedDocument)
            const store = new DocumentStore({
                client: { screensV2 },
                mode: 'full',
                id: (): string => 'live',
                recordings,
            })
            try {
                for (const context of contexts) {
                    const entry = store.request(context)
                    expect(entry.status).toBe('pending')
                    expect(entry.document.metadata).toMatchObject({
                        source: 'fallback',
                        evidence: 'local-deterministic',
                        fallbackReason: 'busy',
                        model: null,
                        effort: null,
                    })
                    expect(entry.document.metadata.authoring).toBeUndefined()
                    expect(entry.exactGeneration).toBeUndefined()
                }
                expect(recordings).not.toHaveBeenCalled()
                expect(screensV2).toHaveBeenCalledTimes(contexts.length)
                await vi.waitFor(() => {
                    for (const context of contexts) {
                        expect(store.peek(context)?.status).toBe('ready')
                        expect(store.peek(context)?.document.metadata.fallbackReason).toBe('timeout')
                        expect(store.peek(context)?.document.metadata.source).toBe('fallback')
                        expect(store.peek(context)?.document.metadata.authoring).toBeUndefined()
                    }
                })
            } finally {
                store.dispose()
            }
        },
    )

    it.each(fixtureFlags)('retains recorded launch and layout documents only with explicit %s opt-in', (flag) => {
        vi.stubEnv(flag, '1')
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(() => new Promise(() => {}))
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'fixture' })
        try {
            for (const context of contexts) {
                const entry = store.request(context)
                expect(entry.status).toBe('ready')
                expect(entry.document.metadata.evidence).toBe('synthetic-fixture')
                expect(entry.document.metadata.authoring?.fixtureId).toBeTypeOf('string')
                expect(entry.document.metadata.fallbackReason).toBeNull()
            }
            // Result and Answer still collect an exact response; launch Home and the stable Question do not.
            expect(screensV2).toHaveBeenCalledTimes(2)
        } finally {
            store.dispose()
        }
    })
})
