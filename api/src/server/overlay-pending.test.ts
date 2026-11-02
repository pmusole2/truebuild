import { createHash } from 'node:crypto'

import {
    OVERLAY_JOB_IO_FIXTURES,
    createDemoManual,
    screenContextJsonV2,
    screenManualJsonV2,
} from '@truebuild/contracts'
import { OVERLAY_JOB_PATHS, overlayPendingSchema, overlayResponseSchema } from '@truebuild/contracts/model'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../app'
import { startMetaMock } from '../test-support/meta-http-mock'
import { createRuntimeFromEnvironment } from './model-runtime'

// The overlay job mirrors the slow-question custody: one original request, a 202 ticket, collection and cancellation by
// the exact original identity, a 200 `unavailable` for a timeout, no second dispatch. Only the loopback mock answers.
const KEY = 'synthetic-local-test-value'
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()))
    vi.restoreAllMocks()
})

interface Booted {
    app: ReturnType<typeof createApp>
    runtime: ReturnType<typeof createRuntimeFromEnvironment>
    mock: Awaited<ReturnType<typeof startMetaMock>>
    session: ReturnType<typeof createDemoManual>
    binding: { kind: 'capture'; manualId: string; revision: number; stepId: string; captureId: string }
    verdict: (requestId?: string) => Promise<{ status: number; token: string }>
    overlay: (token: string, requestId?: string, revision?: number) => Promise<Response>
    job: (
        action: 'result' | 'cancel',
        ticket: string,
        options?: { requestId?: string; revision?: number; key?: string | null },
    ) => Promise<Response>
    aborted: boolean[]
    /** Every provider call in arrival order, so the verdict can be shown to precede and not depend on the overlay. */
    calls: string[]
}

/** `overlayDelayMs` holds only the overlay provider call (the verdict is never delayed). */
async function boot(overlayDelayMs: number, env: Record<string, string> = {}): Promise<Booted> {
    vi.spyOn(console, 'info').mockImplementation((): void => {})
    const mock = await startMetaMock({ scenario: 'uncertain' })
    closers.push(() => mock.close())
    const aborted: boolean[] = []
    const calls: string[] = []
    const slow: typeof fetch = async (url, init) => {
        const overlay = String(init?.body ?? '').includes('truebuild_overlay')
        calls.push(overlay ? 'overlay' : 'other')
        if (overlay && overlayDelayMs > 0) {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, overlayDelayMs)
                init?.signal?.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(timer)
                        aborted.push(true)
                        reject(new Error('aborted'))
                    },
                    { once: true },
                )
            })
        }
        return mock.transport(url, init)
    }
    const runtime = createRuntimeFromEnvironment(
        {
            PROVIDER_MODE: 'meta',
            MODEL_API_KEY: '<synthetic>',
            API_SHARED_SECRET: KEY,
            QUESTION_SYNC_WAIT_MS: '100',
            ...env,
        },
        slow,
    )
    const app = createApp({ runtime, onDuration: () => {} })
    const bytes = new Uint8Array(
        await sharp({ create: { width: 20, height: 16, channels: 3, background: 'red' } })
            .png()
            .toBuffer(),
    )
    const session = createDemoManual()
    session.pages[0] = {
        ...session.pages[0]!,
        width: 20,
        height: 16,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
    }
    const binding = {
        kind: 'capture' as const,
        manualId: session.manualId,
        revision: session.revision,
        stepId: 'step-1',
        captureId: 'capture-1',
    }
    const form = (extra: Record<string, unknown>, requestId: string, revision = session.revision): FormData => {
        const body = new FormData()
        body.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId,
                binding: { ...binding, revision },
                session: { ...session, revision },
                sourcePageIds: ['demo-page-1'],
                observation: { mimeType: 'image/png', width: 20, height: 16 },
                ...extra,
            }),
        )
        body.set('source-0', new Blob([bytes], { type: 'image/png' }), 'source.png')
        body.set('observation', new Blob([bytes], { type: 'image/png' }), 'observation.png')
        return body
    }
    const post = (path: string, body: FormData | string, headers: Record<string, string> = {}): Promise<Response> =>
        Promise.resolve(app.request(path, { method: 'POST', headers: { 'x-truebuild-key': KEY, ...headers }, body }))
    return {
        app,
        runtime,
        mock,
        session,
        binding,
        aborted,
        calls,
        verdict: async (requestId = 'req-1'): Promise<{ status: number; token: string }> => {
            const response = await post('/api/checks', form({}, requestId))
            const body = await response.json()
            return { status: response.status, token: body.value?.followUps?.overlay?.token as string }
        },
        overlay: (token, requestId = 'req-1', revision) =>
            post('/api/checks/overlay', form({ overlayToken: token }, requestId, revision)),
        job: (action, ticket, options = {}) =>
            Promise.resolve(
                app.request(OVERLAY_JOB_PATHS[action], {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        ...(options.key === null ? {} : { 'x-truebuild-key': options.key ?? KEY }),
                    },
                    body: JSON.stringify({
                        mode: 'model',
                        requestId: options.requestId ?? 'req-1',
                        binding: { ...binding, revision: options.revision ?? session.revision },
                        ticket,
                    }),
                }),
            ),
    }
}

