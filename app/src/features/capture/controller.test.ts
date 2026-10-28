import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createDemoManual,
    type ApiResult,
    type CheckResult,
    type ManualBinding,
    type ParsedManual,
} from '@truebuild/contracts'
import {
    modelCheckMetadataSchema,
    modelParseMetadataSchema,
    modelSecondOpinionMetadataSchema,
} from '@truebuild/contracts/model'
import { ModelApiClient, type ModelFetch } from '../../api/model-client'
import * as temporaryImages from '../../media/owned-temporary-images'
import { CaptureController, reviewedSession, unresolvedCriticalFacts, type StepFactResolution } from './controller'
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
async function ready(responder?: ModelFetch): Promise<ReturnType<typeof setup>> {
    const runtime = setup(responder)
    controllers.push(runtime.controller)
    await runtime.controller.restore()
    await runtime.controller.createManual()
    await runtime.controller.importPages(async () => [photo])
    await runtime.controller.parse()
    await runtime.controller.confirm()
    return runtime
}

function manualBinding(controller: CaptureController): ManualBinding {
    const { manualId, revision } = controller.current!.session
    return { kind: 'manual', manualId, revision }
}

async function unresolvedReady(
    change: (value: ParsedManual) => void = (): void => undefined,
): Promise<ReturnType<typeof setup>> {
    return ready(async (_url, init): Promise<Response> => {
        const meta = modelParseMetadataSchema.parse(JSON.parse(String((init.body as FormData).get('metadata'))))
        const value = parsed(meta.pages[0]!.pageId)
        value.steps[0]!.orientation = { state: 'unknown', reason: 'Arrow could not be read.' }
        value.steps[0]!.visibleChecks = []
        change(value)
        return Response.json({ status: 'ok', mode: 'model', requestId: meta.requestId, binding: meta.binding, value })
    })
}

const orientationResolution = { partId: 'side-panel', description: 'Groove faces inward.' }

