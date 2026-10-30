import { describe, expect, it, vi, type Mock } from 'vitest'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    screenDocumentV2Schema,
    SCREEN_KINDS_V2,
    type ScreenKindV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ManualSession,
} from '@truebuild/contracts'
import type { ScreensV2Result } from '@truebuild/contracts/model'
import {
    documentJobContextKey,
    documentPrecomputeInputs,
    documentUnavailable,
    inputsFromDocumentMetadata,
} from '../../api/document-client'
import type { ModelApiClient } from '../../api/model-client'
import { sha256Hex } from '../documents/sha256'
import { DOCUMENT_CACHE_MAX_BYTES, DOCUMENT_COLLECTION_DEADLINE_MS, DocumentStore, localDocument } from './store'

const session = createDemoManual()
const inputs: ScreenContextInputsV2 = {
    kind: 'guide',
    session,
    stepId: 'step-1',
    captureId: null,
    result: null,
    failure: null,
}
const fixture = (request: ScreenContextInputsV2): ScreenDocumentV2 => {
    const material = documentMaterialV2(request)
    return screenDocumentV2Schema.parse(
        assembleDocumentV2(
            material,
            buildFallbackProposalV2(material),
            {
                source: 'generated',
                evidence: 'synthetic-fixture',
                fallbackReason: null,
            },
            { sha256Hex, now: () => new Date('2026-01-01T00:00:00Z') },
        ),
    )
}
const ok = (document: ScreenDocumentV2, requestId: string): Extract<ScreensV2Result, { status: 'ok' }> => ({
    status: 'ok' as const,
    requestId,
    mode: 'fixture' as const,
    value: { document, documents: [], progress: null },
})
const successful = (): Mock<ModelApiClient['screensV2']> =>
    vi.fn<ModelApiClient['screensV2']>(async (metadata) =>
        ok(fixture(inputsFromDocumentMetadata(metadata)), metadata.requestId),
    )

