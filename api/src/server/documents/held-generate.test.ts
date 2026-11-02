import { buildFallbackProposalV2, type ScreenContextInputsV2, type ScreenDocumentV2 } from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'

import { encodeWireProposal } from '../../providers/document-wire'
import type { ScreenGeneration, VerifiedCallTelemetry } from '../../providers/meta-provider'
import { documentInputs } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import { ConcurrencyGate, ModelCallCounter } from '../budget'
import { RequestStoppedError } from '../deadline'
import { createBackgroundWork } from '../model-service'
import type { BackgroundWork } from '../screens/service'
import { ScreenCache } from '../screens/store'
import { buildDocumentContext } from './context'
import { createDocumentService, type CachedDocument, type DocumentFixtureGenerator } from './service'

/**
 * A foreground `generate` that is still waiting on the model is held by the request that asked for it. When that request
 * goes away (the client aborted its fetch: the person left the screen, stopped a reading), the server must stop the work
 * nobody is waiting for, keep nothing from it, and give back the capacity slot. `cancel` is group-only by design (it
 * stops the precompute job); the disconnect is what stops a held foreground request.
 */
const policy = aiPolicyFromEnvironment(
    {},
    {
        checkTimeoutMs: 8_000,
        parseModel: 'muse-spark-1.3',
        verdictModel: 'muse-spark-1.3',
        secondOpinionModel: 'muse-wonder-1.0',
    },
)
const inputs = documentInputs('home')
const wireFor = (forInputs: ScreenContextInputsV2): unknown =>
    encodeWireProposal(buildFallbackProposalV2(buildDocumentContext(forInputs).material))
const goodWire = (): unknown => wireFor(inputs)

/** Counts the capacity slots taken and given back. */
function countingWork(): { work: BackgroundWork; taken: () => number; returned: () => number } {
    let taken = 0
    let returned = 0
    return {
        work: {
            run: (_options, job) => job(),
            repair: (job) => job(),
            tryAcquire: () => {
                taken += 1
                return () => {
                    returned += 1
                }
            },
            acquire: async () => {
                taken += 1
                return () => {
                    returned += 1
                }
            },
        },
        taken: () => taken,
        returned: () => returned,
    }
}

/** A generator that stays pending until it is told to answer or its signal aborts, and remembers every signal. */
function heldGenerator(): { generator: DocumentFixtureGenerator; signals: AbortSignal[]; answer: () => void } {
    const signals: AbortSignal[] = []
    const waiting: (() => void)[] = []
    return {
        signals,
        answer: () => waiting.splice(0).forEach((release) => release()),
        generator: (_request, signal) =>
            new Promise((resolve, reject) => {
                signals.push(signal)
                waiting.push(() => resolve(goodWire()))
                signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            }),
    }
}