describe('explicit acceptance of missing step facts', () => {
    it('accepts one fact at a time with step citations and still requires whole-manual confirmation', async () => {
        const { controller, store } = await unresolvedReady()
        const before = structuredClone(controller.current!)
        const first = before.session.reviewedSteps[0]!
        expect(
            await controller.acceptStepFacts(manualBinding(controller), first.stepId, {
                orientation: orientationResolution,
            }),
        ).toBe(true)
        expect(controller.current!.session.reviewedSteps[0]!.orientation).toEqual({
            state: 'known',
            value: orientationResolution,
            sourceRefs: first.sourceRefs,
        })
        expect(controller.current!.session.reviewedSteps[0]!.visibleChecks).toEqual([])
        expect(controller.current!.session.revision).toBe(before.session.revision + 1)
        await controller.confirm()
        expect(controller.current!.session.reviewStatus).toBe('unreviewed')
        expect(controller.getSnapshot().notice).toMatch(/critical facts/i)

        expect(
            await controller.acceptStepFacts(manualBinding(controller), first.stepId, {
                visibleChecks: [' Groove is visible. ', 'Panel stands upright.'],
            }),
        ).toBe(true)
        const session = controller.current!.session
        const checks = session.reviewedSteps[0]!.visibleChecks
        expect(checks.map((check) => check.description)).toEqual([
            { state: 'known', value: 'Groove is visible.', sourceRefs: first.sourceRefs },
            { state: 'known', value: 'Panel stands upright.', sourceRefs: first.sourceRefs },
        ])
        expect(new Set(checks.map((check) => check.checkId)).size).toBe(2)
        expect(checks.every((check) => check.checkId.startsWith('test-'))).toBe(true)
        expect(session.rawExtraction).toEqual(before.session.rawExtraction)
        expect(session.reviewStatus).toBe('unreviewed')
        expect((await store.restore()).entries[0]!.session).toEqual(session)
        await controller.confirm()
        expect(controller.current!.session.reviewStatus).toBe('reviewed')
    })

    it('resolves both fields atomically and cannot overwrite either accepted field', async () => {
        const { controller } = await unresolvedReady()
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: orientationResolution,
                visibleChecks: ['Groove is visible.'],
            }),
        ).toBe(true)
        const accepted = structuredClone(controller.current!)
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: { ...orientationResolution, description: 'Changed.' },
                visibleChecks: ['Changed.'],
            }),
        ).toBe(false)
        expect(controller.current).toEqual(accepted)
        expect(controller.getSnapshot().notice).toMatch(/already|missing|unresolved/i)
    })

    it.each<{ label: string; resolution: StepFactResolution }>([
        { label: 'no facts', resolution: {} },
        { label: 'blank orientation', resolution: { orientation: { ...orientationResolution, description: '  ' } } },
        {
            label: 'long orientation',
            resolution: { orientation: { ...orientationResolution, description: 'x'.repeat(501) } },
        },
        { label: 'unknown part', resolution: { orientation: { ...orientationResolution, partId: 'invented' } } },
        {
            label: 'part outside this step',
            resolution: { orientation: { ...orientationResolution, partId: 'divider' } },
        },
        { label: 'empty checks', resolution: { visibleChecks: [] } },
        { label: 'blank check', resolution: { visibleChecks: ['  '] } },
        { label: 'long check', resolution: { visibleChecks: ['x'.repeat(501)] } },
        { label: 'too many checks', resolution: { visibleChecks: Array.from({ length: 101 }, () => 'Visible.') } },
        { label: 'invalid atomic checks', resolution: { orientation: orientationResolution, visibleChecks: [''] } },
    ])('rejects $label without changing facts or revision', async ({ resolution }) => {
        const { controller } = await unresolvedReady()
        const before = structuredClone(controller.current!)
        expect(await controller.acceptStepFacts(manualBinding(controller), 'step-1', resolution)).toBe(false)
        expect(controller.current).toEqual(before)
        expect(controller.getSnapshot().notice).toBeTruthy()
    })

    it('rejects an uncited step without changing its facts or revision', async () => {
        const { controller } = await unresolvedReady((value) => {
            value.steps[0]!.sourceRefs = []
        })
        const before = structuredClone(controller.current!)
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: orientationResolution,
            }),
        ).toBe(false)
        expect(controller.current).toEqual(before)
        expect(controller.getSnapshot().notice).toMatch(/citation/i)
    })

    it('rejects missing steps and stale manual or revision bindings on an otherwise resolvable step', async () => {
        const { controller } = await unresolvedReady()
        const before = structuredClone(controller.current!)
        const binding = manualBinding(controller)
        for (const [candidate, stepId] of [
            [binding, 'missing-step'],
            [{ ...binding, manualId: 'other-manual' }, 'step-1'],
            [{ ...binding, revision: binding.revision - 1 }, 'step-1'],
        ] as const) {
            expect(await controller.acceptStepFacts(candidate, stepId, { orientation: orientationResolution })).toBe(
                false,
            )
            expect(controller.current).toEqual(before)
            expect(controller.getSnapshot().notice).toBeTruthy()
        }
    })

    it('keeps confirmation blocked after checks-only acceptance and after another critical fact remains unresolved', async () => {
        const { controller } = await unresolvedReady((value) => {
            value.steps[0]!.connection = { state: 'unknown', reason: 'Connection is unreadable.' }
        })
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                visibleChecks: ['Groove is visible.'],
            }),
        ).toBe(true)
        expect(controller.current!.session.reviewedSteps[0]!.orientation.state).toBe('unknown')
        await controller.confirm()
        expect(controller.current!.session.reviewStatus).toBe('unreviewed')
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: orientationResolution,
            }),
        ).toBe(true)
        await controller.confirm()
        expect(controller.current!.session.reviewStatus).toBe('unreviewed')
        expect(controller.getSnapshot().notice).toMatch(/critical facts/i)
    })

    it('preserves nonempty unknown checks during orientation acceptance and cannot replace them through the empty-check editor', async () => {
        const { controller } = await unresolvedReady((value) => {
            const check = structuredClone(fixture.reviewedSteps[0]!.visibleChecks[0]!)
            check.description = { state: 'unknown', reason: 'The visible check is unreadable.' }
            value.steps[0]!.visibleChecks = [check]
        })
        const checks = structuredClone(controller.current!.session.reviewedSteps[0]!.visibleChecks)
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: orientationResolution,
            }),
        ).toBe(true)
        expect(controller.current!.session.reviewedSteps[0]!.visibleChecks).toEqual(checks)
        await controller.confirm()
        expect(controller.current!.session.reviewStatus).toBe('unreviewed')
        expect(controller.getSnapshot().notice).toMatch(/critical facts/i)
        const before = structuredClone(controller.current!)
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                visibleChecks: ['Replacement text is not allowed here.'],
            }),
        ).toBe(false)
        expect(controller.current).toEqual(before)
    })

    it('isolates all nested working facts from the preserved raw extraction after parsing', async () => {
        const { controller } = await ready()
        await controller.parse()
        const session = controller.current!.session
        const raw = structuredClone(session.rawExtraction)
        session.parts[0]!.name = { state: 'unknown', reason: 'Working edit.' }
        const step = session.reviewedSteps[0]!
        step.parts[0]!.quantity = { state: 'unknown', reason: 'Working edit.' }
        step.sourceRefs[0]!.region = { x: 0, y: 0, width: 0.5, height: 0.5 }
        if (step.orientation.state === 'known') step.orientation.value.description = 'Working edit.'
        if (step.visibleChecks[0]!.description.state === 'known') {
            step.visibleChecks[0]!.description.value = 'Working edit.'
        }
        step.correction!.actions[0]!.instruction = 'Working edit.'
        expect(session.rawExtraction).toEqual(raw)
    })

    it('clears saved progress, captures, composition and results when facts are accepted', async () => {
        const { controller, store } = await unresolvedReady()
        const entry = controller.current!
        const before = {
            ...entry,
            stepIndex: 1,
            completedStepIds: ['step-1'],
            capture: {
                binding: {
                    ...manualBinding(controller),
                    kind: 'capture' as const,
                    stepId: 'step-2',
                    captureId: 'old-photo',
                },
                page: entry.session.pages[0]!,
                capturedAt: 100,
            },
        }
        await store.save([before])
        await controller.restore()
        await controller.open(entry.session.manualId, 'guide')
        controller.questionChanged('Which edge?')
        controller.targetChanged({ kind: 'point', x: 0.5, y: 0.5 })
        expect(controller.getSnapshot().capture).not.toBeNull()
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: orientationResolution,
            }),
        ).toBe(true)
        expect(controller.current).toMatchObject({ stepIndex: 0, completedStepIds: [], capture: null })
        expect(controller.getSnapshot()).toMatchObject({
            capture: null,
            check: null,
            answer: null,
            question: '',
            target: null,
        })
        expect(controller.current!.session.reviewStatus).toBe('unreviewed')
    })

    it('persists before publishing facts, keeps cancellation atomic, and never restores a departed screen', async () => {
        const { controller, store } = await unresolvedReady()
        const old = structuredClone(controller.current!)
        let finish: (() => Promise<void>) | undefined
        const save = store.save.bind(store)
        vi.spyOn(store, 'save').mockImplementationOnce(
            (entries, writes): Promise<void> =>
                new Promise((resolve, reject) => {
                    finish = async (): Promise<void> => {
                        try {
                            await save(entries, writes)
                            resolve()
                        } catch (error) {
                            reject(error)
                        }
                    }
                }),
        )
        const pending = controller.acceptStepFacts(manualBinding(controller), 'step-1', {
            orientation: orientationResolution,
        })
        expect(controller.current).toEqual(old)
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', { visibleChecks: ['Visible.'] }),
        ).toBe(false)
        controller.cancel()
        expect(controller.getSnapshot().pending).not.toBeNull()
        expect(controller.getSnapshot().notice).toMatch(/finishing.*save/i)
        controller.home()
        await finish!()
        expect(await pending).toBe(true)
        expect(controller.getSnapshot()).toMatchObject({
            route: 'library',
            selectedId: null,
            pending: null,
            notice: null,
        })
        await controller.open(old.session.manualId)
        expect(controller.current!.session.revision).toBe(old.session.revision + 1)
    })

    it('keeps previous facts, revision and progress and locks editing after a failed save', async () => {
        const { controller, store } = await unresolvedReady()
        await controller.completeStep()
        const before = structuredClone(controller.current!)
        vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('Disk unavailable'))
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: orientationResolution,
            }),
        ).toBe(false)
        expect(controller.current).toEqual(before)
        expect(controller.getSnapshot().storageReadOnly).toBe(true)
        expect(controller.getSnapshot().notice).toMatch(/could not save|original library data/i)
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', { visibleChecks: ['Visible.'] }),
        ).toBe(false)
        expect(controller.current).toEqual(before)
        expect((await store.restore()).entries[0]).toEqual(before)
    })

    it('reports a failed acceptance save and locks storage even after navigating away', async () => {
        const { controller, store } = await unresolvedReady()
        const before = structuredClone(controller.current!)
        let fail: ((error: Error) => void) | undefined
        vi.spyOn(store, 'save').mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    fail = reject
                }),
        )
        const pending = controller.acceptStepFacts(manualBinding(controller), 'step-1', {
            orientation: orientationResolution,
        })
        controller.home()
        fail!(new Error('Disk unavailable'))
        expect(await pending).toBe(false)
        expect(controller.getSnapshot().entries[0]).toEqual(before)
        expect(controller.getSnapshot()).toMatchObject({ route: 'library', selectedId: null, storageReadOnly: true })
        expect(controller.getSnapshot().notice).toMatch(/could not save|original library data/i)
    })

    it('cancels a pending older parse without letting its late result replace accepted facts', async () => {
        const { controller } = await unresolvedReady()
        let signal: AbortSignal | undefined
        let deliver: ((result: ApiResult<ParsedManual>) => void) | undefined
        // Hold an already-started parse even after abort, as a provider may still complete remotely.
        const parse = vi
            .spyOn(ModelApiClient.prototype, 'parse')
            .mockImplementationOnce((binding, _pages, _images, options) => {
                signal = options!.signal
                return new Promise((resolve) => {
                    deliver = resolve
                })
            })
        // Both operations target R+1, so the epoch must fence this result even though its binding still matches.
        const oldBinding = { ...manualBinding(controller), revision: controller.current!.session.revision + 1 }
        const pending = controller.parse()
        await vi.waitFor(() => expect(deliver).toBeDefined())
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: orientationResolution,
            }),
        ).toBe(true)
        const accepted = structuredClone(controller.current!)
        expect(signal!.aborted).toBe(true)
        deliver!({
            status: 'ok',
            requestId: 'old-parse',
            mode: 'model',
            binding: oldBinding,
            value: parsed(accepted.session.pages[0]!.pageId),
        })
        await pending
        expect(controller.current).toEqual(accepted)
        expect(controller.getSnapshot().pending).toBeNull()
        parse.mockRestore()
    })

    it('does not let a canceled page import overwrite accepted facts after temporary-image cleanup finishes', async () => {
        const { controller } = await unresolvedReady()
        const manualId = controller.current!.session.manualId
        let finishCleanup: (() => void) | undefined
        const cleanup = vi.spyOn(temporaryImages, 'releaseTemporaryImage').mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishCleanup = resolve
                }),
        )
        try {
            const pendingImport = controller.importPages(async () => [photo])
            await vi.waitFor(() => expect(finishCleanup).toBeDefined())
            controller.home()
            await controller.open(manualId)
            expect(
                await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                    orientation: orientationResolution,
                }),
            ).toBe(true)
            const accepted = structuredClone(controller.current!)
            finishCleanup!()
            await pendingImport
            expect(controller.current).toEqual(accepted)
        } finally {
            finishCleanup?.()
            cleanup.mockRestore()
        }
    })

    it('keeps accepted facts and cleared results when an older check finishes after a new extraction', async () => {
        const { controller } = await ready()
        let deliver: ((result: ApiResult<CheckResult>) => void) | undefined
        let signal: AbortSignal | undefined
        const oldBinding = {
            ...manualBinding(controller),
            kind: 'capture' as const,
            stepId: 'step-1',
            captureId: 'old-photo',
        }
        vi.spyOn(ModelApiClient.prototype, 'check').mockImplementationOnce(
            (binding, _session, _ids, _sources, _photo, options) => {
                Object.assign(oldBinding, binding)
                signal = options!.signal
                return new Promise((resolve) => {
                    deliver = resolve
                })
            },
        )
        controller.camera({ kind: 'check' })
        const pendingCheck = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(deliver).toBeDefined())
        vi.spyOn(ModelApiClient.prototype, 'parse').mockImplementationOnce(
            async (binding): Promise<ApiResult<ParsedManual>> => {
                const value = parsed(controller.current!.session.pages[0]!.pageId)
                value.steps[0]!.orientation = { state: 'unknown', reason: 'Arrow is unreadable.' }
                value.steps[0]!.visibleChecks = []
                return { status: 'ok', mode: 'model', requestId: 'new-parse', binding, value }
            },
        )
        // Navigation cancels the old check; reading again produces unresolved facts for explicit acceptance.
        controller.navigate('overview')
        await controller.parse()
        expect(
            await controller.acceptStepFacts(manualBinding(controller), 'step-1', {
                orientation: orientationResolution,
                visibleChecks: ['Groove is visible.'],
            }),
        ).toBe(true)
        const accepted = structuredClone(controller.current!)
        deliver!({
            status: 'ok',
            mode: 'model',
            requestId: 'old-check',
            binding: oldBinding,
            value: {
                decision: 'pass',
                reason: 'Late old verdict.',
                sourceRefs: accepted.session.reviewedSteps[0]!.sourceRefs,
                observedRegion: null,
                missingEvidence: [],
            },
        })
        await pendingCheck
        await Promise.resolve()
        expect(signal!.aborted).toBe(true)
        expect(controller.current).toEqual(accepted)
        expect(controller.getSnapshot()).toMatchObject({ check: null, answer: null, capture: null, pending: null })
    })
})

