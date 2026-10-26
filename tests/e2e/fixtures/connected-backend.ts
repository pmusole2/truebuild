import { createHash, randomUUID } from 'node:crypto'
import type { Page, Route, Request as BrowserRequest } from '@playwright/test'
import {
    apiResultSchema,
    checkResultSchema,
    createDemoManual,
    LIMITS,
    parsedManualSchema,
    questionResultSchema,
    segmentEventSchema,
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type Fact,
    type ManualBinding,
    type ManualStep,
    type ParsedManual,
    type QuestionResult,
    type QuestionTarget,
    type SegmentEvent,
    type SourceRef,
} from '@truebuild/contracts'
import {
    modelCheckMetadataSchema,
    modelParseMetadataSchema,
    modelQuestionMetadataSchema,
    modelSegmentMetadataSchema,
    type ModelCheckMetadata,
    type ModelParseMetadata,
    type ModelQuestionMetadata,
    type ModelSegmentMetadata,
} from '@truebuild/contracts/model'
import { z } from 'zod'

export const SYNTHETIC_OWNER_TOKEN = 'e'.repeat(64)

type Operation = 'session' | 'parse' | 'check' | 'question' | 'segment'
type Binding = ManualBinding | CaptureBinding
type Metadata = ModelParseMetadata | ModelCheckMetadata | ModelQuestionMetadata | ModelSegmentMetadata
type FailureCode = 'unauthorized' | 'invalid_input' | 'invalid_output' | 'provider_error'

export interface ConnectedCall {
    readonly operation: Operation
    readonly requestId?: string
    readonly binding?: Binding
    readonly target?: QuestionTarget
    readonly fileCounts: { readonly sources: number; readonly observations: number; readonly media: number }
    readonly sourceHashes: readonly string[]
    readonly observationHash?: string
    readonly mediaHash?: string
}

interface Identity {
    requestId: string
    binding: Binding
}

const ORIGIN = 'http://localhost:8081'
const ROUTE = 'http://127.0.0.1:3001/api/**'
const IMAGE_BODY_LIMIT = 9 * 1024 * 1024
const SEGMENT_BODY_LIMIT = 22 * 1024 * 1024
const CLIP_LIMIT = 20 * 1024 * 1024
const SCRIPTED = 'Scripted browser fixture — no model called.'
const sessionSchema = z.strictObject({
    status: z.literal('ok'),
    runId: z.literal('synthetic-run'),
    expiresAt: z.number().int().positive(),
    model: z.literal('configured'),
})

class FixtureError extends Error {
    constructor(
        readonly status: number,
        readonly code: FailureCode,
    ) {
        super(code)
        this.name = 'FixtureError'
    }
}

function operationFor(path: string): Operation | null {
    switch (path) {
        case '/api/session':
            return 'session'
        case '/api/manuals/parse':
            return 'parse'
        case '/api/checks':
            return 'check'
        case '/api/questions':
            return 'question'
        case '/api/segments':
            return 'segment'
        default:
            return null
    }
}

function cors(origin: string | null): Record<string, string> {
    return {
        'cache-control': 'no-store',
        vary: 'Origin',
        ...(origin === ORIGIN ? { 'access-control-allow-origin': ORIGIN } : {}),
    }
}

function success<T>(schema: z.ZodType<T>, identity: Identity, value: T): ApiResult<T> {
    const parsed = schema.safeParse(value)

    if (!parsed.success) {
        throw new FixtureError(502, 'invalid_output')
    }

    const envelope = apiResultSchema(schema).safeParse({
        status: 'ok',
        requestId: identity.requestId,
        binding: identity.binding,
        mode: 'model',
        value: parsed.data,
    })

    if (!envelope.success) {
        throw new FixtureError(502, 'invalid_output')
    }

    return envelope.data
}

function failure(code: FailureCode, identity?: Identity): ApiResult<never> {
    const envelope = apiResultSchema(z.never()).safeParse({
        status: 'unavailable',
        requestId: identity?.requestId ?? 'invalid-request',
        binding: identity?.binding ?? null,
        code,
        retryable: false,
    })

    if (!envelope.success) {
        throw new Error('Invalid scripted failure envelope')
    }

    return envelope.data
}

function remapRefs(refs: SourceRef[], pageId: string): SourceRef[] {
    return refs.map((ref): SourceRef => ({ pageId, region: ref.region === null ? null : { ...ref.region } }))
}