describe('whole-document runtime store', () => {
    it('serves the initial recorded Home synchronously without a network request or provider receipt', () => {
        const screensV2 = successful()
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        const home: ScreenContextInputsV2 = {
            kind: 'home',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { library: { entries: [], soleManualId: null } },
        }
        try {
            const entry = store.request(home)
            expect(entry.status).toBe('ready')
            expect(entry.document.metadata).toMatchObject({
                source: 'generated',
                evidence: 'synthetic-fixture',
                model: null,
                authoring: { model: 'gpt-6.1-sol', effort: 'ultra' },
            })
            expect(store.readyAt(home)).toBeNull()
            expect(screensV2).not.toHaveBeenCalled()
        } finally {
            store.dispose()
        }
    })

    it('uses the real asynchronous generation protocol when the supplied recording resolver has no match', async () => {
        const screensV2 = successful()
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'id',
            recordings: (): null => null,
        })
        const home: ScreenContextInputsV2 = {
            kind: 'home',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { library: { entries: [], soleManualId: null } },
        }
        try {
            expect(store.request(home).status).toBe('pending')
            await vi.waitFor(() => expect(store.peek(home)?.status).toBe('ready'))
            expect(store.peek(home)?.document.metadata.source).toBe('generated')
            expect(store.readyAt(home)).toBeTypeOf('number')
            expect(screensV2).toHaveBeenCalledTimes(1)
            expect(screensV2.mock.calls[0]![0]).toMatchObject({ op: 'generate', kind: 'home' })
        } finally {
            store.dispose()
        }
    })

    it('keeps an individually oversized local document complete and uncached without dispatching or occupying a warmup flight', () => {
        const screensV2 = successful()
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'id',
            maxDocumentBytes: 1,
        })
        const entry = store.request(inputs)
        expect(entry.status).toBe('ready')
        expect(entry.issue).toBe('budget_exhausted')
        expect(screenDocumentV2Schema.safeParse(entry.document).success).toBe(true)
        expect(store.getCacheUsage()).toEqual({ entries: 0, documents: 0, documentBytes: 0, limitBytes: 1 })
        store.warmup([inputs, { ...inputs, stepId: 'step-2' }])
        expect(screensV2).not.toHaveBeenCalled()
        store.dispose()
    })
    it('bounds unique serialized document bytes, evicts least recently used payloads and keeps only a small shown-guide witness', async () => {
        const contexts: ScreenContextInputsV2[] = [
            inputs,
            { ...inputs, stepId: 'step-2' },
            { ...inputs, uiState: { busy: { activity: 'working' } } },
        ]
        const sizes = contexts.map((context) => new TextEncoder().encode(JSON.stringify(fixture(context))).byteLength)
        const budget = Math.max(sizes[0]! + sizes[1]!, sizes[0]! + sizes[2]!, sizes[1]! + sizes[2]!)
        const screensV2 = successful()
        let next = 0
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => String(next++),
            maxDocumentBytes: budget,
        })
        const land = async (context: ScreenContextInputsV2): Promise<void> => {
            store.request(context)
            await vi.waitFor(() => expect(store.peek(context)?.document.metadata.source).toBe('generated'))
        }
        try {
            await land(contexts[0]!)
            const shown = store.peek(inputs)!.document
            store.noteShown(shown, true)
            await land(contexts[1]!)
            store.peek(inputs) // This actual cache read makes guide1 the most recently used payload.
            await land(contexts[2]!)
            expect(store.peek(contexts[1]!)).toBeUndefined()
            expect(store.getCacheUsage()).toEqual({
                entries: 2,
                documents: 2,
                documentBytes: sizes[0]! + sizes[2]!,
                limitBytes: budget,
            })
            await land(contexts[1]!)
            expect(store.peek(inputs)).toBeUndefined()
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(budget)
            expect(store.shownGuide(session, 'step-1')).toEqual({
                screenId: shown.screenId,
                contextKey: shown.bound.contextKey,
            })
            expect(DOCUMENT_CACHE_MAX_BYTES).toBe(32 * 1_024 * 1_024)
        } finally {
            store.dispose()
        }
    })

    it('publishes a terminal cache-pressure cause when an in-flight entry is evicted, then permits an explicit new request', () => {
        const next = { ...inputs, stepId: 'step-2' }
        const size = (value: ScreenContextInputsV2): number =>
            new TextEncoder().encode(JSON.stringify(localDocument(value, 'busy'))).byteLength
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(() => new Promise(() => undefined))
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'id',
            maxDocumentBytes: Math.max(size(inputs), size(next)) + 64,
        })
        const changed = vi.fn()
        store.subscribe(changed)
        try {
            store.request(inputs)
            const firstSignal = screensV2.mock.calls[0]![1].signal
            store.request(next)
            expect(firstSignal?.aborted).toBe(true)
            expect(store.peek(inputs)).toBeUndefined()
            expect(store.cacheIssue(inputs)).toBe('budget_exhausted')
            expect(changed).toHaveBeenCalled()
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(store.getCacheUsage().limitBytes)
            expect(store.request(inputs).status).toBe('pending')
            expect(store.cacheIssue(inputs)).toBeNull()
            expect(screensV2).toHaveBeenCalledTimes(3)
        } finally {
            store.dispose()
        }
    })

    it('stops successful but slow background collection at the elapsed deadline without cancelling server generation', async () => {
        vi.useFakeTimers()
        const common = { session }
        const expected = documentPrecomputeInputs(common)
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) => {
            await new Promise((resolve) => setTimeout(resolve, 9000))
            return {
                status: 'ok',
                requestId: metadata.requestId,
                mode: 'fixture',
                value: {
                    document: null,
                    documents: [],
                    progress: {
                        manualId: session.manualId,
                        revision: session.revision,
                        contextKey: documentJobContextKey(common),
                        mode: 'full',
                        items: expected.map((item) => ({
                            key: item.key,
                            kind: item.inputs.kind,
                            stepId: item.inputs.stepId,
                            state: 'running',
                            screenId: null,
                        })),
                    },
                },
            }
        })
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        try {
            expect(DOCUMENT_COLLECTION_DEADLINE_MS).toBe(120000)
            store.precompute(session, null)
            await vi.advanceTimersByTimeAsync(120000 + 20000)
            const calls = screensV2.mock.calls.length
            expect(screensV2.mock.calls[0]![1].signal?.aborted).toBe(true)
            await vi.advanceTimersByTimeAsync(300000)
            expect(screensV2).toHaveBeenCalledTimes(calls)
            expect(screensV2.mock.calls.every(([request]) => request.op !== 'cancel')).toBe(true)
        } finally {
            store.dispose()
            vi.useRealTimers()
        }
    })

    it('supports every kind through complete off documents and bounded warmup without fabricating missing inputs', async () => {
        const actual = (kind: ScreenKindV2): ScreenContextInputsV2 => {
            const stepBound = ['guide', 'result', 'questions', 'answer', 'recovery', 'camera'].includes(kind)
            return {
                kind,
                session: ['home', 'more', 'error', 'judge', 'compare'].includes(kind) ? null : session,
                stepId: stepBound ? 'step-1' : null,
                captureId: ['result', 'answer', 'questions'].includes(kind) ? 'capture-1' : null,
                result:
                    kind === 'result'
                        ? {
                              kind: 'check',
                              value: {
                                  decision: 'cannot_verify',
                                  reason: 'A clearer view is needed.',
                                  sourceRefs: [],
                                  missingEvidence: [],
                                  observedRegion: null,
                              },
                          }
                        : kind === 'answer'
                          ? {
                                kind: 'question',
                                question: 'Which way?',
                                value: {
                                    answer: 'Follow the cited diagram.',
                                    sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                                    missingEvidence: [],
                                },
                            }
                          : null,
                failure: kind === 'error' ? 'timeout' : null,
                uiState: { camera: { mode: 'build-photo', permission: 'granted' }, judge: { builtView: false } },
            }
        }
        const contexts = SCREEN_KINDS_V2.map(actual)
        const screensV2 = successful()
        const off = new DocumentStore({ client: { screensV2 }, mode: 'off', id: (): string => 'id' })
        for (const context of contexts)
            expect(screenDocumentV2Schema.safeParse(off.request(context).document).success).toBe(true)
        expect(screensV2).not.toHaveBeenCalled()
        off.dispose()
        let next = 0
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => String(next++),
            warmupConcurrency: 2,
        })
        store.warmup(contexts)
        expect(screensV2).toHaveBeenCalledTimes(2)
        await vi.waitFor(() => expect(contexts.every((context) => store.peek(context)?.status === 'ready')).toBe(true))
        const recorded = contexts.filter((context) => store.peek(context)?.document.metadata.authoring !== undefined)
        expect(recorded.length).toBeGreaterThan(0)
        expect(screensV2).toHaveBeenCalledTimes(SCREEN_KINDS_V2.length - recorded.length)
        expect(screensV2.mock.calls.map(([metadata]) => metadata.kind).sort()).toEqual(
            contexts
                .filter((context) => !recorded.includes(context))
                .map((context) => context.kind)
                .sort(),
        )
        expect(contexts.every((context) => store.peek(context)?.document.metadata.source === 'generated')).toBe(true)
        store.dispose()
    })
    it('renders a complete pending fallback, shares one flight, publishes and reuses the exact validated document', async () => {
        const screensV2 = successful()
        let clock = 1_000
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'id',
            now: (): number => clock,
        })
        let updates = 0
        store.subscribe(() => {
            updates++
        })
        const pending = store.request(inputs)
        expect(pending.status).toBe('pending')
        expect(store.readyAt(inputs)).toBeNull()
        expect(screenDocumentV2Schema.safeParse(pending.document).success).toBe(true)
        expect(pending.document.metadata).toMatchObject({
            source: 'fallback',
            evidence: 'local-deterministic',
            model: null,
        })
        expect(store.request(inputs)).toBe(pending)
        clock = 2_000
        await vi.waitFor(() => expect(store.peek(inputs)?.document.metadata.source).toBe('generated'))
        expect(store.readyAt(inputs)).toBe(2_000)
        expect(screensV2).toHaveBeenCalledTimes(1)
        expect(store.request(inputs)).toBe(store.peek(inputs))
        clock = 3_000
        expect(store.readyAt(inputs)).toBe(2_000)
        expect(updates).toBeGreaterThan(0)
        store.dispose()
    })

    it('returns complete off/steps fallbacks with zero dispatch and no v1/native-null escape', () => {
        const screensV2 = successful()
        for (const mode of ['off', 'steps'] as const) {
            const store = new DocumentStore({ client: { screensV2 }, mode, id: (): string => 'id' })
            const home: ScreenContextInputsV2 = { ...inputs, kind: 'home', session: null, stepId: null }
            const result = store.request(mode === 'off' ? inputs : home)
            expect(result.status).toBe('ready')
            expect(store.readyAt(mode === 'off' ? inputs : home)).toBeNull()
            expect(screenDocumentV2Schema.safeParse(result.document).success).toBe(true)
            expect(result.document.metadata).toMatchObject({
                source: 'fallback',
                evidence: 'local-deterministic',
                fallbackReason: 'disabled',
            })
            store.dispose()
        }
        expect(screensV2).not.toHaveBeenCalled()
    })

    it('rejects corrupt identity as a complete local fallback and never mints B3 credit', async () => {
        const foreign = fixture({ ...inputs, stepId: 'step-2' })
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) => ok(foreign, metadata.requestId))
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        store.request(inputs)
        await vi.waitFor(() => expect(store.peek(inputs)?.status).toBe('ready'))
        const entry = store.peek(inputs)!
        expect(entry.issue).toBe('invalid_output')
        expect(entry.document.metadata.source).toBe('fallback')
        store.noteShown(entry.document, true)
        expect(store.shownGuide(session, 'step-1')).toBeNull()
        store.dispose()
    })

    it('aborts older revisions and ignores a response from a transport that refuses cancellation', async () => {
        let resolve: ((value: Awaited<ReturnType<ModelApiClient['screensV2']>>) => void) | undefined
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(
            () =>
                new Promise((done) => {
                    resolve = done
                }),
        )
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        store.request(inputs)
        const newer = { ...session, revision: session.revision + 1 }
        store.observeSession(newer)
        expect(screensV2.mock.calls[0]![1].signal?.aborted).toBe(true)
        resolve?.(ok(fixture(inputs), 'documents-id'))
        await Promise.resolve()
        expect(store.peek(inputs)).toBeUndefined()
        expect(store.request(inputs).document.metadata.fallbackReason).toBe('stale')
        store.dispose()
    })

    it('records only focused accepted generated guides and rejects same-revision fact drift for B3', async () => {
        const screensV2 = successful()
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        store.request(inputs)
        await vi.waitFor(() => expect(store.peek(inputs)?.document.metadata.source).toBe('generated'))
        const doc = store.peek(inputs)!.document
        store.noteShown(doc, false)
        expect(store.shownGuide(session, 'step-1')).toBeNull()
        store.noteShown(doc, true)
        expect(store.shownGuide(session, 'step-1')).toEqual({
            screenId: doc.screenId,
            contextKey: doc.bound.contextKey,
        })
        const changed = structuredClone(session)
        changed.title = 'A different manual title'
        expect(store.shownGuide(changed, 'step-1')).toBeNull()
        store.dispose()
    })

    it('collects progressive documents once per exact job and cancels older revision collection', async () => {
        vi.useFakeTimers()
        const common = { session }
        const expected = documentPrecomputeInputs(common)
        const guide = fixture(inputs)
        const screenId = guide.screenId
        const progress = {
            manualId: session.manualId,
            revision: session.revision,
            contextKey: documentJobContextKey(common),
            mode: 'full' as const,
            items: expected.map((item) => ({
                key: item.key,
                kind: item.inputs.kind,
                stepId: item.inputs.stepId,
                state: item.key === 'guide:step-1' ? ('ready' as const) : ('running' as const),
                screenId: item.key === 'guide:step-1' ? screenId : null,
            })),
        }
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) =>
            metadata.op === 'generate'
                ? documentUnavailable(metadata.requestId, 'timeout')
                : {
                      status: 'ok',
                      requestId: metadata.requestId,
                      mode: 'fixture',
                      value: { document: null, documents: metadata.op === 'progress' ? [guide] : [], progress },
                  },
        )
        let id = 0
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => String(id++),
            pollMs: 10,
        })
        try {
            store.request(inputs)
            await vi.advanceTimersByTimeAsync(0)
            expect(store.peek(inputs)?.document.metadata.source).toBe('fallback')
            expect(store.readyAt(inputs)).toBeNull()
            store.precompute(session, 'guide:step-1')
            await vi.advanceTimersByTimeAsync(11)
            expect(store.peek(inputs)?.document).toEqual(guide)
            expect(store.readyAt(inputs)).toBeTypeOf('number')
            expect(store.peek({ ...inputs, stepId: 'step-2' })).toBeUndefined()
            expect(screensV2.mock.calls.map(([metadata]) => metadata.op)).toEqual([
                'generate',
                'precompute',
                'generate',
                'generate',
                'generate',
                'generate',
                'progress',
            ])
            store.precompute(session, 'guide:step-1')
            expect(screensV2).toHaveBeenCalledTimes(7)
            store.observeSession({ ...session, revision: session.revision + 1 })
            await vi.advanceTimersByTimeAsync(100)
            expect(screensV2.mock.calls.map(([metadata]) => metadata.op)).toEqual([
                'generate',
                'precompute',
                'generate',
                'generate',
                'generate',
                'generate',
                'progress',
                'cancel',
            ])
            expect(store.peek(inputs)).toBeUndefined()
            expect(store.readyAt(inputs)).toBeNull()
        } finally {
            store.dispose()
            vi.useRealTimers()
        }
    })

    it('warms only guides in steps mode and admits a changed same-revision manual under a different exact cache key', async () => {
        const screensV2 = successful()
        let id = 0
        const store = new DocumentStore({ client: { screensV2 }, mode: 'steps', id: (): string => String(id++) })
        store.precompute(session, 'guide:step-2')
        expect(screensV2.mock.calls[0]![0]).toMatchObject({ op: 'generate', kind: 'guide', stepId: 'step-2' })
        await vi.waitFor(() => expect(store.peek(inputs)?.status).toBe('ready'))
        expect(
            screensV2.mock.calls.every(([metadata]) => metadata.op === 'generate' && metadata.kind === 'guide'),
        ).toBe(true)
        const changed = structuredClone(session)
        changed.title = 'Changed title'
        const next = { ...inputs, session: changed }
        store.request(next)
        await vi.waitFor(() => expect(store.peek(next)?.status).toBe('ready'))
        expect(store.peek(inputs)).toBeUndefined()
        expect(store.peek(next)?.document.metadata.source).toBe('generated')
        store.invalidateManual(session.manualId, session.revision + 1)
        expect(store.request(next).document.metadata.fallbackReason).toBe('stale')
        store.dispose()
    })

    it('precomputes raw steps with a guide-only selector and refuses a mismatched server mode', async () => {
        vi.useFakeTimers()
        const raw: ManualSession = { ...session, reviewStatus: 'unreviewed', reviewedSteps: [], parts: [] }
        const common = { session: raw, requestedKinds: ['guide'] as const }
        const expected = documentPrecomputeInputs(common)
        const documents = expected.map((item) => fixture(item.inputs))
        try {
            for (const mode of ['steps', 'full'] as const) {
                let id = 0
                const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) => ({
                    status: 'ok',
                    requestId: metadata.requestId,
                    mode: 'fixture',
                    value: {
                        document: null,
                        documents:
                            metadata.op === 'progress'
                                ? documents.filter((doc) => metadata.want.includes(`guide:${doc.bound.stepId}`))
                                : [],
                        progress: {
                            manualId: raw.manualId,
                            revision: raw.revision,
                            contextKey: documentJobContextKey(common),
                            mode,
                            items: expected.map((item, index) => ({
                                key: item.key,
                                kind: item.inputs.kind,
                                stepId: item.inputs.stepId,
                                state: metadata.op === 'precompute' ? 'queued' : 'ready',
                                screenId: metadata.op === 'precompute' ? null : documents[index]!.screenId,
                            })),
                        },
                    },
                }))
                const store = new DocumentStore({
                    client: { screensV2 },
                    mode: 'steps',
                    id: (): string => String(id++),
                    pollMs: 5,
                    maxPolls: 2,
                })
                store.precompute(raw, null)
                await vi.advanceTimersByTimeAsync(20)
                expect(screensV2.mock.calls[0]![0]).toMatchObject({ op: 'precompute', requestedKinds: ['guide'] })
                if (mode === 'steps') {
                    expect(
                        expected.every((item) => store.peek(item.inputs)?.document.metadata.source === 'generated'),
                    ).toBe(true)
                    expect(screensV2.mock.calls.map(([metadata]) => metadata.op)).toEqual([
                        'precompute',
                        'generate',
                        'generate',
                        'generate',
                        'generate',
                        'progress',
                        'progress',
                    ])
                    expect(
                        screensV2.mock.calls.every(([metadata]) =>
                            metadata.op === 'generate'
                                ? metadata.kind === 'guide' &&
                                  ['checking', 'second-opinion'].includes(metadata.uiState?.busy?.activity ?? '')
                                : metadata.requestedKinds?.join() === 'guide',
                        ),
                    ).toBe(true)
                    store.noteShown(documents[0]!, true)
                    expect(store.shownGuide(raw, 'step-1')).toBeNull()
                } else {
                    expect(store.peek(expected[0]!.inputs)).toBeUndefined()
                    expect(
                        screensV2.mock.calls.flatMap(([metadata]) => (metadata.op === 'generate' ? [] : [metadata.op])),
                    ).toEqual(['precompute', 'cancel'])
                    expect(
                        screensV2.mock.calls
                            .flatMap(([metadata]) =>
                                metadata.op === 'generate'
                                    ? [`${metadata.stepId}:${metadata.uiState?.busy?.activity}`]
                                    : [],
                            )
                            .sort(),
                    ).toEqual(['step-1:checking', 'step-1:second-opinion', 'step-2:checking', 'step-2:second-opinion'])
                }
                store.dispose()
            }
        } finally {
            vi.useRealTimers()
        }
    })
})
