/** Test-only whole-screen fixture composition. No inference, upstream fetch, dotenv or real credential access. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
    parsedManualSchema,
    type CheckResult,
    type ParsedManual,
    type SourceRef,
    type SegmentEvent,
} from '@truebuild/contracts'
import { createApp } from '../app'
import { createScreenFixtureGenerator } from '../providers/screen-fixtures'
import {
    MetaProviderError,
    type CheckStepInput,
    type MetaProvider,
    type OverlayGeneration,
} from '../providers/meta-provider'
import { createSamProvider } from '../providers/sam'
import { createRuntimeFromEnvironment, type ApiRuntime } from '../server/model-runtime'
import { createModelHandlers } from '../server/model-service'
import { MOCK_PROVIDER_KEY, samMockStream } from './meta-http-mock'
import { stepFixtures } from './step-fixtures'
import { NATIVE_FIXTURE_ASSETS } from './native-fixture-assets'
import { createDocumentFixtureGenerator, DOCUMENT_STEP_DELAY_MS } from '../providers/document-fixtures'
import type { ScreenKindV2 } from '@truebuild/contracts'

const EVIDENCE = 'synthetic-fixture'
const SHARED_KEY = 'truebuild-fixture-demo'
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const done = (): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            resolve()
        }
        const abort = (): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            reject(new Error('Fixture IO cancelled'))
        }
        const timer = setTimeout(done, ms)
        signal.addEventListener('abort', abort, { once: true })
    })
}

function remap(value: unknown, pages: ReadonlyMap<string, string>): unknown {
    if (Array.isArray(value)) return value.map((entry) => remap(entry, pages))
    if (!record(value)) return value
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            key === 'pageId' && typeof entry === 'string' ? (pages.get(entry) ?? entry) : remap(entry, pages),
        ]),
    )
}

function stepOf(input: CheckStepInput): CheckStepInput['session']['reviewedSteps'][number] {
    const step = input.session.reviewedSteps.find((candidate) => candidate.stepId === input.binding.stepId)
    if (step === undefined) throw new MetaProviderError('invalid_input')
    return step
}

function refsOf(input: CheckStepInput): SourceRef[] {
    const step = stepOf(input)
    return step.orientation.state === 'known' ? step.orientation.sourceRefs : step.sourceRefs
}

/** Public fixture JSON contains no claimed provider model/effort/timing/usage. Offer model IDs remain target labels. */
function scrubResult(value: unknown): void {
    if (!record(value)) return
    delete value.telemetry
    delete value.model
    if (record(value.snapshot)) delete value.snapshot.stage
}

async function honestResponse(response: Response, path: string): Promise<Response> {
    const headers = new Headers(response.headers)
    headers.set('x-truebuild-evidence', EVIDENCE)
    headers.set('x-truebuild-inference', 'none')
    headers.delete('content-length')
    const contentType = headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream') && response.body !== null) {
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        let pending = ''
        const stream = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller): void {
                    pending += decoder.decode(chunk, { stream: true })
                    let end: number
                    while ((end = pending.indexOf('\n\n')) >= 0) {
                        const event = pending.slice(0, end)
                        pending = pending.slice(end + 2)
                        if (event.startsWith(':')) {
                            controller.enqueue(encoder.encode(`${event}\n\n`))
                            continue
                        }
                        if (!event.startsWith('data: ')) throw new Error('Unexpected fixture stream')
                        const value: unknown = JSON.parse(event.slice(6))
                        if (record(value)) scrubResult(value.value)
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
                    }
                },
                flush(): void {
                    if (pending.trim() !== '') throw new Error('Incomplete fixture stream')
                },
            }),
        )
        return new Response(stream, { status: response.status, headers })
    }
    if (!contentType.includes('application/json'))
        return new Response(response.body, { status: response.status, headers })
    const value: unknown = await response.json()
    if (
        record(value) &&
        path !== '/api/screens' &&
        path !== '/api/screens/v2' &&
        !path.startsWith('/api/checks/overlay')
    )
        scrubResult(value.value)
    return new Response(JSON.stringify(value), { status: response.status, headers })
}