function remapFact<T>(fact: Fact<T>, pageId: string): Fact<T> {
    return fact.state === 'known'
        ? { state: 'known', value: fact.value, sourceRefs: remapRefs(fact.sourceRefs, pageId) }
        : { state: 'unknown', reason: fact.reason }
}

function remapStep(step: ManualStep, pageId: string): ManualStep {
    return {
        ...step,
        parts: step.parts.map((part) => ({ ...part, quantity: remapFact(part.quantity, pageId) })),
        orientation: remapFact(step.orientation, pageId),
        connection: remapFact(step.connection, pageId),
        visibleChecks: step.visibleChecks.map((check) => ({
            ...check,
            description: remapFact(check.description, pageId),
        })),
        sourceRefs: remapRefs(step.sourceRefs, pageId),
        correction:
            step.correction === null
                ? null
                : {
                      reviewed: false,
                      actions: step.correction.actions.map((action) => ({
                          ...action,
                          sourceRefs: remapRefs(action.sourceRefs, pageId),
                      })),
                  },
    }
}

function extractedManual(metadata: ModelParseMetadata): ParsedManual {
    const source = createDemoManual().rawExtraction
    const pageId = metadata.pages[0]?.pageId

    if (source === null || pageId === undefined) {
        throw new FixtureError(502, 'invalid_output')
    }

    const result = parsedManualSchema.safeParse({
        parts: source.parts.map((part) => ({ ...part, name: remapFact(part.name, pageId) })),
        steps: source.steps.map((step): ManualStep => remapStep(step, pageId)),
        unknowns: source.unknowns,
    })

    if (!result.success) {
        throw new FixtureError(502, 'invalid_output')
    }

    return result.data
}

function currentRefs(metadata: ModelCheckMetadata | ModelQuestionMetadata): SourceRef[] {
    const step = metadata.session.reviewedSteps.find(
        (candidate): boolean => candidate.stepId === metadata.binding.stepId,
    )

    if (
        !step ||
        step.sourceRefs.length === 0 ||
        step.sourceRefs.some((ref): boolean => !metadata.sourcePageIds.includes(ref.pageId))
    ) {
        throw new FixtureError(400, 'invalid_input')
    }

    return step.sourceRefs.map((ref): SourceRef => ({ ...ref, region: ref.region === null ? null : { ...ref.region } }))
}

function parseMetadata<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value)

    if (!parsed.success) {
        throw new FixtureError(400, 'invalid_input')
    }

    return parsed.data
}

async function multipart(
    request: BrowserRequest,
    operation: Operation,
): Promise<{ metadata: unknown; form: FormData }> {
    const headers = new Headers(await request.allHeaders())

    if (!headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
        throw new FixtureError(415, 'invalid_input')
    }

    const bytes = request.postDataBuffer()

    if (
        bytes === null ||
        bytes.byteLength === 0 ||
        bytes.byteLength > (operation === 'segment' ? SEGMENT_BODY_LIMIT : IMAGE_BODY_LIMIT)
    ) {
        throw new FixtureError(413, 'invalid_input')
    }

    let form: FormData

    try {
        form = await new Request(request.url(), { method: 'POST', headers, body: Uint8Array.from(bytes) }).formData()
    } catch {
        throw new FixtureError(400, 'invalid_input')
    }

    const fields = form.getAll('metadata')
    const text = fields[0]

    if (fields.length !== 1 || typeof text !== 'string' || Buffer.byteLength(text) > 65_536) {
        throw new FixtureError(400, 'invalid_input')
    }

    try {
        const metadata: unknown = JSON.parse(text)

        return { metadata, form }
    } catch {
        throw new FixtureError(400, 'invalid_input')
    }
}

async function fileHashes(
    form: FormData,
    expected: readonly { name: string; mimeType: string; hash?: string }[],
    clip: boolean,
): Promise<Map<string, string>> {
    const allowed = new Set(['metadata', ...expected.map((file): string => file.name)])

    for (const key of form.keys()) {
        if (!allowed.has(key) || form.getAll(key).length !== 1) {
            throw new FixtureError(400, 'invalid_input')
        }
    }

    let total = 0
    const hashes = new Map<string, string>()

    for (const entry of expected) {
        const value = form.get(entry.name)

        if (
            !(value instanceof File) ||
            value.type !== entry.mimeType ||
            value.size === 0 ||
            value.size > (clip ? CLIP_LIMIT : LIMITS.imageBytes)
        ) {
            throw new FixtureError(400, 'invalid_input')
        }

        total += value.size

        if (total > (clip ? CLIP_LIMIT : LIMITS.requestBytes)) {
            throw new FixtureError(413, 'invalid_input')
        }

        const hash = createHash('sha256')
            .update(new Uint8Array(await value.arrayBuffer()))
            .digest('hex')

        if (entry.hash !== undefined && hash !== entry.hash) {
            throw new FixtureError(400, 'invalid_input')
        }

        hashes.set(entry.name, hash)
    }

    return hashes
}

