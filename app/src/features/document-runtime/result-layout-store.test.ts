import { describe, expect, it, vi } from 'vitest'
import {
    isNonfactualVariantV2,
    nodeFactIdsV2,
    variantsOfV2,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
} from '@truebuild/contracts'
import { documentMatchesInputs } from '../../api/document-client'
import { fixtureDocuments } from '../screens/test-support/fixture-server'
import resultRuntime from '../documents/recorded-layouts/recorded-result-layout-sol-v1.runtime.json'
import { DocumentStore } from './store'
import { answerContext, checkContext } from './test-support/result-layout-inputs'

describe('progressive authored result composition through the real model client', () => {
    it.each([checkContext, answerContext])(
        'shows current truth while one exact request is held, then replaces it',
        async (context) => {
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const server = fixtureDocuments({ generated: ['result', 'answer'], gate })
            const store = new DocumentStore({
                client: server,
                mode: 'full',
                id: (): string => 'progressive',
                now: (): number => 1234,
            })
            const inputs = context()
            try {
                const first = store.request(inputs)
                expect(first.status).toBe('ready')
                expect(first.document.metadata.source).toBe('generated')
                expect(first.document.metadata.authoring?.model).toBe('gpt-6.1-sol')
                expect(first.exactGeneration).toBe('pending')
                expect(store.readyAt(inputs)).toBeNull()
                store.retry(inputs)
                expect(store.request(inputs)).toBe(first)
                let settled = false
                const waiting = store.waitForGenerated(inputs).then((value) => {
                    settled = true
                    return value
                })
                await vi.waitFor(() => expect(server.requests).toHaveLength(1))
                expect(settled).toBe(false)
                release()
                const exact = await waiting
                expect(exact).not.toBeNull()
                expect(exact?.screenId).not.toBe(first.document.screenId)
                expect(documentMatchesInputs(exact!, inputs)).toBe(true)
                expect(store.peek(inputs)?.exactGeneration).toBeUndefined()
                expect(store.readyAt(inputs)).toBe(1234)
                expect(server.requests).toHaveLength(1)
            } finally {
                store.dispose()
                release()
            }
        },
    )

    it('retains the authored truth and observed failure without inventing a receipt', async () => {
        const server = fixtureDocuments({ generated: ['result'], failing: ['result'] })
        const store = new DocumentStore({ client: server, mode: 'full', id: (): string => 'failed' })
        const inputs = checkContext('reversed')
        try {
            const first = store.request(inputs)
            expect(await store.waitForGenerated(inputs)).toBeNull()
            expect(store.peek(inputs)).toEqual({
                status: 'ready',
                document: first.document,
                issue: 'provider_error',
                exactGeneration: 'unavailable',
            })
            expect(store.readyAt(inputs)).toBeNull()
            expect(server.requests).toHaveLength(1)
        } finally {
            store.dispose()
        }
    })

    it.each([checkContext, answerContext])(
        'a held factual layout %# cannot donate generated credit to another Guide preview',
        (context) => {
            const server = fixtureDocuments({ failing: ['result', 'answer'] })
            const store = new DocumentStore({ client: server, mode: 'full', id: (): string => 'donor-boundary' })
            const inputs = context()
            try {
                const donor = store.request(inputs).document
                expect(donor.kind).toBe(inputs.kind)
                expect(donor.metadata.source).toBe('generated')
                const manualFacts = new Set(
                    donor.facts.filter((fact) => fact.basis !== 'result').map((fact) => fact.factId),
                )
                for (const variant of variantsOfV2(donor).filter((item) => item.name !== 'ready')) {
                    const stated: string[] = []
                    visitVariantNodesV2(variant.variant, variant.prefix, ({ node }) =>
                        stated.push(...nodeFactIdsV2(node)),
                    )
                    expect(stated.some((factId) => manualFacts.has(factId))).toBe(true)
                    expect(isNonfactualVariantV2(variant.variant)).toBe(false)
                }
                const guide: ScreenContextInputsV2 = {
                    ...inputs,
                    kind: 'guide',
                    stepId: 'step-2',
                    captureId: null,
                    result: null,
                    uiState: undefined,
                }
                const preview = store.preview(guide)
                expect(preview.document.kind).toBe('guide')
                expect(preview.document.bound.stepId).toBe('step-2')
                expect(preview.document.metadata.source).toBe('fallback')
                expect(preview.document.metadata.carried ?? {}).toEqual({})
                expect(Object.values(preview.document.metadata.origins).every((origin) => origin === 'fallback')).toBe(
                    true,
                )
                expect(documentMatchesInputs(preview.document, guide)).toBe(true)
            } finally {
                store.dispose()
            }
        },
    )

    it.each([false, true])(
        'explicit retry after unavailability starts one fresh exact request; retry failure=%s',
        async (retryFails) => {
            let failing = true
            let gate: Promise<void> | undefined
            let release = (): void => undefined
            let id = 0
            const server = fixtureDocuments({
                generated: ['result'],
                get failing() {
                    return failing ? ['result' as const] : []
                },
                get gate() {
                    return gate
                },
            })
            const store = new DocumentStore({ client: server, mode: 'full', id: (): string => `retry-${++id}` })
            const inputs = checkContext('reversed')
            try {
                const authored = store.request(inputs).document
                expect(await store.waitForGenerated(inputs)).toBeNull()
                expect(store.peek(inputs)?.exactGeneration).toBe('unavailable')
                failing = retryFails
                gate = new Promise<void>((resolve) => {
                    release = resolve
                })
                store.retry(inputs)
                const retried = store.request(inputs)
                expect(retried.document).toEqual(authored)
                expect(retried.exactGeneration).toBe('pending')
                expect(retried.issue).toBeNull()
                expect(store.readyAt(inputs)).toBeNull()
                store.retry(inputs)
                expect(store.request(inputs)).toBe(retried)
                const waiting = store.waitForGenerated(inputs)
                await vi.waitFor(() => expect(server.requests).toHaveLength(2))
                expect(new Set(server.requests.map((request) => request.contextKey)).size).toBe(1)
                expect(new Set(server.requests.map((request) => request.requestId)).size).toBe(2)
                release()
                const exact = await waiting
                if (retryFails) {
                    expect(exact).toBeNull()
                    expect(store.peek(inputs)).toEqual({
                        status: 'ready',
                        document: retried.document,
                        issue: 'provider_error',
                        exactGeneration: 'unavailable',
                    })
                    expect(store.readyAt(inputs)).toBeNull()
                } else {
                    expect(exact?.screenId).not.toBe(authored.screenId)
                    expect(documentMatchesInputs(exact!, inputs)).toBe(true)
                    expect(store.peek(inputs)?.exactGeneration).toBeUndefined()
                    expect(store.readyAt(inputs)).not.toBeNull()
                }
                expect(server.requests).toHaveLength(2)
            } finally {
                store.dispose()
                release()
            }
        },
    )

    it('an actual API fallback response cannot replace the authored result or claim generated receipt time', async () => {
        const server = fixtureDocuments()
        const store = new DocumentStore({ client: server, mode: 'full', id: (): string => 'fallback' })
        const inputs = answerContext()
        try {
            const first = store.request(inputs)
            expect(await store.waitForGenerated(inputs)).toBeNull()
            expect(store.peek(inputs)).toEqual({
                status: 'ready',
                document: first.document,
                issue: 'fixture',
                exactGeneration: 'unavailable',
            })
            expect(store.readyAt(inputs)).toBeNull()
        } finally {
            store.dispose()
        }
    })

    it('a late old revision or capture cannot overwrite the current exact result', async () => {
        let release!: () => void
        const server = fixtureDocuments({
            generated: ['result'],
            gate: new Promise<void>((resolve) => {
                release = resolve
            }),
        })
        const store = new DocumentStore({
            client: server,
            mode: 'full',
            id: (() => {
                let id = 0
                return (): string => String(++id)
            })(),
        })
        const old = checkContext('reversed')
        const next = checkContext('correct')
        next.session!.revision++
        next.captureId = 'new-current-photo'
        next.uiState = {
            capture: { captureId: next.captureId, reusable: true, target: null, questionDraftPresent: false },
        }
        try {
            store.request(old)
            const waitingOld = store.waitForGenerated(old)
            store.request(next)
            expect(await waitingOld).toBeNull()
            expect(store.peek(old)).toBeUndefined()
            const waitingNext = store.waitForGenerated(next)
            await vi.waitFor(() => expect(server.requests).toHaveLength(2))
            release()
            const document = await waitingNext
            expect(documentMatchesInputs(document!, next)).toBe(true)
            expect(document?.bound.captureId).toBe('new-current-photo')
            expect(store.peek(next)?.document).toBe(document)
            expect(store.peek(old)).toBeUndefined()
        } finally {
            store.dispose()
            release()
        }
    })

    it('pending exact requests hold warmup slots, release them on unavailability, and do not restart after disposal', async () => {
        let release!: () => void
        const server = fixtureDocuments({
            generated: ['answer'],
            failing: ['result'],
            gate: new Promise<void>((resolve) => {
                release = resolve
            }),
        })
        const store = new DocumentStore({
            client: server,
            mode: 'full',
            id: (): string => 'warm',
            warmupConcurrency: 1,
        })
        try {
            store.warmup([checkContext(), answerContext()])
            await vi.waitFor(() => expect(server.requests).toHaveLength(1))
            expect(store.peek(answerContext())).toBeUndefined()
            release()
            await vi.waitFor(() => expect(server.requests).toHaveLength(2))
            expect(store.peek(checkContext())?.exactGeneration).toBe('unavailable')
            await vi.waitFor(() => expect(store.peek(answerContext())?.exactGeneration).toBeUndefined())
        } finally {
            store.dispose()
            release()
        }

        let releaseDisposed!: () => void
        const heldServer = fixtureDocuments({
            generated: ['result', 'answer'],
            gate: new Promise<void>((resolve) => {
                releaseDisposed = resolve
            }),
        })
        const disposed = new DocumentStore({
            client: heldServer,
            mode: 'full',
            id: (): string => 'disposed',
            warmupConcurrency: 1,
        })
        disposed.warmup([checkContext(), answerContext()])
        await vi.waitFor(() => expect(heldServer.requests).toHaveLength(1))
        const waiting = disposed.waitForGenerated(checkContext())
        disposed.dispose()
        expect(await waiting).toBeNull()
        releaseDisposed()
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(heldServer.requests).toHaveLength(1)
        expect(disposed.getCacheUsage().entries).toBe(0)
    })

    it.each(['off', 'steps'] as const)('mode %s neither uses a result template nor calls the model', async (mode) => {
        const server = fixtureDocuments({ generated: ['result', 'answer'] })
        const store = new DocumentStore({ client: server, mode, id: (): string => mode })
        try {
            for (const inputs of [checkContext(), answerContext()]) {
                expect(store.request(inputs).document.metadata.fallbackReason).toBe('disabled')
                expect(await store.waitForGenerated(inputs)).toBeNull()
            }
            expect(server.requests).toHaveLength(0)
        } finally {
            store.dispose()
        }
    })

    it('the explicit protocol opt-out bypasses the layout while preserving the exact request', async () => {
        let release!: () => void
        const server = fixtureDocuments({
            generated: ['result'],
            gate: new Promise<void>((resolve) => {
                release = resolve
            }),
        })
        const store = new DocumentStore({
            client: server,
            mode: 'full',
            id: (): string => 'opt-out',
            recordings: (): null => null,
        })
        try {
            const first = store.request(checkContext())
            expect(first.status).toBe('pending')
            expect(first.document.metadata.source).toBe('fallback')
            expect(first.exactGeneration).toBeUndefined()
            await vi.waitFor(() => expect(server.requests).toHaveLength(1))
        } finally {
            store.dispose()
            release()
        }
    })

    it('a genuine compiler hash refusal leaves truthful pending fallback and still requests exact composition', async () => {
        vi.resetModules()
        vi.doMock('../documents/recorded-layouts/recorded-result-layout-sol-v1.runtime.json', () => ({
            default: { ...resultRuntime, templateSha256: '0'.repeat(64) },
        }))
        const { DocumentStore: IsolatedStore } = await import('./store')
        const server = fixtureDocuments({ generated: ['result'] })
        const store = new IsolatedStore({ client: server, mode: 'full', id: (): string => 'bounded' })
        const inputs = checkContext()
        try {
            const first = store.request(inputs)
            expect(first.status).toBe('pending')
            expect(first.document.metadata.source).toBe('fallback')
            expect(first.document.metadata.fallbackReason).toBe('busy')
            expect(first.issue).toBeNull()
            expect(first.exactGeneration).toBeUndefined()
            expect((await store.waitForGenerated(inputs))?.metadata.source).toBe('generated')
            expect(server.requests).toHaveLength(1)
        } finally {
            store.dispose()
            vi.doUnmock('../documents/recorded-layouts/recorded-result-layout-sol-v1.runtime.json')
            vi.resetModules()
        }
    })
})