async function followupReady(
    options: { decision?: CheckResult['decision']; available?: boolean; primaryDelayMs?: number } = {},
): Promise<{
    controller: CaptureController
    store: LibraryStorage
    forms: FormData[]
    signals: AbortSignal[]
    finish: (value?: CheckResult, status?: number) => void
}> {
    const forms: FormData[] = []
    const signals: AbortSignal[] = []
    let finish = (_value?: CheckResult, _status?: number): void => {
        throw new Error('Secondary has not dispatched')
    }
    const runtime = setup(async (url, init): Promise<Response> => {
        const form = init.body as FormData
        const raw: unknown = JSON.parse(String(form.get('metadata')))
        if (url.endsWith('/parse')) {
            const meta = modelParseMetadataSchema.parse(raw)
            return Response.json({
                status: 'ok',
                mode: 'model',
                requestId: meta.requestId,
                binding: meta.binding,
                value: parsed(meta.pages[0]!.pageId),
            })
        }
        forms.push(form)
        signals.push(init.signal!)
        if (url.endsWith('/second-opinion')) {
            const meta = modelSecondOpinionMetadataSchema.parse(raw)
            return new Promise((resolve) => {
                finish = (value = secondaryResult(), status = 200): void =>
                    resolve(
                        Response.json(
                            {
                                status: 'ok',
                                mode: 'model',
                                requestId: meta.requestId,
                                binding: meta.binding,
                                value,
                            },
                            { status },
                        ),
                    )
            })
        }
        const meta = modelCheckMetadataSchema.parse(raw)
        const decision = options.decision ?? 'cannot_verify'
        if (options.primaryDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, options.primaryDelayMs))
        }
        return Response.json({
            status: 'ok',
            mode: 'model',
            requestId: meta.requestId,
            binding: meta.binding,
            value: {
                decision,
                reason: 'Primary Spark result.',
                sourceRefs: [{ pageId: meta.sourcePageIds[0]!, region: null }],
                observedRegion: null,
                missingEvidence: decision === 'cannot_verify' ? ['Groove is obscured.'] : [],
                model: 'muse-spark-1.3',
                ...(options.available !== false && decision === 'cannot_verify'
                    ? {
                          secondOpinion: { status: 'available', model: 'muse-wonder-1.0', token: 'one-use-ticket' },
                      }
                    : {}),
            },
        })
    })
    controllers.push(runtime.controller)
    await runtime.controller.restore()
    await runtime.controller.createManual()
    await runtime.controller.importPages(async () => [photo])
    await runtime.controller.parse()
    await runtime.controller.confirm()
    return { ...runtime, forms, signals, finish: (value, status): void => finish(value, status) }
}