describe('a held foreground generate follows its request', () => {
    it('stops the model work when its only request goes away, keeps nothing and returns the slot', async () => {
        const counted = countingWork()
        const held = heldGenerator()
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: held.generator,
            policy,
            runtimeMode: 'fixture',
            work: counted.work,
        })
        const request = new AbortController()
        const pending = service.generate(inputs, request.signal)
        const settled = expect(pending).rejects.toBeInstanceOf(RequestStoppedError)
        await vi.waitFor(() => expect(held.signals).toHaveLength(1))
        expect(held.signals[0]!.aborted).toBe(false)

        request.abort(new RequestStoppedError('cancelled'))
        await settled
        // The work nobody waits for is stopped, not left to finish in the background.
        await vi.waitFor(() => expect(held.signals[0]!.aborted).toBe(true))
        await vi.waitFor(() => expect(counted.returned()).toBe(counted.taken()))
        expect(counted.taken()).toBe(1)

        // Nothing of the abandoned run was kept: asking again starts the model work again and publishes its document.
        const next = service.generate(inputs)
        await vi.waitFor(() => expect(held.signals).toHaveLength(2))
        held.answer()
        const document = await next
        expect(document.metadata.source).toBe('generated')
        expect(document.metadata.cacheHit).toBe(false)
        expect(held.signals[1]!.aborted).toBe(false)
    })

    it('keeps shared work alive for the request still waiting, and stops it when the last one leaves', async () => {
        const held = heldGenerator()
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: held.generator,
            policy,
            runtimeMode: 'fixture',
            work: countingWork().work,
        })
        const first = new AbortController()
        const second = new AbortController()
        const one = service.generate(inputs, first.signal)
        const two = service.generate(inputs, second.signal)
        const leftFirst = expect(one).rejects.toBeInstanceOf(RequestStoppedError)
        await vi.waitFor(() => expect(held.signals).toHaveLength(1))

        first.abort(new RequestStoppedError('cancelled'))
        await leftFirst
        expect(held.signals[0]!.aborted).toBe(false)
        held.answer()
        expect((await two).metadata.source).toBe('generated')
        expect(held.signals).toHaveLength(1)

        // A later request that is the only waiter and leaves stops its own, fresh work.
        const other = documentInputs('add')
        const third = new AbortController()
        const lone = service.generate(other, third.signal)
        const leftAlone = expect(lone).rejects.toBeInstanceOf(RequestStoppedError)
        await vi.waitFor(() => expect(held.signals).toHaveLength(2))
        third.abort(new RequestStoppedError('cancelled'))
        await leftAlone
        await vi.waitFor(() => expect(held.signals[1]!.aborted).toBe(true))
    })

    it('hands the abort to a live provider call too, and still caches nothing', async () => {
        const counted = countingWork()
        const received: (AbortSignal | undefined)[] = []
        let answers = 0
        const service = createDocumentService({
            provider: {
                generateDocument: (_input: unknown, signal?: AbortSignal) =>
                    new Promise((resolve, reject) => {
                        received.push(signal)
                        const call = ++answers
                        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
                        if (call > 1) {
                            resolve({
                                value: goodWire(),
                                telemetry: {
                                    stage: 'screens',
                                    model: 'muse-spark-1.3',
                                    effort: 'max',
                                    timeToProviderMs: 1,
                                    providerMs: 5,
                                    parseValidateMs: 1,
                                    totalMs: 8,
                                    paceWaitMs: 0,
                                    networkMs: 3,
                                    bodyMs: 2,
                                    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 },
                                } satisfies VerifiedCallTelemetry,
                            })
                        }
                    }),
            } as never,
            policy,
            runtimeMode: 'meta',
            work: counted.work,
        })
        const request = new AbortController()
        const pending = service.generate(inputs, request.signal)
        const settled = expect(pending).rejects.toBeInstanceOf(RequestStoppedError)
        await vi.waitFor(() => expect(received).toHaveLength(1))
        request.abort(new RequestStoppedError('cancelled'))
        await settled
        await vi.waitFor(() => expect(received[0]?.aborted).toBe(true))
        await vi.waitFor(() => expect(counted.returned()).toBe(counted.taken()))

        const document = await service.generate(inputs)
        expect(received).toHaveLength(2)
        expect(document.metadata).toMatchObject({ source: 'generated', cacheHit: false, model: 'muse-spark-1.3' })
    })
})

/**
 * Stopping work is a request to the generator, not a guarantee: one that ignores its signal still answers, later. What it
 * answers once nobody is waiting for it (every request gone, or the revision superseded) is not accepted: it is neither
 * published nor cached, and the next request composes afresh.
 */
