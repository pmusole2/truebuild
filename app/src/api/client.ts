import {
    captureBindingSchema,
    checkResultSchema,
    manualBindingSchema,
    parsedManualSchema,
    questionResultSchema,
    questionTargetSchema,
    segmentEventSchema,
    matchesBinding,
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type ManualBinding,
    type ParsedManual,
    type QuestionResult,
    type QuestionTarget,
} from '@truebuild/contracts'
import { z } from 'zod'
import {
    awaitStopped,
    createCallGuard,
    discardResponse,
    interpretEnvelope,
    invalidInputResult,
    parseBaseUrl,
    readBoundedText,
    unavailableResult,
    type Call,
    InvalidResponseError,
    MAX_RESPONSE_BYTES,
} from './transport'

export { MAX_RESPONSE_BYTES }

/** Label the fixture API places on every simulated value. Client results without it fail closed. */
export const SIMULATED_LABEL = 'Demo data — simulated results'
export const REQUEST_TIMEOUT_MS = 8_000

export type CheckScenario = 'correct' | 'wrong' | 'unclear'
export type SegmentStreamKind = 'normal' | 'empty' | 'incomplete'
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Finite precursor of the segment stream; mirrors the approved fixture API shape exactly. */
const segmentStreamSchema = z
    .strictObject({
        label: z.literal(SIMULATED_LABEL),
        transport: z.literal('finite-json-precursor'),
        events: z.array(segmentEventSchema).min(1).max(2),
    })
    .superRefine((stream, ctx): void => {
        const terminals = stream.events.filter((event) => event.type !== 'snapshot')

        if (terminals.length !== 1 || stream.events.at(-1)?.type === 'snapshot') {
            ctx.addIssue({ code: 'custom', message: 'A finite stream must end with exactly one terminal event' })
        }
    })

export type SegmentStream = z.infer<typeof segmentStreamSchema>

const requestIdSchema = z.string().min(1).max(128)
const questionSchema = z.string().trim().min(1).max(500)

const parseInputSchema = z.strictObject({ requestId: requestIdSchema, binding: manualBindingSchema })
const checkInputSchema = z.strictObject({
    requestId: requestIdSchema,
    binding: captureBindingSchema,
    scenario: z.enum(['correct', 'wrong', 'unclear']),
})
const questionInputSchema = z.strictObject({
    requestId: requestIdSchema,
    binding: captureBindingSchema,
    question: questionSchema,
    target: questionTargetSchema,
})
const segmentInputSchema = z.strictObject({
    requestId: requestIdSchema,
    binding: captureBindingSchema,
    stream: z.enum(['normal', 'empty', 'incomplete']),
})

export interface ApiClientOptions {
    baseUrl: string
    mode: 'fixture' | 'model'
    /** Public demo-only shared key (EXPO_PUBLIC_API_SECRET). Sent as x-truebuild-key only when non-empty. */
    secret?: string
    fetch?: FetchLike
}

export interface RequestContext {
    requestId: string
    signal?: AbortSignal
}

/**
 * Fixture-only client for the local API. Every call performs at most one request (no retries), is bounded by one
 * absolute deadline that covers the body read and schema validation, honours the caller's AbortSignal, and returns
 * only values that validate against the domain schema and echo the request's requestId, binding and mode.
 * Model mode returns `unconfigured` without any I/O.
 */
export class BoundedApiClient {
    private readonly baseUrl: string
    private readonly mode: 'fixture' | 'model'
    private readonly fetchImpl: FetchLike
    private readonly secret: string

    constructor(options: ApiClientOptions) {
        this.baseUrl = parseBaseUrl(options.baseUrl)
        this.mode = options.mode
        this.secret = options.secret ?? ''
        this.fetchImpl = options.fetch ?? ((url: string, init: RequestInit): Promise<Response> => fetch(url, init))
    }

    async parse(binding: ManualBinding, ctx: RequestContext): Promise<ApiResult<ParsedManual>> {
        const input = parseInputSchema.safeParse({ requestId: ctx.requestId, binding })

        if (!input.success) {
            return invalidInputResult(ctx.requestId)
        }

        return this.post({
            path: '/api/manuals/parse',
            requestId: input.data.requestId,
            binding: input.data.binding,
            fields: {},
            valueSchema: parsedManualSchema,
            accepts: (value: ParsedManual): boolean => value.unknowns.includes(SIMULATED_LABEL),
            signal: ctx.signal,
        })
    }