export type NativeFixtureOptions = {
    /** Test-only sync window; native proof keeps the production eight-second window. */
    readonly jobSyncWaitMs?: number
    readonly parseDelayMs?: number
    readonly verdictDelayMs?: number
    readonly generativeUi?: 'full' | 'steps' | 'off'
    readonly invalidDocumentKinds?: readonly ScreenKindV2[]
    readonly stepDelayMs?: number
    readonly questionDelayMs?: number
    readonly overlayDelayMs?: number
    readonly maskDelayMs?: number
    readonly secondPassDelayMs?: number
    readonly scenario?:
        | 'full'
        | 'all-pass'
        | 'no-overlay'
        | 'no-mask'
        | 'parse-unavailable'
        | 'check-unavailable'
        | 'overlay-unavailable'
}

/** In-process app for focused verification; it opens no listener. */
export function createNativeFixtureApp(options: NativeFixtureOptions = {}): {
    fetch: (request: Request) => Promise<Response>
    evidence: typeof EVIDENCE
    /** Construction guarantee, not a measured count: every provider port is a deterministic fixture. */
    inference: 'disabled-by-construction'
    fixtureDispatchCounts: () => Readonly<
        Record<'parse' | 'check' | 'secondOpinion' | 'question' | 'overlay' | 'sam' | 'documents', number>
    >
} {
    const fixtures = stepFixtures()
    const assignments = new Map<string, number>()
    const checks = new Map<string, number>()
    const dispatches = { parse: 0, check: 0, secondOpinion: 0, question: 0, overlay: 0, sam: 0, documents: 0 }
    const scenario = options.scenario ?? 'full'
    const base = createRuntimeFromEnvironment({
        PROVIDER_MODE: 'fixture',
        // A single fixture server serves the whole browser suite under the same loopback client IP.
        PARSE_LIMIT_PER_HOUR: '1000',
        MODEL_CALL_LIMIT_PER_DAY: '200',
        API_SHARED_SECRET: SHARED_KEY,
        GENERATIVE_UI: options.generativeUi ?? 'full',
        MODEL_SECOND_OPINION: 'muse-wonder-1.0',
        MODEL_LAYOUT_WONDER: '1',
        MODEL_SEGMENTS: '1',
        CORS_ORIGINS: 'http://localhost:8091',
    })
    const sourceAssets = NATIVE_FIXTURE_ASSETS.filter((asset) => asset.kind === 'page')
    const buildAssets = NATIVE_FIXTURE_ASSETS.filter((asset) => asset.kind === 'build')
    const requireFixturePhoto = (input: CheckStepInput): void => {
        const hash = createHash('sha256').update(input.observation.bytes).digest('hex')
        const expected = assignments.get(input.binding.manualId)
        if (
            expected === undefined ||
            !buildAssets.some((asset) => asset.hash === hash && asset.manualIndex === expected)
        ) {
            throw new MetaProviderError('invalid_input')
        }
    }
    const provider: MetaProvider = {
        async parseManual(input, signal): Promise<ParsedManual> {
            dispatches.parse++
            await sleep(options.parseDelayMs ?? 1_400, signal)
            const seen = input.pages.map((page) => {
                const hash = createHash('sha256').update(page.bytes).digest('hex')
                const asset = sourceAssets.find((candidate) => candidate.hash === hash)
                if (asset === undefined) throw new MetaProviderError('invalid_input')
                return { page: page.page, asset }
            })
            const manualIndex = seen[0]?.asset.manualIndex
            const fixture = manualIndex === undefined ? undefined : fixtures[manualIndex]
            if (
                fixture === undefined ||
                manualIndex === undefined ||
                seen.some((entry) => entry.asset.manualIndex !== manualIndex) ||
                seen.length !== fixture.session.pages.length ||
                new Set(seen.map((entry) => entry.asset.pageIndex)).size !== fixture.session.pages.length
            ) {
                throw new MetaProviderError('invalid_input')
            }
            const pageIds = new Map(
                fixture.session.pages.map((page, index) => {
                    const match = seen.find((entry) => entry.asset.pageIndex === index)
                    if (match === undefined) throw new MetaProviderError('invalid_input')
                    return [page.pageId, match.page.pageId] as const
                }),
            )
            if (scenario === 'parse-unavailable') throw new MetaProviderError('provider_error')
            assignments.set(input.binding.manualId, manualIndex)
            const parsed = parsedManualSchema.parse(
                remap(
                    {
                        parts: fixture.session.parts,
                        steps: fixture.session.reviewedSteps.map((step) => ({
                            ...step,
                            // These authored synthetic inputs declare their classification; real manuals are never inferred safe.
                            safetyNotes: step.safetyNotes ?? [],
                            correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                        })),
                        unknowns: [],
                    },
                    pageIds,
                ),
            )
            return parsed
        },
        async checkStep(input, signal): Promise<CheckResult> {
            dispatches.check++
            requireFixturePhoto(input)
            await sleep(options.verdictDelayMs ?? 250, signal)
            if (scenario === 'check-unavailable') throw new MetaProviderError('provider_error')
            const step = stepOf(input)
            const key = `${input.binding.manualId}:${step.stepId}`
            const count = checks.get(key) ?? 0
            checks.set(key, count + 1)
            const uncertain = scenario !== 'all-pass' && step.order === 2 && count === 0
            return {
                decision: uncertain ? 'cannot_verify' : 'pass',
                orientationAssessment: uncertain ? 'uncertain' : 'correct',
                reason: uncertain
                    ? 'A closer look is needed.'
                    : step.orientation.state === 'known'
                      ? step.orientation.value.description
                      : step.title,
                sourceRefs: refsOf(input),
                observedRegion: null,
                missingEvidence: uncertain ? ['The connection needs a closer look.'] : [],
            }
        },
        async secondOpinion(input, signal): Promise<CheckResult> {
            dispatches.secondOpinion++
            requireFixturePhoto(input)
            await sleep(options.secondPassDelayMs ?? 2_500, signal)
            return {
                decision: 'refuse',
                orientationAssessment: 'reversed',
                reason: 'Check the connection against the manual picture.',
                sourceRefs: refsOf(input),
                observedRegion: { x: 260 / 960, y: 190 / 720, width: 144 / 960, height: 350 / 720 },
                missingEvidence: [],
            }
        },
        async answerQuestion(input, signal) {
            dispatches.question++
            requireFixturePhoto(input)
            await sleep(options.questionDelayMs ?? 12_000, signal)
            const step = stepOf(input)
            return {
                answer: step.orientation.state === 'known' ? step.orientation.value.description : step.title,
                sourceRefs: refsOf(input),
                missingEvidence: [],
            }
        },
        async overlay(input, signal): Promise<OverlayGeneration> {
            dispatches.overlay++
            requireFixturePhoto(input)
            await sleep(options.overlayDelayMs ?? 1_600, signal)
            if (scenario === 'overlay-unavailable') throw new MetaProviderError('timeout')
            const step = stepOf(input)
            const targetPartId = step.parts[0]?.partId
            // Both boxes describe the same part: its present location and its destination, never two part identities.
            const nextPartId = targetPartId
            return {
                evidence: 'synthetic-fixture',
                value: {
                    observedRegion: { x: 260 / 960, y: 190 / 720, width: 144 / 960, height: 350 / 720 },
                    layout: undefined,
                    targetRegion:
                        targetPartId === undefined
                            ? undefined
                            : {
                                  partId: targetPartId,
                                  region: { x: 260 / 960, y: 190 / 720, width: 144 / 960, height: 350 / 720 },
                              },
                    nextPartRegion:
                        nextPartId === undefined
                            ? undefined
                            : {
                                  partId: nextPartId,
                                  region: { x: 404 / 960, y: 360 / 720, width: 316 / 960, height: 115 / 720 },
                              },
                },
            }
        },
    }
    const rawSam = createSamProvider({
        apiKey: MOCK_PROVIDER_KEY,
        fetchImpl: async (url, init): Promise<Response> => {
            dispatches.sam++
            assert.equal(String(url), 'https://api.meta.ai/v1/responses')
            assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${MOCK_PROVIDER_KEY}`)
            const body: unknown = JSON.parse(String(init?.body))
            assert(record(body) && body.model === 'sam-3.1' && body.stream === true)
            const inputs = body.input
            assert(Array.isArray(inputs) && record(inputs[0]) && Array.isArray(inputs[0].content))
            const media = inputs[0].content[1]
            assert(record(media) && typeof media.image_url === 'string' && media.image_url.startsWith('data:'))
            const info = await sharp(Buffer.from(media.image_url.split(',')[1] ?? '', 'base64')).metadata()
            assert(info.width && info.height)
            await sleep(options.maskDelayMs ?? 2_600, init?.signal ?? new AbortController().signal)
            const box = `x1=260;y1=190;x2=404;y2=540;w=${info.width};h=${info.height}`
            const stream = samMockStream('correct', info.width, info.height)
                .replaceAll(`x1=0;y1=0;x2=4;y2=4;w=${info.width};h=${info.height}`, box)
                .split('\n\n')
                .filter(Boolean)
                .map((line) => {
                    const event: unknown = JSON.parse(line.slice(6))
                    if (record(event) && record(event.response)) event.response.usage = {}
                    return `data: ${JSON.stringify(event)}\n\n`
                })
                .join('')
            return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
        },
    })
    const samProvider = {
        async *segment(
            input: Parameters<typeof rawSam.segment>[0],
            signal: AbortSignal,
        ): AsyncGenerator<SegmentEvent, void, void> {
            for await (const event of rawSam.segment(input, signal)) {
                if (event.type !== 'snapshot') {
                    yield event
                    continue
                }
                const { stage: _stage, ...snapshot } = event.snapshot
                void _stage
                yield { ...event, snapshot }
            }
        },
    }
    const fixtureDocuments = createDocumentFixtureGenerator()
    const fixtureScreens = createScreenFixtureGenerator({ stepDelayMs: options.stepDelayMs ?? 5_000 })
    const model = createModelHandlers({
        provider,
        samProvider,
        auth: base.auth,
        counter: base.counter,
        allowedOrigins: base.allowedOrigins,
        policy: base.policy,
        runtimeMode: 'fixture',
        secondOpinionModel: 'muse-wonder-1.0',
        followUps: { overlay: scenario !== 'no-overlay', segments: scenario !== 'no-mask' },
        questionSyncWaitMs: options.jobSyncWaitMs ?? 8_000,
        documentFixtures: async (request, signal) => {
            dispatches.documents++
            if (options.invalidDocumentKinds?.includes(request.kind)) return { nodes: [] }
            if (request.kind === 'guide' && request.context.material.stepIndex > 0) {
                await sleep(Math.max(0, (options.stepDelayMs ?? 5_000) - DOCUMENT_STEP_DELAY_MS), signal)
            }
            return fixtureDocuments(request, signal)
        },
        screenFixtures: (request, signal) => {
            const index = request.manualId === null ? undefined : assignments.get(request.manualId)
            return fixtureScreens(
                index === undefined
                    ? request
                    : {
                          ...request,
                          manualId: fixtures[index]?.session.manualId ?? request.manualId,
                      },
                signal,
            )
        },
    })
    const runtime: ApiRuntime = { ...base, model }
    const app = createApp({ runtime, onDuration: (): void => undefined })
    return {
        evidence: EVIDENCE,
        inference: 'disabled-by-construction',
        fixtureDispatchCounts: () => Object.freeze({ ...dispatches }),
        fetch: async (request): Promise<Response> =>
            honestResponse(await app.fetch(request), new URL(request.url).pathname),
    }
}