describe('a late answer to work nobody is waiting for is not accepted', () => {
    const guide = documentInputs('guide')
    const session = guide.session!
    const stepId = guide.stepId!

    /** A generator that ignores its signal entirely and answers only when told to. */
    function deafGenerator(): { generator: DocumentFixtureGenerator; calls: () => number; answer: () => void } {
        const waiting: (() => void)[] = []
        let calls = 0
        return {
            calls: () => calls,
            answer: () => waiting.splice(0).forEach((release) => release()),
            generator: () =>
                new Promise((resolve) => {
                    calls += 1
                    waiting.push(() => resolve(wireFor(guide)))
                }),
        }
    }
    function setup(): {
        counted: ReturnType<typeof countingWork>
        deaf: ReturnType<typeof deafGenerator>
        cache: ScreenCache<CachedDocument>
        service: ReturnType<typeof createDocumentService>
    } {
        const counted = countingWork()
        const deaf = deafGenerator()
        const cache = new ScreenCache<CachedDocument>()
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: deaf.generator,
            policy,
            runtimeMode: 'fixture',
            work: counted.work,
            cache,
        })
        return { counted, deaf, cache, service }
    }
    /** The generated guide document these inputs compose to (what a late answer would publish), from a control service. */
    async function composed(): Promise<ScreenDocumentV2> {
        const control = createDocumentService({
            provider: null,
            fixtureGenerator: async () => wireFor(guide),
            policy,
            runtimeMode: 'fixture',
            work: countingWork().work,
        })
        const document = await control.generate(guide)
        expect(document.metadata.source).toBe('generated')
        return document
    }
    const issued = (service: ReturnType<typeof createDocumentService>, document: ScreenDocumentV2): boolean =>
        service.resolveStepScreen(session, stepId, {
            screenId: document.screenId,
            contextKey: document.bound.contextKey,
        }) !== null

    it('keeps nothing of it once the last request has gone, and the next request composes afresh', async () => {
        const { counted, deaf, cache, service } = setup()
        const late = await composed()
        const request = new AbortController()
        const pending = service.generate(guide, request.signal)
        const settled = expect(pending).rejects.toBeInstanceOf(RequestStoppedError)
        await vi.waitFor(() => expect(deaf.calls()).toBe(1))
        request.abort(new RequestStoppedError('cancelled'))
        await settled

        // It answers anyway, after the last request left.
        deaf.answer()
        await vi.waitFor(() => expect(counted.returned()).toBe(1))
        expect(cache.size).toBe(0)
        expect(issued(service, late)).toBe(false)

        const next = service.generate(guide)
        await vi.waitFor(() => expect(deaf.calls()).toBe(2))
        deaf.answer()
        const document = await next
        expect(document.metadata).toMatchObject({ source: 'generated', cacheHit: false })
        expect(deaf.calls()).toBe(2)
        // Work somebody did wait for is kept.
        expect(cache.size).toBe(1)
        expect(issued(service, late)).toBe(true)
    })

    it('does not hand a superseded revision the late answer, and keeps nothing of it', async () => {
        const { counted, deaf, cache, service } = setup()
        const late = await composed()
        const waiting = service.generate(guide)
        await vi.waitFor(() => expect(deaf.calls()).toBe(1))

        // A newer revision is seen: the older one's work is stopped, but this generator does not notice.
        expect(service.observe(session.manualId, session.revision + 1)).toBe(true)
        deaf.answer()
        const document = await waiting
        expect(document.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'stale' })
        await vi.waitFor(() => expect(counted.returned()).toBe(1))
        expect(cache.size).toBe(0)
        expect(issued(service, late)).toBe(false)
    })

    it('does not cache an answer whose last request left just as it was handed back', async () => {
        const request = new AbortController()
        const cache = new ScreenCache<CachedDocument>()
        const counted = countingWork()
        const telemetry: VerifiedCallTelemetry = {
            stage: 'step-pages',
            model: 'muse-spark-1.3',
            effort: 'max',
            timeToProviderMs: 1,
            providerMs: 5,
            parseValidateMs: 1,
            totalMs: 8,
            paceWaitMs: 0,
            networkMs: 3,
            bodyMs: 2,
            usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 },
        }
        const service = createDocumentService({
            provider: { generateDocument: async () => ({ value: wireFor(guide), telemetry }) } as never,
            policy,
            runtimeMode: 'meta',
            cache,
            work: {
                ...counted.work,
                // The request goes away just as the finished work is returned to the service.
                run: async (_options, job) => {
                    const made = await job()
                    request.abort(new RequestStoppedError('cancelled'))
                    return made
                },
            },
        })
        await expect(service.generate(guide, request.signal)).rejects.toBeInstanceOf(RequestStoppedError)
        await vi.waitFor(() => expect(counted.returned()).toBe(1))
        expect(cache.size).toBe(0)
    })
})