function secondaryResult(overrides: Partial<CheckResult> = {}): CheckResult {
    return {
        decision: 'cannot_verify',
        reason: 'Primary Spark result.',
        sourceRefs: [],
        observedRegion: null,
        missingEvidence: ['Groove is obscured.'],
        model: 'muse-spark-1.3',
        modelNotes: ['Second opinion could not resolve orientation.'],
        secondOpinion: { status: 'completed', model: 'muse-wonder-1.0' },
        ...overrides,
    }
}

describe('automatic separate second opinion', () => {
    it('publishes primary before dispatch and retains it beyond eight seconds while the follow-up has its own budget', async () => {
        const { controller, forms, finish } = await followupReady({ primaryDelayMs: 7_000 })
        const publications: (CheckResult | null)[] = []
        controller.subscribe(() => {
            publications.push(controller.getSnapshot().check)
        })
        vi.useFakeTimers()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(forms).toHaveLength(1))
        await vi.advanceTimersByTimeAsync(7_000)
        await vi.waitFor(() => expect(forms).toHaveLength(2))
        expect(publications.some((check) => check?.secondOpinion?.status === 'available')).toBe(true)
        expect(controller.getSnapshot().check?.reason).toBe('Primary Spark result.')
        expect(controller.getSnapshot().pending).toMatch(/Second opinion pending/)
        await vi.advanceTimersByTimeAsync(59_000)
        expect(controller.getSnapshot().check?.decision).toBe('cannot_verify')
        finish()
        await pending
        expect(controller.getSnapshot().check?.secondOpinion?.status).toBe('completed')
        expect(controller.getSnapshot().check?.modelNotes).toContain('Second opinion could not resolve orientation.')
        expect(controller.getSnapshot().pending).toBeNull()
        await vi.advanceTimersByTimeAsync(61_000)
        expect(forms).toHaveLength(2)
        expect(controller.getSnapshot().check?.decision).toBe('cannot_verify')
    })

    it('ends a hung follow-up after its own 60 seconds without clearing primary or retrying', async () => {
        const { controller, forms, signals } = await followupReady()
        vi.useFakeTimers()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(forms).toHaveLength(2))
        await vi.advanceTimersByTimeAsync(59_000)
        expect(controller.getSnapshot().pending).toMatch(/Second opinion pending/)
        expect(controller.getSnapshot().check?.reason).toBe('Primary Spark result.')
        await vi.advanceTimersByTimeAsync(1_001)
        await pending
        expect(signals[1]!.aborted).toBe(true)
        expect(controller.getSnapshot().pending).toBeNull()
        expect(controller.getSnapshot().check?.reason).toBe('Primary Spark result.')
        expect(controller.getSnapshot().check?.modelNotes?.join(' ')).toMatch(/timed out after 60 seconds/)
        expect(forms).toHaveLength(2)
    })

    it.each(['cannot_verify', 'pass', 'refuse'] as const)(
        'does not follow up %s without an available ticket',
        async (decision) => {
            const { controller, forms } = await followupReady({ decision, available: false })
            controller.camera({ kind: 'check' })
            await controller.shutter(async () => photo)
            expect(forms).toHaveLength(1)
            expect(controller.getSnapshot().check?.decision).toBe(decision)
        },
    )

    it('reuses the exact primary request identity, session and bytes despite mutations of the visible capture/session', async () => {
        const { controller, forms, finish, store } = await followupReady()
        let readsAfterPrimary = 0
        const read = store.readAsset.bind(store)
        let primaryPublished = false
        vi.spyOn(store, 'readAsset').mockImplementation(async (page) => {
            if (primaryPublished) readsAfterPrimary++
            return read(page)
        })
        const oldByte = image.bytes[0]!
        controller.subscribe(() => {
            if (!primaryPublished && controller.getSnapshot().check !== null) {
                primaryPublished = true
                controller.current!.session.title = 'Changed after the primary request'
                controller.getSnapshot().capture!.observation.bytes[0] = 99
            }
        })
        try {
            controller.camera({ kind: 'check' })
            const pending = controller.shutter(async () => photo)
            await vi.waitFor(() => expect(forms).toHaveLength(2))
            const first: unknown = JSON.parse(String(forms[0]!.get('metadata')))
            const { secondOpinionToken, ...second } = modelSecondOpinionMetadataSchema.parse(
                JSON.parse(String(forms[1]!.get('metadata'))),
            )
            expect(secondOpinionToken).toBe('one-use-ticket')
            expect(second).toEqual(first)
            for (const field of ['source-0', 'observation']) {
                expect(await (forms[1]!.get(field) as Blob).arrayBuffer()).toEqual(
                    await (forms[0]!.get(field) as Blob).arrayBuffer(),
                )
            }
            expect(readsAfterPrimary).toBe(0)
            finish()
            await pending
        } finally {
            image.bytes[0] = oldByte
        }
    })

    it('retains primary on cancellation, aborts the follow-up and discards its late response', async () => {
        const { controller, forms, signals, finish } = await followupReady()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(forms).toHaveLength(2))
        controller.cancel()
        expect(signals[1]!.aborted).toBe(true)
        expect(controller.getSnapshot().check?.reason).toBe('Primary Spark result.')
        expect(controller.getSnapshot().check?.secondOpinion).toEqual({
            status: 'unavailable',
            model: 'muse-wonder-1.0',
        })
        expect(controller.getSnapshot().check?.modelNotes?.join(' ')).toContain('Second opinion cancelled')
        expect(controller.getSnapshot().pending).toBeNull()
        finish(secondaryResult({ reason: 'Late secondary reply' }))
        await pending
        expect(controller.getSnapshot().check?.reason).toBe('Primary Spark result.')
        expect(forms).toHaveLength(2)
    })

    it('does not dispatch when cancelled synchronously after publishing primary', async () => {
        const { controller, forms } = await followupReady()
        let cancelled = false
        controller.subscribe(() => {
            if (!cancelled && controller.getSnapshot().check !== null) {
                cancelled = true
                controller.cancel()
            }
        })
        controller.camera({ kind: 'check' })
        await controller.shutter(async () => photo)
        expect(forms).toHaveLength(1)
        expect(controller.getSnapshot().check?.decision).toBe('cannot_verify')
    })

    it.each(['step', 'revision', 'capture'] as const)('fences a late follow-up after changing %s', async (change) => {
        const { controller, forms, finish } = await followupReady()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(forms).toHaveLength(2))
        if (change === 'revision') controller.current!.session.revision++
        else if (change === 'step') await controller.step(1)
        else {
            controller.cancel()
            controller.camera({ kind: 'question' })
            await controller.shutter(async () => photo)
        }
        finish(secondaryResult({ reason: 'Stale secondary reply' }))
        await pending
        expect(controller.getSnapshot().check?.reason).not.toBe('Stale secondary reply')
    })

    it('never promotes a primary cannot_verify to pass', async () => {
        const { controller, forms, finish } = await followupReady()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(forms).toHaveLength(2))
        finish(
            secondaryResult({
                decision: 'pass',
                reason: 'Secondary claims pass.',
                missingEvidence: [],
                sourceRefs: [{ pageId: controller.current!.session.pages[0]!.pageId, region: null }],
                model: 'muse-wonder-1.0',
            }),
        )
        await pending
        expect(controller.getSnapshot().check?.decision).toBe('cannot_verify')
        expect(controller.getSnapshot().check?.model).toBe('muse-spark-1.3')
        expect(controller.getSnapshot().check?.secondOpinion).toEqual({ status: 'completed', model: 'muse-wonder-1.0' })
        expect(controller.getSnapshot().check?.modelNotes?.join(' ')).toMatch(/cannot.*promote|retained/i)
    })

    it('shows a grounded secondary refusal with its actual producer and citations', async () => {
        const { controller, forms, finish } = await followupReady()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(forms).toHaveLength(2))
        const refusal = secondaryResult({
            decision: 'refuse',
            reason: 'Panel faces outward.',
            orientationAssessment: 'reversed',
            model: 'muse-wonder-1.0',
            sourceRefs: [{ pageId: controller.current!.session.pages[0]!.pageId, region: null }],
        })
        finish(refusal)
        await pending
        expect(controller.getSnapshot().check).toEqual(refusal)
        expect(controller.getSnapshot().pending).toBeNull()
    })

    it('retains the primary and a visible note when the second request fails', async () => {
        const { controller, forms, finish } = await followupReady()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(forms).toHaveLength(2))
        finish(undefined, 500)
        await pending
        expect(controller.getSnapshot().check).toMatchObject({
            decision: 'cannot_verify',
            reason: 'Primary Spark result.',
            model: 'muse-spark-1.3',
            secondOpinion: { status: 'unavailable', model: 'muse-wonder-1.0' },
        })
        expect(controller.getSnapshot().check?.modelNotes?.join(' ')).toMatch(/Second opinion unavailable/)
        expect(forms).toHaveLength(2)
    })
})

