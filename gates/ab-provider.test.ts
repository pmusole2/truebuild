import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHeroManual, HERO_DIAGRAM_PNG_BASE64 } from '@truebuild/contracts/hero'
import { MOCK_PROVIDER_KEY, startMetaMock } from '../api/src/test-support/meta-http-mock'
import { abMain, type AbReport } from './ab'
import { manifestSchema } from './run'

/**
 * Production default factory (no injected factory) against the documented local mock. Only the Meta URL is routed
 * to the mock; every other fetch passes through untouched, so the mock's own loopback request is not re-routed.
 */
type MockHandle = Awaited<ReturnType<typeof startMetaMock>>
type Route = (url: string, init: RequestInit | undefined) => Promise<Response>

const SPARK = 'muse-spark-1.3'
const WONDER = 'muse-wonder-1.0'
const ARGV = ['1b', '--manifest', 'gate.json', '--dispatch', '--ab', '--confirm-critical-facts']
const realFetch = globalThis.fetch
const dirs: string[] = []
const mocks: MockHandle[] = []

afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(mocks.splice(0).map((mock) => mock.close()))
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), 'truebuild-gate-ab-provider-synthetic-'))
    dirs.push(cwd)
    await writeFile(join(cwd, 'image.png'), Buffer.from(HERO_DIAGRAM_PNG_BASE64, 'base64'))
    await writeFile(join(cwd, '.env'), `PROVIDER_MODE=meta\nMODEL_API_KEY=${MOCK_PROVIDER_KEY}\n`)
    const manual = createHeroManual()
    const manifest = manifestSchema.parse({
        pages: manual.pages.map((page) => ({
            path: 'image.png',
            pageId: page.pageId,
            assetId: page.assetId,
            width: page.width,
            height: page.height,
            mimeType: page.mimeType,
        })),
        expected: manual.rawExtraction,
        observation: { path: 'image.png', width: 600, height: 400, mimeType: 'image/png' },
        expectedDecision: 'refuse',
        stepId: 'step-1',
    })
    await writeFile(join(cwd, 'gate.json'), JSON.stringify(manifest))
    return cwd
}

async function startMock(): Promise<MockHandle> {
    const mock = await startMetaMock({ scenario: 'correct' })
    mocks.push(mock)
    return mock
}

/** Installs the global fetch the default factory will resolve at call time; non-Meta URLs use the real fetch. */
function routeMetaTo(route: Route): void {
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url)
        if (!target.startsWith('https://api.meta.ai/')) return realFetch(url, init)
        return route(target, init)
    })
}

function requestModel(init: RequestInit | undefined): string {
    return JSON.parse(String(init?.body)).model
}

/** Forwards to the mock, then edits the JSON body of one model's response only. */
function editBody(mock: MockHandle, model: string, edit: (body: { usage?: Record<string, unknown> }) => void): Route {
    return async (url, init) => {
        const response = await mock.transport(url, init)
        if (requestModel(init) !== model) return response
        const body = (await response.json()) as { usage?: Record<string, unknown> }
        edit(body)
        return new Response(JSON.stringify(body), {
            status: response.status,
            headers: { 'content-type': 'application/json' },
        })
    }
}

async function lastReport(cwd: string): Promise<AbReport> {
    const [line] = (await readFile(join(cwd, 'docs/gate-results.md'), 'utf8')).trim().split('\n').slice(-1)
    return JSON.parse(line!.replace(/^- \S+ /, '')) as AbReport
}