    async check(
        binding: CaptureBinding,
        scenario: CheckScenario,
        ctx: RequestContext,
    ): Promise<ApiResult<CheckResult>> {
        const input = checkInputSchema.safeParse({ requestId: ctx.requestId, binding, scenario })

        if (!input.success) {
            return invalidInputResult(ctx.requestId)
        }

        return this.post({
            path: '/api/checks',
            requestId: input.data.requestId,
            binding: input.data.binding,
            fields: { scenario: input.data.scenario },
            valueSchema: checkResultSchema,
            accepts: (value: CheckResult): boolean => value.reason.includes(SIMULATED_LABEL),
            signal: ctx.signal,
        })
    }

    async questions(
        binding: CaptureBinding,
        question: string,
        target: QuestionTarget,
        ctx: RequestContext,
    ): Promise<ApiResult<QuestionResult>> {
        const input = questionInputSchema.safeParse({ requestId: ctx.requestId, binding, question, target })

        if (!input.success) {
            return invalidInputResult(ctx.requestId)
        }

        return this.post({
            path: '/api/questions',
            requestId: input.data.requestId,
            binding: input.data.binding,
            fields: { question: input.data.question, target: input.data.target },
            valueSchema: questionResultSchema,
            accepts: (value: QuestionResult): boolean => value.answer.includes(SIMULATED_LABEL),
            signal: ctx.signal,
        })
    }

    async segments(
        binding: CaptureBinding,
        stream: SegmentStreamKind,
        ctx: RequestContext,
    ): Promise<ApiResult<SegmentStream>> {
        const input = segmentInputSchema.safeParse({ requestId: ctx.requestId, binding, stream })

        if (!input.success) {
            return invalidInputResult(ctx.requestId)
        }

        return this.post({
            path: '/api/segments',
            requestId: input.data.requestId,
            binding: input.data.binding,
            fields: { stream: input.data.stream },
            valueSchema: segmentStreamSchema,
            // Every snapshot must belong to the binding that was requested, not merely to the same manual.
            accepts: (value: SegmentStream, requested: ManualBinding | CaptureBinding): boolean =>
                value.events.every(
                    (event) => event.type !== 'snapshot' || matchesBinding(event.snapshot.binding, requested),
                ),
            signal: ctx.signal,
        })
    }

    private async post<T>(call: Call<T>): Promise<ApiResult<T>> {
        const { requestId, binding, signal } = call

        if (signal?.aborted === true) {
            return unavailableResult(requestId, binding, 'invalid_input', false)
        }

        if (this.mode === 'model') {
            return unavailableResult(requestId, binding, 'unconfigured', false)
        }

        const guard = createCallGuard(REQUEST_TIMEOUT_MS, signal)
        let ownedResponse: Response | undefined

        try {
            guard.checkpoint()
            ownedResponse = await awaitStopped(
                this.fetchImpl(new URL(call.path, this.baseUrl).toString(), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(this.secret.length > 0 ? { 'x-truebuild-key': this.secret } : {}),
                    },
                    body: JSON.stringify({ mode: this.mode, requestId, binding, ...call.fields }),
                    signal: guard.signal,
                    redirect: 'error',
                }),
                guard.signal,
                discardResponse,
            )
            guard.checkpoint()
            const text = await readBoundedText(ownedResponse, guard.signal, guard.checkpoint)
            guard.checkpoint()
            const result = interpretEnvelope(call, ownedResponse.status, text, this.mode)
            guard.checkpoint()

            return result
        } catch (error: unknown) {
            if (guard.callerAborted()) {
                return unavailableResult(requestId, binding, 'invalid_input', false)
            }

            if (guard.timedOut()) {
                return unavailableResult(requestId, binding, 'timeout', true)
            }

            if (error instanceof InvalidResponseError) {
                return unavailableResult(requestId, binding, 'invalid_output', false)
            }

            return unavailableResult(requestId, binding, 'provider_error', true)
        } finally {
            guard.dispose()

            if (ownedResponse !== undefined) {
                discardResponse(ownedResponse)
            }
        }
    }
}