describe('real manual workflow with provider-boundary fixture responses', () => {
    it.each(['parse', 'check', 'ask'] as const)(
        'locks the library and retains facts after a %s source read fails',
        async (operation) => {
            const { controller, store, calls } = await ready()
            if (operation === 'ask') {
                controller.camera({ kind: 'question' })
                await controller.shutter(async () => photo)
                controller.questionChanged('Which edge?')
                controller.targetChanged({ kind: 'point', x: 0.5, y: 0.5 })
            }
            const manualId = controller.current!.session.manualId
            const count = calls.length
            vi.spyOn(store, 'readAsset').mockRejectedValueOnce(new Error('Local image unavailable'))
            if (operation === 'parse') await controller.parse()
            else if (operation === 'check') {
                controller.camera({ kind: 'check' })
                await controller.shutter(async () => photo)
            } else await controller.ask()
            expect(controller.getSnapshot().storageReadOnly).toBe(true)
            expect(controller.getSnapshot().notice).toMatch(/local.*library|library.*read/i)
            expect(controller.current!.session.manualId).toBe(manualId)
            expect(calls).toHaveLength(count)
            await controller.createManual()
            expect(controller.current!.session.manualId).toBe(manualId)
        },
    )

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

    it('ignores composition changes during a pending check without aborting or losing its result', async () => {
        let checkMeta: { requestId: string; binding: unknown; sourcePageIds?: string[] } | undefined
        let checkSignal: AbortSignal | undefined
        let finishCheck: ((response: Response) => void) | undefined
        const { controller } = setup(async (url, init): Promise<Response> => {
            const meta = JSON.parse(String((init.body as FormData).get('metadata'))) as {
                requestId: string
                binding: unknown
                pages?: { pageId: string }[]
                sourcePageIds?: string[]
            }
            if (url.endsWith('/checks')) {
                checkMeta = meta
                checkSignal = init.signal ?? undefined
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
                    value: parsed(meta.pages![0]!.pageId),
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
        await vi.waitFor(() => expect(checkMeta).toBeDefined())
        controller.questionChanged('Ignored while checking')
        controller.targetChanged({ kind: 'point', x: 0.5, y: 0.5 })
        expect(checkSignal?.aborted).toBe(false)
        expect(controller.getSnapshot().pending).toBe('Checking frozen photo…')
        expect(controller.getSnapshot().question).toBe('')
        expect(controller.getSnapshot().target).toBeNull()
        finishCheck?.(
            new Response(
                JSON.stringify({
                    status: 'ok',
                    mode: 'model',
                    requestId: checkMeta!.requestId,
                    binding: checkMeta!.binding,
                    value: {
                        decision: 'refuse',
                        reason: 'Panel faces outward.',
                        sourceRefs: [{ pageId: checkMeta!.sourcePageIds![0]!, region: null }],
                        observedRegion: null,
                        missingEvidence: [],
                    },
                }),
                { headers: { 'Content-Type': 'application/json' } },
            ),
        )
        await pending
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
    })

    it('retains delivered verdicts and answers while a question is composed more than eight seconds later', async () => {
        const { controller } = await ready()
        vi.useFakeTimers()
        controller.camera({ kind: 'check' })
        await controller.shutter(async () => photo)
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
        await vi.advanceTimersByTimeAsync(20_000)
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
        controller.questionChanged('Which way?')
        controller.targetChanged({ kind: 'point', x: 0.5, y: 0.5 })
        await controller.ask()
        expect(controller.getSnapshot().answer?.answer).toBe('Check the expected diagram.')
        await vi.advanceTimersByTimeAsync(20_000)
        expect(controller.getSnapshot().check?.decision).toBe('refuse')
        expect(controller.getSnapshot().answer?.answer).toBe('Check the expected diagram.')
    })

    it('preserves a typed question across an ask-photo retake while clearing the old target and answer', async () => {
        const { controller } = await ready()
        controller.camera({ kind: 'question' })
        await controller.shutter(async () => photo)
        controller.questionChanged('Which way should the panel face?')
        controller.targetChanged({ kind: 'point', x: 0.4, y: 0.5 })
        await controller.ask()
        const previous = controller.getSnapshot().capture!.binding.captureId
        controller.camera({ kind: 'question' })
        await controller.shutter(async () => photo)
        expect(controller.getSnapshot().question).toBe('Which way should the panel face?')
        expect(controller.getSnapshot().capture?.binding.captureId).not.toBe(previous)
        expect(controller.getSnapshot().target).toBeNull()
        expect(controller.getSnapshot().answer).toBeNull()
    })

    it('allows noncritical annotations while reporting and blocking actual unresolved critical facts', () => {
        const session = createDemoManual()
        session.rawExtraction = { parts: session.parts, steps: [], unknowns: ['Packaging colour was not readable.'] }
        expect(reviewedSession(session)).not.toBeNull()
        expect(unresolvedCriticalFacts(session)).toEqual([])
        session.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Arrow is not visible.' }
        expect(reviewedSession(session)).toBeNull()
        expect(unresolvedCriticalFacts(session)).toContain('Step 1 orientation: Arrow is not visible.')
    })

    it('binds every successful reparse to a new revision and leaves the old revision intact on failure', async () => {
        const bindings: number[] = []
        let fail = false
        const { controller } = setup(async (_url, init): Promise<Response> => {
            const meta = JSON.parse(String((init.body as FormData).get('metadata'))) as {
                requestId: string
                binding: { revision: number }
                pages: { pageId: string }[]
            }
            bindings.push(meta.binding.revision)
            return new Response(
                JSON.stringify(
                    fail
                        ? {
                              status: 'unavailable',
                              code: 'provider_error',
                              retryable: true,
                              binding: meta.binding,
                              requestId: meta.requestId,
                          }
                        : {
                              status: 'ok',
                              mode: 'model',
                              binding: meta.binding,
                              requestId: meta.requestId,
                              value: parsed(meta.pages[0]!.pageId),
                          },
                ),
                { status: fail ? 503 : 200, headers: { 'Content-Type': 'application/json' } },
            )
        })
        controllers.push(controller)
        await controller.restore()
        await controller.createManual()
        await controller.importPages(async () => [photo])
        const original = controller.current!.session.revision
        await controller.parse()
        expect(controller.current!.session.revision).toBe(original + 1)
        expect(bindings[0]).toBe(controller.current!.session.revision)
        await controller.confirm()
        await controller.parse()
        expect(controller.current!.session.revision).toBe(original + 2)
        expect(bindings[1]).toBe(controller.current!.session.revision)
        expect(controller.current!.session.reviewStatus).toBe('unreviewed')
        fail = true
        await controller.parse()
        expect(controller.current!.session.revision).toBe(original + 2)
        expect(bindings[2]).toBe(original + 3)
    })

    it('ignores a late old ask without clearing a newer pending ask or replacing its answer', async () => {
        const asks: {
            meta: { requestId: string; binding: unknown; sourcePageIds: string[] }
            resolve: (response: Response) => void
        }[] = []
        const { controller } = setup(async (_url, init): Promise<Response> => {
            const meta = JSON.parse(String((init.body as FormData).get('metadata'))) as {
                requestId: string
                binding: unknown
                pages?: { pageId: string }[]
                sourcePageIds: string[]
            }
            if (meta.pages !== undefined) {
                return new Response(
                    JSON.stringify({
                        status: 'ok',
                        mode: 'model',
                        requestId: meta.requestId,
                        binding: meta.binding,
                        value: parsed(meta.pages[0]!.pageId),
                    }),
                    { headers: { 'Content-Type': 'application/json' } },
                )
            }
            return new Promise((resolve) => {
                asks.push({ meta, resolve })
            })
        })
        controllers.push(controller)
        await controller.restore()
        await controller.createManual()
        await controller.importPages(async () => [photo])
        await controller.parse()
        await controller.confirm()
        controller.camera({ kind: 'question' })
        await controller.shutter(async () => photo)
        controller.questionChanged('Old question')
        controller.targetChanged({ kind: 'point', x: 0.1, y: 0.2 })
        const old = controller.ask()
        await vi.waitFor(() => expect(asks).toHaveLength(1))
        controller.questionChanged('New question')
        controller.camera({ kind: 'question' })
        await controller.shutter(async () => photo)
        expect(controller.getSnapshot().question).toBe('New question')
        controller.targetChanged({ kind: 'point', x: 0.3, y: 0.4 })
        const next = controller.ask()
        await vi.waitFor(() => expect(asks).toHaveLength(2))
        expect(asks[1]!.meta.binding).not.toEqual(asks[0]!.meta.binding)
        const answer = (index: number, text: string): Response =>
            new Response(
                JSON.stringify({
                    status: 'ok',
                    mode: 'model',
                    requestId: asks[index]!.meta.requestId,
                    binding: asks[index]!.meta.binding,
                    value: {
                        answer: text,
                        sourceRefs: [{ pageId: asks[index]!.meta.sourcePageIds[0]!, region: null }],
                        missingEvidence: [],
                    },
                }),
                { headers: { 'Content-Type': 'application/json' } },
            )
        asks[0]!.resolve(answer(0, 'Old answer'))
        await old
        expect(controller.getSnapshot().pending).toBe('Asking about frozen photo…')
        expect(controller.getSnapshot().answer).toBeNull()
        asks[1]!.resolve(answer(1, 'New answer'))
        await next
        expect(controller.getSnapshot().answer?.answer).toBe('New answer')
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

    it('does not restore a loading state when a timed-out photo save finishes late', async () => {
        const { controller, calls, store } = setup()
        controllers.push(controller)
        await controller.restore()
        await controller.createManual()
        await controller.importPages(async () => [photo])
        await controller.parse()
        await controller.confirm()
        let finish: (() => void) | undefined
        vi.spyOn(store, 'save').mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve
                }),
        )
        vi.useFakeTimers()
        controller.camera({ kind: 'check' })
        const pending = controller.shutter(async () => photo)
        await vi.waitFor(() => expect(finish).toBeDefined())
        await vi.advanceTimersByTimeAsync(8_001)
        await pending
        expect(controller.getSnapshot().pending).toBeNull()
        finish?.()
        await vi.advanceTimersByTimeAsync(0)
        expect(controller.getSnapshot().pending).toBeNull()
        expect(controller.canCompose).toBe(true)
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