async function collect(job: Booted['job'], ticket: string): Promise<Response> {
    for (let attempt = 0; attempt < 80; attempt++) {
        const response = await job('result', ticket)
        if (response.status !== 202) return response
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('never_finished')
}

const overlayDispatches = (context: Booted): number =>
    context.mock.requests.filter((request) => request.operation === 'overlay').length
const keys = (value: unknown): string[] => Object.keys(value as object).sort()
const fixture = (
    name: keyof typeof OVERLAY_JOB_IO_FIXTURES,
    index = 0,
): { status: number; body: Record<string, unknown> } =>
    OVERLAY_JOB_IO_FIXTURES[name].responses[index] as { status: number; body: Record<string, unknown> }

describe('overlay job: immediate answer stays compatible', (): void => {
    it('answers a fast overlay in the same 200 response, as before', async (): Promise<void> => {
        const context = await boot(0, { QUESTION_SYNC_WAIT_MS: '8000' })
        const { token } = await context.verdict()
        const response = await context.overlay(token)
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(overlayResponseSchema.safeParse(body).success).toBe(true)
        expect(body).toMatchObject({
            status: 'ok',
            mode: 'model',
            binding: context.binding,
            value: { model: 'muse-wonder-1.0' },
        })
        expect(body.value).not.toHaveProperty('decision')
        // The native I/O fixture has the same envelope as the real route.
        expect(keys(body)).toEqual(keys(fixture('success').body))
        expect(overlayDispatches(context)).toBe(1)
    })
})

describe('overlay job: slow overlay', (): void => {
    it('returns a 202 ticket (never a 504), then delivers the late answer without a second dispatch', async (): Promise<void> => {
        const context = await boot(400)
        const { token } = await context.verdict()
        const response = await context.overlay(token)
        expect(response.status).toBe(202)
        const raw = await response.json()
        const pending = overlayPendingSchema.parse(raw)
        expect(keys(raw)).toEqual(keys(fixture('late').body))
        expect(pending).toMatchObject({ requestId: 'req-1', binding: context.binding })
        expect(pending.expiresInMs).toBeGreaterThan(0)
        // A poll while it still runs is another pending handle with the same ticket.
        const poll = await context.job('result', pending.ticket)
        expect([202, 200]).toContain(poll.status)
        const answered = await collect(context.job, pending.ticket)
        expect(answered.status).toBe(200)
        const body = await answered.json()
        expect(body).toMatchObject({ status: 'ok', requestId: 'req-1', value: { model: 'muse-wonder-1.0' } })
        expect(keys(body)).toEqual(keys(fixture('late', 2).body))
        // Collecting again is idempotent and never reaches the provider.
        expect((await context.job('result', pending.ticket)).status).toBe(200)
        expect(overlayDispatches(context)).toBe(1)
    })

    it('refuses a repeat of the original request before any dispatch and mints no second ticket', async (): Promise<void> => {
        const context = await boot(400)
        const { token } = await context.verdict()
        const first = await context.overlay(token)
        expect(first.status).toBe(202)
        const replay = await context.overlay(token)
        expect(replay.status).toBe(409)
        const body = await replay.json()
        expect(body).toMatchObject({ status: 'unavailable', code: 'duplicate_request' })
        expect(keys(body)).toEqual(keys(fixture('replay').body))
        await collect(context.job, overlayPendingSchema.parse(await first.json()).ticket)
        expect(overlayDispatches(context)).toBe(1)
    })

    it('collects a timeout as a 200 unavailable and leaves the verdict untouched', async (): Promise<void> => {
        const context = await boot(2_500, { AI_DEADLINE_OVERLAY_MS: '1000' })
        const { status, token } = await context.verdict()
        expect(status).toBe(200)
        // The verdict was a finished response before any overlay call existed.
        expect(context.calls).toEqual(['other'])
        const response = await context.overlay(token)
        expect(response.status).toBe(202)
        const pending = overlayPendingSchema.parse(await response.json())
        const finished = await collect(context.job, pending.ticket)
        expect(finished.status).toBe(200)
        const body = await finished.json()
        expect(body).toMatchObject({ status: 'unavailable', code: 'timeout', requestId: 'req-1' })
        expect(keys(body)).toEqual(keys(fixture('timeout', 1).body))
        // The verdict path still works: an independent check is unaffected by the failed overlay.
        expect((await context.verdict('verdict-2')).status).toBe(200)
    })
})

describe('overlay job: identity, auth and cancellation', (): void => {
    it('shows a job only to a request that names its exact original identity, and requires the key', async (): Promise<void> => {
        const context = await boot(300)
        const { token } = await context.verdict()
        const pending = overlayPendingSchema.parse(await (await context.overlay(token)).json())
        expect((await context.job('result', pending.ticket, { revision: 99 })).status).toBe(400)
        expect((await context.job('result', 'unknown-ticket')).status).toBe(400)
        expect((await context.job('result', pending.ticket, { key: null })).status).toBe(401)
        expect((await context.job('cancel', pending.ticket, { key: null })).status).toBe(401)
        expect((await context.job('cancel', pending.ticket, { revision: 99 })).status).toBe(400)
        expect((await context.job('result', pending.ticket, { requestId: 'someone-else' })).status).toBe(400)
        expect((await context.job('cancel', pending.ticket, { requestId: 'someone-else' })).status).toBe(400)
        expect((await context.job('result', pending.ticket)).status).toBe(202)
    })

    it('cancels the provider call on request and never reports a mid-flight 504', async (): Promise<void> => {
        const context = await boot(2_000)
        const { token } = await context.verdict()
        const pending = overlayPendingSchema.parse(await (await context.overlay(token)).json())
        expect((await context.job('cancel', pending.ticket)).status).toBe(204)
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(context.aborted.length).toBeGreaterThan(0)
        const after = await context.job('result', pending.ticket)
        expect(after.status).not.toBe(504)
        expect(await after.json()).toMatchObject({ status: 'unavailable' })
        expect(overlayDispatches(context)).toBe(0)
    })

    it('refuses a revision older than one a version 2 document already observed, before any dispatch', async (): Promise<void> => {
        const context = await boot(0)
        const { token } = await context.verdict()
        expect(
            context.runtime.model.documentService.observe(context.session.manualId, context.session.revision + 1),
        ).toBe(true)
        const response = await context.overlay(token)
        expect(response.status).toBe(409)
        const body = await response.json()
        expect(body).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(keys(body)).toEqual(keys(fixture('stale').body))
        expect(overlayDispatches(context)).toBe(0)
    })

    it('keeps the route map: methods and auth for the job paths', async (): Promise<void> => {
        const context = await boot(0)
        for (const path of Object.values(OVERLAY_JOB_PATHS)) {
            const get = await context.app.request(path, { method: 'GET', headers: { 'x-truebuild-key': KEY } })
            expect(get.status).toBe(405)
            expect(get.headers.get('allow')).toContain('POST')
            const anonymous = await context.app.request(path, { method: 'POST', body: '{}' })
            expect(anonymous.status).toBe(401)
        }
    })

    it('has native I/O fixtures that parse as the public client contract', (): void => {
        for (const scenario of Object.values(OVERLAY_JOB_IO_FIXTURES)) {
            for (const response of scenario.responses) {
                if (response.status === 204) continue
                expect(overlayResponseSchema.safeParse(response.body).success).toBe(true)
            }
        }
    })
})

describe('a new screen revision cancels the running older follow-up jobs', (): void => {
    const newerScreen = async (
        context: Booted,
        route: 'v1' | 'v2',
        op: 'generate' | 'precompute',
        invalidContext = false,
    ): Promise<Response> => {
        const revision = context.session.revision + 1
        const session = { ...context.session, revision }
        const body = new FormData()
        const common = {
            mode: 'model',
            requestId: `screen-${route}-${op}`,
            session,
            binding: { kind: 'manual', manualId: session.manualId, revision },
        }
        body.set(
            'metadata',
            JSON.stringify(
                route === 'v2'
                    ? {
                          ...common,
                          op,
                          kind: 'reading',
                          manualHash: createHash('sha256').update(screenManualJsonV2(session)).digest('hex'),
                          stepId: null,
                          captureId: null,
                          result: null,
                          failure: null,
                          contextKey: invalidContext
                              ? '0'.repeat(64)
                              : createHash('sha256')
                                    .update(
                                        screenContextJsonV2({
                                            kind: 'reading',
                                            session,
                                            stepId: null,
                                            captureId: null,
                                            result: null,
                                            failure: null,
                                        }),
                                    )
                                    .digest('hex'),
                          focusKey: null,
                          want: [],
                      }
                    : {
                          ...common,
                          op,
                          kind: 'reading',
                          stepId: null,
                          captureId: null,
                          result: null,
                          failure: null,
                          focusStepId: null,
                          want: [],
                      },
            ),
        )
        return Promise.resolve(
            context.app.request(route === 'v2' ? '/api/screens/v2' : '/api/screens', {
                method: 'POST',
                headers: { 'x-truebuild-key': KEY },
                body,
            }),
        )
    }

    it.each([
        ['v2', 'generate'],
        ['v2', 'precompute'],
        ['v1', 'generate'],
    ] as const)(
        'a %s %s for a newer revision aborts the running overlay without a later republish',
        async (route, op) => {
            const context = await boot(3_000, { GENERATIVE_UI: 'steps' })
            const { token } = await context.verdict()
            const pending = overlayPendingSchema.parse(await (await context.overlay(token)).json())
            const before = overlayDispatches(context)
            const screen = await newerScreen(context, route, op)
            expect(screen.status).toBe(200)
            await new Promise((resolve) => setTimeout(resolve, 80))
            expect(context.aborted.length).toBeGreaterThan(0)
            const after = await collect(context.job, pending.ticket)
            expect(after.status).not.toBe(504)
            expect(await after.json()).toMatchObject({ status: 'unavailable' })
            // Cancelling spent nothing more: no second dispatch, and collecting again stays the same terminal answer.
            expect(overlayDispatches(context)).toBe(before)
            expect(await (await context.job('result', pending.ticket)).json()).toMatchObject({ status: 'unavailable' })
        },
    )

    it('rejects an invalid newer context before it can cancel an older running overlay', async () => {
        const context = await boot(600, { GENERATIVE_UI: 'steps' })
        const { token } = await context.verdict()
        const pending = overlayPendingSchema.parse(await (await context.overlay(token)).json())
        const rejected = await newerScreen(context, 'v2', 'generate', true)
        expect(rejected.status).toBe(400)
        expect(context.aborted).toHaveLength(0)
        const completed = await collect(context.job, pending.ticket)
        expect(completed.status).toBe(200)
        expect(await completed.json()).toMatchObject({ status: 'ok' })
        expect(overlayDispatches(context)).toBe(1)
    })

    it('leaves a running job of the same revision alone', async (): Promise<void> => {
        const context = await boot(600, { GENERATIVE_UI: 'steps' })
        const { token } = await context.verdict()
        const pending = overlayPendingSchema.parse(await (await context.overlay(token)).json())
        const body = new FormData()
        body.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'same-revision',
                op: 'precompute',
                kind: 'reading',
                binding: { kind: 'manual', manualId: context.session.manualId, revision: context.session.revision },
                session: context.session,
                manualHash: createHash('sha256').update(screenManualJsonV2(context.session)).digest('hex'),
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                contextKey: createHash('sha256')
                    .update(
                        screenContextJsonV2({
                            kind: 'reading',
                            session: context.session,
                            stepId: null,
                            captureId: null,
                            result: null,
                            failure: null,
                        }),
                    )
                    .digest('hex'),
                focusKey: null,
                want: [],
            }),
        )
        await context.app.request('/api/screens/v2', { method: 'POST', headers: { 'x-truebuild-key': KEY }, body })
        const answered = await collect(context.job, pending.ticket)
        expect(await answered.json()).toMatchObject({ status: 'ok', value: { model: 'muse-wonder-1.0' } })
    })
})