describe('default production factory with the real provider and the documented local mock', () => {
    it('completes both real parses, prices from mock usage and sends each model with its documented reasoning', async () => {
        const cwd = await setup()
        const mock = await startMock()
        routeMetaTo((url, init) => mock.transport(url, init))
        expect(await abMain(ARGV, cwd)).toBe(2)
        const report = await lastReport(cwd)
        expect(report).toMatchObject({
            status: 'unverified',
            reason: 'semantic_review_unverified',
            conclusion: 'unverified',
            automaticFallback: 'none',
            defaultChange: 'none',
            providerRetryPolicy: 'provider_documented_429_500_503_max_3_attempts',
            gateRetryPolicy: 'none',
            requests: 2,
            requestsStatus: 'exact',
        })
        expect(report.models.spark).toMatchObject({
            status: 'completed',
            provenance: 'result_field',
            attempts: 1,
            attemptsStatus: 'exact',
            costStatus: 'priced',
            inputTokens: 100,
            cachedTokens: 50,
            outputTokens: 20,
        })
        // (100-50)*1.25 + 50*0.15 + 20*4.25 = 155 per million tokens.
        expect(report.models.spark?.costUsd).toBe(0.000155)
        expect(report.models.wonder).toMatchObject({ status: 'completed', attempts: 1, costStatus: 'priced' })
        // (100-50)*4 + 50*0.20 + 20*20 = 610 per million tokens.
        expect(report.models.wonder?.costUsd).toBe(0.00061)
        expect(mock.failures).toEqual([])
        expect(mock.wireRequests.map((request) => [request.model, request.reasoning?.effort]).sort()).toEqual([
            [SPARK, 'max'],
            [WONDER, 'max'],
        ])
        expect(await readFile(join(cwd, 'docs/gate-results.md'), 'utf8')).not.toContain(MOCK_PROVIDER_KEY)
    }, 30_000)

    it('keeps a Wonder run with no usage cost-unverified and counts its one response once, never as two attempts', async () => {
        const cwd = await setup()
        const mock = await startMock()
        routeMetaTo(editBody(mock, WONDER, (body) => delete body.usage))
        await abMain(ARGV, cwd)
        const wonder = (await lastReport(cwd)).models.wonder
        expect(wonder).toMatchObject({
            status: 'completed',
            attempts: 1,
            attemptsStatus: 'exact',
            costStatus: 'unverified',
        })
        expect(wonder).not.toHaveProperty('costUsd')
        expect(wonder).not.toHaveProperty('inputTokens')
    }, 30_000)

    it('keeps cost unverified when cached-token details are omitted, and never invents a zero', async () => {
        const cwd = await setup()
        const mock = await startMock()
        routeMetaTo(editBody(mock, SPARK, (body) => delete body.usage?.input_tokens_details))
        await abMain(ARGV, cwd)
        const report = await lastReport(cwd)
        expect(report.models.spark).toMatchObject({ costStatus: 'unverified', inputTokens: 100, outputTokens: 20 })
        expect(report.models.spark).not.toHaveProperty('costUsd')
        expect(report.models.spark).not.toHaveProperty('cachedTokens')
        expect(report.models.wonder).toMatchObject({ costStatus: 'priced', costUsd: 0.00061 })
    }, 30_000)

    it('reports a Wonder rejection as a Wonder failure with one attempt, with no retry and no Spark substitute', async () => {
        const cwd = await setup()
        const mock = await startMock()
        routeMetaTo((url, init) =>
            requestModel(init) === WONDER
                ? Promise.resolve(
                      new Response('synthetic_rejected', { status: 400, headers: { 'content-type': 'text/plain' } }),
                  )
                : mock.transport(url, init),
        )
        expect(await abMain(ARGV, cwd)).toBe(2)
        const report = await lastReport(cwd)
        expect(report.models.wonder).toMatchObject({ status: 'failed', reason: 'provider_error', attempts: 1 })
        expect(report.models.spark).toMatchObject({ status: 'completed', attempts: 1 })
        expect(report.reason).toBe('arm_incomplete_no_fallback')
        expect(report.conclusion).toBe('unverified')
        expect(mock.wireRequests.map((request) => request.model)).toEqual([SPARK])
    }, 30_000)

    it('reports a Wonder parse HTTP 503 after one HTTP attempt without a repair or gate retry', async () => {
        const cwd = await setup()
        const mock = await startMock()
        let wonderCalls = 0
        routeMetaTo((url, init) => {
            if (requestModel(init) !== WONDER) return mock.transport(url, init)
            wonderCalls += 1
            return Promise.resolve(
                new Response('synthetic_unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
            )
        })
        await abMain(ARGV, cwd)
        const report = await lastReport(cwd)
        expect(wonderCalls).toBe(1)
        expect(report.models.wonder).toMatchObject({
            status: 'failed',
            reason: 'provider_error',
            attempts: 1,
            attemptsStatus: 'lower_bound',
        })
        expect(report.models.spark?.status).toBe('completed')
        expect(report.providerRetryPolicy).toBe('provider_documented_429_500_503_max_3_attempts')
        expect(report.gateRetryPolicy).toBe('none')
        expect(mock.wireRequests.map((request) => request.model)).toEqual([SPARK])
    }, 60_000)
})
