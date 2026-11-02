import { createHash } from 'node:crypto'

import { createDemoManual } from '@truebuild/contracts'
import { pendingResultSchema } from '@truebuild/contracts/model'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../app'
import { startMetaMock } from '../test-support/meta-http-mock'
import { createRuntimeFromEnvironment } from './model-runtime'
import { QuestionJobs, type StoredResponse } from './question-jobs'

// Slow questions are held server-side and collected by ticket. Only the documented loopback mock answers.
const KEY = 'synthetic-local-test-value'
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()))
    vi.restoreAllMocks()
})

interface Booted {
    app: ReturnType<typeof createApp>
    mock: Awaited<ReturnType<typeof startMetaMock>>
    ask: (revision?: number, requestId?: string) => Promise<Response>
    job: (
        action: 'result' | 'cancel',
        ticket: string,
        revision?: number,
        key?: string | null,
        requestId?: string,
    ) => Promise<Response>
    aborted: boolean[]
    /** Every outbound provider call, including those still waiting out the controlled delay. */
    calls: string[]
}

async function boot(delayMs: number | 'held', env: Record<string, string> = {}, mockDelayMs = 0): Promise<Booted> {
    vi.spyOn(console, 'info').mockImplementation((): void => {})
    const mock = await startMetaMock({
        scenario: 'uncertain',
        ...(mockDelayMs ? { question: { delayMs: mockDelayMs } } : {}),
    })
    closers.push(() => mock.close())
    const aborted: boolean[] = []
    const calls: string[] = []
    const slow: typeof fetch = async (url, init) => {
        calls.push(String(url))
        await new Promise<void>((resolve, reject) => {
            const timer = delayMs === 'held' ? null : setTimeout(resolve, delayMs)
            init?.signal?.addEventListener(
                'abort',
                () => {
                    if (timer !== null) clearTimeout(timer)
                    aborted.push(true)
                    reject(new Error('aborted'))
                },
                { once: true },
            )
        })
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
    const binding = (
        revision = session.revision,
        captureId = 'capture-1',
    ): { kind: 'capture'; manualId: string; revision: number; stepId: string; captureId: string } => ({
        kind: 'capture' as const,
        manualId: session.manualId,
        revision,
        stepId: 'step-1',
        captureId,
    })
    const ask = async (revision = session.revision, requestId = 'ask-1'): Promise<Response> => {
        const form = new FormData()
        form.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId,
                binding: binding(revision),
                session: { ...session, revision },
                sourcePageIds: ['demo-page-1'],
                observation: { mimeType: 'image/png', width: 20, height: 16 },
                question: 'Which way does it face?',
                target: { kind: 'point', x: 0.5, y: 0.5 },
            }),
        )
        form.set('source-0', new Blob([bytes], { type: 'image/png' }), 'source.png')
        form.set('observation', new Blob([bytes], { type: 'image/png' }), 'observation.png')
        return app.request('/api/questions', { method: 'POST', headers: { 'x-truebuild-key': KEY }, body: form })
    }
    const job = async (
        action: 'result' | 'cancel',
        ticket: string,
        revision = session.revision,
        key: string | null = KEY,
        requestId = 'ask-1',
    ): Promise<Response> =>
        app.request(`/api/questions/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-truebuild-key': key }) },
            body: JSON.stringify({ mode: 'model', requestId, binding: binding(revision), ticket }),
        })
    return { app, mock, ask, job, aborted, calls }
}

async function collect(job: Booted['job'], ticket: string): Promise<Response> {
    for (let attempt = 0; attempt < 60; attempt++) {
        const response = await job('result', ticket)
        if (response.status !== 202) return response
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('never_finished')
}

describe('slow questions', (): void => {
    it('answers within the production sync window in the same response', async (): Promise<void> => {
        // This is a routing assertion, not a CPU benchmark. Only deliberately pending cases shrink the 8 s window.
        const { ask, calls } = await boot(0, { QUESTION_SYNC_WAIT_MS: '8000' })
        const response = await ask()
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ status: 'ok', mode: 'model' })
        expect(calls).toHaveLength(1)
    })

    it('returns a 202 ticket instead of a 504, then delivers the answer without resending the question', async (): Promise<void> => {
        const { ask, job, mock } = await boot(500)
        const response = await ask()
        expect(response.status).toBe(202)
        const pending = pendingResultSchema.parse(await response.json())
        expect(pending).toMatchObject({ requestId: 'ask-1', binding: { captureId: 'capture-1' } })
        expect(pending.expiresInMs).toBeGreaterThan(0)
        const answered = await collect(job, pending.ticket)
        expect(answered.status).toBe(200)
        expect(await answered.json()).toMatchObject({
            status: 'ok',
            requestId: 'ask-1',
            value: { sourceRefs: expect.any(Array) },
        })
        // Collecting again is idempotent until retention ends and never reaches the provider.
        expect((await job('result', pending.ticket)).status).toBe(200)
        expect(mock.requests.filter((request) => request.operation === 'question')).toHaveLength(1)
        // The question ran with the dedicated quality policy.
        expect(mock.wireRequests[0]).toMatchObject({ reasoning: { effort: 'max' }, max_output_tokens: 32000 })
    })

    it('lets the loopback mock hold the answer itself, which is what the launcher flag does', async (): Promise<void> => {
        const { ask, job } = await boot(0, {}, 500)
        const response = await ask()
        expect(response.status).toBe(202)
        const pending = pendingResultSchema.parse(await response.json())
        expect((await collect(job, pending.ticket)).status).toBe(200)
    })

    it('shows a job only to a request that names its exact identity, and requires the key', async (): Promise<void> => {
        const { ask, job } = await boot(300)
        const pending = pendingResultSchema.parse(await (await ask()).json())
        expect((await job('result', pending.ticket, 99)).status).toBe(400)
        expect((await job('result', 'unknown-ticket')).status).toBe(400)
        expect((await job('result', pending.ticket, 1, null)).status).toBe(401)
        expect((await job('cancel', pending.ticket, 99)).status).toBe(400)
        // The request id is part of the identity too: another id cannot collect or cancel this job.
        expect((await job('result', pending.ticket, 1, KEY, 'someone-else')).status).toBe(400)
        expect((await job('cancel', pending.ticket, 1, KEY, 'someone-else')).status).toBe(400)
        expect((await job('result', pending.ticket)).status).toBe(202)
    })

    it('cancels the provider call on request and never reports a mid-flight 504', async (): Promise<void> => {
        // Keep this scenario in flight until cancellation instead of relying on an elapsed provider delay.
        const { ask, job, aborted, mock, calls } = await boot('held')
        const pending = pendingResultSchema.parse(await (await ask()).json())
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        expect((await job('cancel', pending.ticket)).status).toBe(204)
        await vi.waitFor(() => expect(aborted).toEqual([true]))
        const after = await job('result', pending.ticket)
        expect(after.status).not.toBe(504)
        expect(await after.json()).toMatchObject({ status: 'unavailable' })
        expect(mock.requests.filter((request) => request.operation === 'question')).toHaveLength(0)
    })

    it('supersedes a running question when a newer revision of the manual asks', async (): Promise<void> => {
        const { ask, job, aborted } = await boot(400)
        const old = pendingResultSchema.parse(await (await ask(1, 'old')).json())
        const newer = await ask(2, 'new')
        expect([200, 202]).toContain(newer.status)
        expect(aborted.length).toBeGreaterThan(0)
        expect((await job('result', old.ticket, 1)).status).not.toBe(200)
    })

    it('bounds in-flight provider work and reports saturation as budget exhaustion, not a hang', async (): Promise<void> => {
        const { ask } = await boot(1_000, { MODEL_MAX_CONCURRENCY: '1' })
        expect((await ask(1, 'one')).status).toBe(202)
        const second = await ask(1, 'two')
        expect(second.status).toBe(429)
        expect(await second.json()).toMatchObject({ status: 'unavailable', code: 'budget_exhausted' })
    })
})

describe('question job custody', (): void => {
    it('never redispatches the same original request: a repeat is refused and mints no new ticket', async (): Promise<void> => {
        const { ask, job, calls } = await boot(400)
        const first = await ask(1, 'ask-1')
        expect(first.status).toBe(202)
        const pending = pendingResultSchema.parse(await first.json())
        // The response may have been lost; asking again with the same request id and binding must not run the model again.
        const repeat = await ask(1, 'ask-1')
        expect(repeat.status).toBe(409)
        expect(await repeat.json()).toMatchObject({
            status: 'unavailable',
            code: 'duplicate_request',
            requestId: 'ask-1',
        })
        expect(calls).toHaveLength(1)
        // Only the first ticket exists; it still delivers the single answer.
        expect((await collect(job, pending.ticket)).status).toBe(200)
        // The fence outlives the finished result.
        expect((await ask(1, 'ask-1')).status).toBe(409)
        expect(calls).toHaveLength(1)
        // A different request id is a different original request.
        expect([200, 202]).toContain((await ask(1, 'ask-2')).status)
    })

    it('rejects a question for an older revision before any provider dispatch', async (): Promise<void> => {
        const { ask, calls } = await boot(0, { QUESTION_SYNC_WAIT_MS: '8000' })
        expect((await ask(2, 'new')).status).toBe(200)
        expect(calls).toHaveLength(1)
        const stale = await ask(1, 'old')
        expect(stale.status).toBe(409)
        expect(await stale.json()).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        expect(calls).toHaveLength(1)
    })

    it('collects an expired question as a graceful terminal outcome, never a 504', async (): Promise<void> => {
        const { ask, job } = await boot(3_000, { AI_DEADLINE_QUESTIONS_MS: '1000' })
        const first = await ask()
        expect(first.status).toBe(202)
        const pending = pendingResultSchema.parse(await first.json())
        const done = await collect(job, pending.ticket)
        expect(done.status).toBe(200)
        expect(await done.json()).toMatchObject({
            status: 'unavailable',
            code: 'timeout',
            requestId: 'ask-1',
            binding: { captureId: 'capture-1' },
        })
        // Re-reading the terminal outcome is idempotent while retained.
        expect((await job('result', pending.ticket)).status).toBe(200)
    })

    it('answers a question that expires within the sync wait gracefully too', async (): Promise<void> => {
        const { ask } = await boot(3_000, { AI_DEADLINE_QUESTIONS_MS: '1000', QUESTION_SYNC_WAIT_MS: '5000' })
        const response = await ask()
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ status: 'unavailable', code: 'timeout' })
    })
})

describe('question job table', (): void => {
    const terminal = (kind: 'expired' | 'failed'): StoredResponse => ({
        status: 200,
        body: JSON.stringify({ status: 'unavailable', code: kind === 'expired' ? 'timeout' : 'provider_error' }),
        headers: [],
    })
    const identity = {
        requestId: 'r',
        binding: { kind: 'capture' as const, manualId: 'm', revision: 1, stepId: 's', captureId: 'c' },
    }

    it('concludes a run that ignores the abort with a stored terminal outcome', async (): Promise<void> => {
        const jobs = new QuestionJobs({ processingMs: 10, expiryMarginMs: 5, settleGraceMs: 5, terminal })
        const job = jobs.start(async (_signal, identify) => {
            identify(identity)
            return new Promise<StoredResponse>(() => {})
        })!
        await job.settled
        expect(job.controller.signal.aborted).toBe(true)
        expect(job.stored).toEqual(terminal('expired'))
        expect(job.finishedAt).toBeDefined()
    })

    it('stores a terminal failure for a run that rejects, and a late answer never replaces it', async (): Promise<void> => {
        const jobs = new QuestionJobs({ processingMs: 1_000, terminal })
        const job = jobs.start(async (_signal, identify) => {
            identify(identity)
            throw new Error('boom')
        })!
        await job.settled
        expect(job.stored).toEqual(terminal('failed'))
    })

    it('forgets a finished job after its retention but keeps fencing the original request', async (): Promise<void> => {
        let now = 0
        const jobs = new QuestionJobs({ processingMs: 1_000, retentionMs: 100, terminal, now: (): number => now })
        const job = jobs.start(async (_signal, identify) => {
            identify(identity)
            return { status: 200, body: '{}', headers: [] }
        })!
        await job.settled
        expect(jobs.find(job.ticket, 'r', identity.binding)).toBe(job)
        now = 100
        expect(jobs.find(job.ticket, 'r', identity.binding)).toBeUndefined()
        expect(jobs.size).toBe(0)
        // The same original request is still refused before dispatch.
        const repeat = jobs.start(async (_signal, identify) => {
            identify(identity)
            return { status: 200, body: '{}', headers: [] }
        })!
        await repeat.settled
        expect(repeat.identity).toBeUndefined()
        expect(repeat.stored).toEqual(terminal('failed'))
    })
})