function requiredHash(hashes: ReadonlyMap<string, string>, name: string): string {
    const hash = hashes.get(name)

    if (hash === undefined) {
        throw new FixtureError(400, 'invalid_input')
    }

    return hash
}

/** Scripted test transport only. Call counts are intercepted HTTP attempts, not model/provider evidence. */
export class ConnectedBackendFixture {
    private readonly records: ConnectedCall[] = []
    private decision: CheckResult['decision'] = 'refuse'
    private installed = false

    constructor(private readonly page: Page) {}

    get calls(): readonly ConnectedCall[] {
        return this.records.map((record): ConnectedCall => structuredClone(record))
    }

    count(operation: Operation): number {
        return this.records.filter((record): boolean => record.operation === operation).length
    }

    setCheckDecision(decision: CheckResult['decision']): void {
        this.decision = decision
    }

    clearCalls(): void {
        this.records.length = 0
    }

    async install(): Promise<void> {
        if (this.installed) {
            throw new Error('Scripted backend already installed')
        }

        this.installed = true
        await this.page.route(ROUTE, async (route): Promise<void> => this.handle(route))
    }

    private async handle(route: Route): Promise<void> {
        const request = route.request()
        const origin = await request.headerValue('origin')
        const url = new URL(request.url())
        const operation = operationFor(url.pathname)
        let identity: Identity | undefined

        try {
            if (origin !== ORIGIN) {
                throw new FixtureError(403, 'unauthorized')
            }

            if (operation === null || url.search !== '') {
                throw new FixtureError(404, 'invalid_input')
            }

            if (request.method() === 'OPTIONS') {
                const method = await request.headerValue('access-control-request-method')
                const requestedHeaders = await request.headerValue('access-control-request-headers')

                if (
                    method !== (operation === 'session' ? 'GET' : 'POST') ||
                    (requestedHeaders !== null &&
                        requestedHeaders
                            .split(',')
                            .some(
                                (header): boolean =>
                                    !['authorization', 'content-type'].includes(header.trim().toLowerCase()),
                            ))
                ) {
                    throw new FixtureError(403, 'unauthorized')
                }

                await route.fulfill({
                    status: 204,
                    headers: {
                        ...cors(origin),
                        'access-control-allow-methods': 'GET, POST, OPTIONS',
                        'access-control-allow-headers': 'Content-Type, Authorization',
                    },
                })

                return
            }

            if (request.method() !== (operation === 'session' ? 'GET' : 'POST')) {
                throw new FixtureError(405, 'invalid_input')
            }

            const index =
                this.records.push({
                    operation,
                    fileCounts: { sources: 0, observations: 0, media: 0 },
                    sourceHashes: [],
                }) - 1

            if ((await request.headerValue('authorization')) !== `Bearer ${SYNTHETIC_OWNER_TOKEN}`) {
                throw new FixtureError(401, 'unauthorized')
            }

            if (operation === 'session') {
                const session = sessionSchema.safeParse({
                    status: 'ok',
                    runId: 'synthetic-run',
                    expiresAt: Date.now() + 30 * 60_000,
                    model: 'configured',
                })

                if (!session.success) {
                    throw new FixtureError(502, 'invalid_output')
                }

                await route.fulfill({
                    status: 200,
                    headers: cors(origin),
                    contentType: 'application/json',
                    body: JSON.stringify(session.data),
                })

                return
            }

            const body = await multipart(request, operation)
            let metadata: Metadata
            let value:
                ApiResult<ParsedManual> | ApiResult<CheckResult> | ApiResult<QuestionResult> | ApiResult<SegmentEvent>[]
            let hashes: Map<string, string>
            let record: ConnectedCall

            if (operation === 'parse') {
                const parsed = parseMetadata(modelParseMetadataSchema, body.metadata)
                metadata = parsed
                identity = parsed
                hashes = await fileHashes(
                    body.form,
                    parsed.pages.map((page, source): { name: string; mimeType: string; hash: string } => ({
                        name: `source-${source}`,
                        mimeType: page.mimeType,
                        hash: page.contentHash,
                    })),
                    false,
                )
                record = {
                    operation,
                    requestId: parsed.requestId,
                    binding: parsed.binding,
                    fileCounts: { sources: parsed.pages.length, observations: 0, media: 0 },
                    sourceHashes: [...hashes.values()],
                }
                value = success(parsedManualSchema, parsed, extractedManual(parsed))
            } else if (operation === 'check' || operation === 'question') {
                const questionMetadata =
                    operation === 'question' ? parseMetadata(modelQuestionMetadataSchema, body.metadata) : undefined
                const parsed = questionMetadata ?? parseMetadata(modelCheckMetadataSchema, body.metadata)
                metadata = parsed
                identity = parsed
                const sources = parsed.sourcePageIds.map(
                    (pageId, source): { name: string; mimeType: string; hash: string } => {
                        const page = parsed.session.pages.find((candidate): boolean => candidate.pageId === pageId)

                        if (!page) {
                            throw new FixtureError(400, 'invalid_input')
                        }

                        return { name: `source-${source}`, mimeType: page.mimeType, hash: page.contentHash }
                    },
                )
                hashes = await fileHashes(
                    body.form,
                    [...sources, { name: 'observation', mimeType: parsed.observation.mimeType }],
                    false,
                )
                record = {
                    operation,
                    requestId: parsed.requestId,
                    binding: parsed.binding,
                    ...(questionMetadata !== undefined ? { target: questionMetadata.target } : {}),
                    fileCounts: { sources: sources.length, observations: 1, media: 0 },
                    sourceHashes: sources.map((source): string => requiredHash(hashes, source.name)),
                    observationHash: requiredHash(hashes, 'observation'),
                }
                const refs = currentRefs(parsed)

                if (operation === 'check') {
                    value = success(checkResultSchema, parsed, {
                        decision: this.decision,
                        reason: SCRIPTED,
                        sourceRefs: refs,
                        observedRegion:
                            this.decision === 'cannot_verify' ? null : { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
                        missingEvidence:
                            this.decision === 'cannot_verify'
                                ? ['Scripted unclear scenario needs a clearer observation.']
                                : [],
                    })
                } else {
                    value = success(questionResultSchema, parsed, {
                        answer: `${SCRIPTED} Use the cited current-step source diagram.`,
                        sourceRefs: refs,
                        missingEvidence: [],
                    })
                }
            } else {
                const parsed = parseMetadata(modelSegmentMetadataSchema, body.metadata)
                metadata = parsed
                identity = parsed
                hashes = await fileHashes(
                    body.form,
                    [{ name: 'media', mimeType: parsed.media.mimeType }],
                    parsed.media.kind === 'clip',
                )
                record = {
                    operation,
                    requestId: parsed.requestId,
                    binding: parsed.binding,
                    fileCounts: { sources: 0, observations: 0, media: 1 },
                    sourceHashes: [],
                    mediaHash: requiredHash(hashes, 'media'),
                }
                const snapshot: SegmentEvent = {
                    type: 'snapshot',
                    snapshot: {
                        binding: parsed.binding,
                        streamId: `synthetic-${randomUUID()}`,
                        frameIndex: 0,
                        capturedAt: parsed.capturedAt,
                        records: [
                            {
                                objectId: 'synthetic-object-1',
                                label: SCRIPTED,
                                box: { x: 0.2, y: 0.25, width: 0.3, height: 0.35 },
                            },
                        ],
                        complete: true,
                    },
                }
                value = [
                    success(segmentEventSchema, parsed, snapshot),
                    success(segmentEventSchema, parsed, { type: 'completed' }),
                ]
            }

            this.records[index] = record
            identity = metadata
            await route.fulfill({
                status: 200,
                headers: cors(origin),
                contentType: operation === 'segment' ? 'text/event-stream; charset=utf-8' : 'application/json',
                body: Array.isArray(value)
                    ? value.map((event): string => `data: ${JSON.stringify(event)}\n\n`).join('')
                    : JSON.stringify(value),
            })
        } catch (error: unknown) {
            const known = error instanceof FixtureError ? error : new FixtureError(502, 'provider_error')
            await route.fulfill({
                status: known.status,
                headers: cors(origin),
                contentType: 'application/json',
                body: JSON.stringify(failure(known.code, identity)),
            })
        }
    }
}
