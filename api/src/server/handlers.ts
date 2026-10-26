import {
    apiResultSchema,
    checkResultSchema,
    createDemoManual,
    manualSessionSchema,
    matchesBinding,
    parsedManualSchema,
    questionResultSchema,
    type ApiResult,
    type CaptureBinding,
    type ManualBinding,
    type SourceRef,
} from '@truebuild/contracts'
import type { z } from 'zod'

import {
    DEMO_LABEL,
    checkInputSchema,
    parseInputSchema,
    questionInputSchema,
    segmentInputSchema,
    segmentResultSchema,
    type FixtureProvider,
} from '../providers/types'
import { InvalidBodyError, readBoundedJson } from './json-body'
import { corsResponse, deniedOrigin, isAllowedOrigin } from './cors'

type Input = {
    mode: 'fixture' | 'model'
    requestId: string
    binding: ManualBinding | CaptureBinding
}
type Handler = (request: Request) => Promise<Response>

export interface ApiHandlers {
    parse: Handler
    check: Handler
    question: Handler
    segment: Handler
}

function json(value: unknown, status: number): Response {
    return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function unavailable(
    code: 'invalid_input' | 'unconfigured' | 'provider_error' | 'invalid_output',
    status: number,
    input?: Input,
): Response {
    const result: ApiResult<never> = {
        status: 'unavailable',
        requestId: input?.requestId ?? 'invalid-request',
        binding: input?.binding ?? null,
        code,
        retryable: false,
    }

    return json(result, status)
}

function isDemoBinding(binding: ManualBinding | CaptureBinding): boolean {
    const demo = createDemoManual()

    if (binding.manualId !== demo.manualId || binding.revision !== demo.revision) {
        return false
    }

    return binding.kind === 'manual' || demo.reviewedSteps.some((step) => step.stepId === binding.stepId)
}

function hasDemoSources(refs: SourceRef[]): boolean {
    const pageIds = new Set(createDemoManual().pages.map((page) => page.pageId))

    return refs.every((ref) => pageIds.has(ref.pageId))
}

function createHandler<TInput extends Input, TValue>(
    schema: z.ZodType<TInput>,
    valueSchema: z.ZodType<TValue>,
    dispatch: (input: TInput) => Promise<TValue>,
    validateInput: (input: TInput) => boolean = (): boolean => true,
    validateOutput: (value: TValue, input: TInput) => boolean = (): boolean => true,
): Handler {
    const handle = async (request: Request): Promise<Response> => {
        let body: unknown

        try {
            body = await readBoundedJson(request)
        } catch (error: unknown) {
            return unavailable('invalid_input', error instanceof InvalidBodyError ? error.status : 400)
        }

        const parsed = schema.safeParse(body)

        if (!parsed.success) {
            return unavailable('invalid_input', 400)
        }

        const input = parsed.data

        if (input.mode === 'model') {
            return unavailable('unconfigured', 503, input)
        }

        if (!isDemoBinding(input.binding) || !validateInput(input)) {
            return unavailable('invalid_input', 400, input)
        }

        let value: TValue

        try {
            value = await dispatch(input)
        } catch {
            return unavailable('provider_error', 502, input)
        }

        const checked = valueSchema.safeParse(value)

        if (!checked.success || !validateOutput(checked.data, input)) {
            return unavailable('invalid_output', 502, input)
        }

        const result: ApiResult<TValue> = {
            status: 'ok',
            requestId: input.requestId,
            mode: 'fixture',
            binding: input.binding,
            value: checked.data,
        }
        const envelope = apiResultSchema(valueSchema).safeParse(result)

        return envelope.success ? json(envelope.data, 200) : unavailable('invalid_output', 502, input)
    }

    return async (request: Request): Promise<Response> => {
        if (!isAllowedOrigin(request)) {
            await request.body?.cancel().catch((): void => {})

            return deniedOrigin()
        }

        return corsResponse(request, await handle(request))
    }
}

export function createApiHandlers(provider: FixtureProvider): ApiHandlers {
    return {
        parse: createHandler(
            parseInputSchema,
            parsedManualSchema,
            (input) => provider.parse(input),
            undefined,
            (value): boolean =>
                value.unknowns.includes(DEMO_LABEL) &&
                manualSessionSchema.safeParse({ ...createDemoManual(), rawExtraction: value }).success,
        ),
        check: createHandler(
            checkInputSchema,
            checkResultSchema,
            (input) => provider.check(input),
            undefined,
            (value): boolean => value.reason.includes(DEMO_LABEL) && hasDemoSources(value.sourceRefs),
        ),
        question: createHandler(
            questionInputSchema,
            questionResultSchema,
            (input) => provider.question(input),
            (input): boolean =>
                input.target.kind === 'point' ||
                createDemoManual().parts.some(
                    (part) => input.target.kind === 'part' && part.partId === input.target.partId,
                ),
            (value): boolean => value.answer.includes(DEMO_LABEL) && hasDemoSources(value.sourceRefs),
        ),
        segment: createHandler(
            segmentInputSchema,
            segmentResultSchema,
            (input) => provider.segment(input),
            undefined,
            (value, input): boolean =>
                value.events.every(
                    (event) => event.type !== 'snapshot' || matchesBinding(event.snapshot.binding, input.binding),
                ),
        ),
    }
}