describe('generation deadlines reject an answer even when its producer ignores cancellation', () => {
    const guide = documentInputs('guide')
    const telemetry: VerifiedCallTelemetry = {
        stage: 'step-pages',
        model: 'muse-spark-1.3',
        effort: 'max',
        timeToProviderMs: 1,
        providerMs: 5,
        parseValidateMs: 1,
        totalMs: 8,
        paceWaitMs: 0,
        networkMs: 3,
        bodyMs: 2,
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 },
    }

    it('starts a new intentional request immediately after the last waiter leaves an abort-ignoring flight', async () => {
        const gate = new ConcurrencyGate(1)
        const signals: AbortSignal[] = []
        let answerOld: (() => void) | undefined
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: async (_request, signal) => {
                signals.push(signal)
                if (signals.length > 1) return wireFor(guide)
                return new Promise((resolve) => {
                    answerOld = (): void => resolve(wireFor(guide))
                })
            },
            policy,
            runtimeMode: 'fixture',
            work: createBackgroundWork(new ModelCallCounter(4), gate),
        })
        const waiter = new AbortController()
        const old = service.generate(guide, waiter.signal)
        const left = old.catch((error: unknown) => error)
        expect(signals).toHaveLength(1)
        waiter.abort(new RequestStoppedError('cancelled'))
        expect(await left).toBeInstanceOf(RequestStoppedError)
        try {
            const fresh = await service.generate(guide)
            expect(signals).toHaveLength(2)
            expect(fresh.metadata).toMatchObject({ source: 'generated', cacheHit: false })
            expect(signals[0]!.aborted).toBe(true)
            expect(gate.active).toBe(0)
        } finally {
            answerOld?.()
        }
    })

    it('returns a fixture timeout and releases capacity before the deaf producer answers, then starts fresh work', async () => {
        const gate = new ConcurrencyGate(1)
        const cache = new ScreenCache<CachedDocument>()
        const signals: AbortSignal[] = []
        let answerLate: (() => void) | undefined
        let outcome: ScreenDocumentV2 | undefined
        // Give the late answer a distinct, valid identity so a fresh accepted document cannot hide its publication.
        const lateProposal = buildFallbackProposalV2(buildDocumentContext(guide).material)
        if (lateProposal.body.type !== 'Scroll') throw new Error('expected_scroll')
        lateProposal.body.children.push({
            type: 'Text',
            content: { kind: 'literal', text: 'Safety' },
            role: 'heading',
            emphasis: 'normal',
            tone: 'neutral',
            align: 'start',
        })
        const lateWire = encodeWireProposal(lateProposal)
        const control = createDocumentService({
            provider: null,
            fixtureGenerator: async () => lateWire,
            policy,
            runtimeMode: 'fixture',
            work: createBackgroundWork(new ModelCallCounter(1), new ConcurrencyGate(1)),
        })
        const undelivered = await control.generate(guide)
        expect(undelivered.metadata.source).toBe('generated')
        const shortPolicy = {
            ...policy,
            stages: { ...policy.stages, 'step-pages': { ...policy.stages['step-pages'], deadlineMs: 20 } },
        }
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: async (_request, signal) => {
                signals.push(signal)
                if (signals.length > 1) return wireFor(guide)
                return new Promise((resolve) => {
                    answerLate = (): void => resolve(lateWire)
                })
            },
            policy: shortPolicy,
            runtimeMode: 'fixture',
            cache,
            work: createBackgroundWork(new ModelCallCounter(4), gate),
        })
        const pending = service.generate(guide).then((document) => {
            outcome = document
            return document
        })
        try {
            await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true))
            await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 200 })
            expect(outcome!.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'timeout' })
            expect(gate.active).toBe(0)
            expect(cache.size).toBe(0)
            const issuedLate = (): boolean =>
                service.resolveStepScreen(guide.session!, guide.stepId!, {
                    screenId: undelivered.screenId,
                    contextKey: undelivered.bound.contextKey,
                }) !== null
            expect(issuedLate()).toBe(false)

            // The old producer is still pending: it must not keep a flight or capacity slot for this next request.
            const fresh = await service.generate(guide)
            expect(signals).toHaveLength(2)
            expect(fresh.metadata).toMatchObject({ source: 'generated', cacheHit: false })
            expect(cache.size).toBe(1)

            answerLate!()
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(issuedLate()).toBe(false)
            expect(cache.size).toBe(1)
            const hit = await service.generate(guide)
            expect(hit.metadata.cacheHit).toBe(true)
            expect(hit.screenId).toBe(fresh.screenId)
        } finally {
            answerLate?.()
            await pending
        }
    })

    it('stops the per-call signal and never issues late output after the real background work deadline wins', async () => {
        const gate = new ConcurrencyGate(1)
        const counter = new ModelCallCounter(4)
        const realWork = createBackgroundWork(counter, gate)
        const cache = new ScreenCache<CachedDocument>()
        const signals: AbortSignal[] = []
        let answerLate: (() => void) | undefined
        const provider = {
            generateDocument: async (_input: unknown, signal?: AbortSignal): Promise<ScreenGeneration> => {
                signals.push(signal!)
                if (signals.length > 1) return { value: wireFor(guide), telemetry }
                return new Promise<{ value: unknown; telemetry: VerifiedCallTelemetry }>((resolve) => {
                    answerLate = (): void => resolve({ value: wireFor(guide), telemetry })
                })
            },
        }
        const service = createDocumentService({
            provider,
            policy,
            runtimeMode: 'meta',
            cache,
            work: {
                ...realWork,
                // Exercise the actual work deadline/counter/effect gate with a bounded test budget.
                run: (options, job) => realWork.run({ ...options, deadlineMs: 20 }, job),
            },
        })
        const control = createDocumentService({
            provider: { generateDocument: async () => ({ value: wireFor(guide), telemetry }) },
            policy,
            runtimeMode: 'meta',
            work: createBackgroundWork(new ModelCallCounter(1), new ConcurrencyGate(1)),
        })
        const expected = await control.generate(guide)
        const issued = (): boolean =>
            service.resolveStepScreen(guide.session!, guide.stepId!, {
                screenId: expected.screenId,
                contextKey: expected.bound.contextKey,
            }) !== null
        const document = await service.generate(guide)
        try {
            expect(document.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'timeout' })
            expect(gate.active).toBe(0)
            expect(cache.size).toBe(0)
            expect(issued()).toBe(false)
            expect(signals[0]!.aborted).toBe(true)

            answerLate!()
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(issued()).toBe(false)
            expect(cache.size).toBe(0)

            const fresh = await service.generate(guide)
            expect(fresh.metadata).toMatchObject({ source: 'generated', cacheHit: false })
            expect(signals).toHaveLength(2)
            expect(counter.used).toBe(2)
            expect(issued()).toBe(true)
        } finally {
            answerLate?.()
        }
    })
})
