/** Tests-only documented protocol simulator. No model/device accuracy or latency evidence. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { z } from 'zod'
import sharp from 'sharp'
import { createDemoManual, parsedManualSchema } from '@truebuild/contracts'

export const MOCK_PROVIDER_KEY = '<synthetic>'
export type MockScenario = 'correct' | 'reversed' | 'uncertain' | 'failed' | 'incomplete' | 'zero' | 'truncated'
const content = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('input_text'), text: z.string() }),
    z
        .strictObject({
            type: z.literal('input_image'),
            image_url: z.string().optional(),
            file_id: z.string().optional(),
            detail: z.enum(['auto', 'low', 'high', 'original']).optional(),
        })
        .refine((value) => Boolean(value.image_url) !== Boolean(value.file_id)),
    z
        .strictObject({
            type: z.literal('input_video'),
            video_url: z.string().optional(),
            file_id: z.string().optional(),
        })
        .refine((value) => Boolean(value.video_url) !== Boolean(value.file_id)),
])
const requestSchema = z.strictObject({
    model: z.enum(['muse-spark-1.3', 'muse-wonder-1.0', 'sam-3.1']),
    store: z.boolean().optional(),
    stream: z.boolean().optional(),
    max_output_tokens: z.number().int().min(16).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    instructions: z.string().optional(),
    reasoning: z.strictObject({ effort: z.enum(['low', 'high']) }).optional(),
    input: z.tuple([
        z.strictObject({ type: z.literal('message'), role: z.literal('user'), content: z.array(content).min(2) }),
    ]),
    text: z
        .strictObject({
            format: z.strictObject({
                type: z.literal('json_schema'),
                name: z.string().regex(/^[\w-]{1,64}$/u),
                strict: z.literal(true),
                schema: z.record(z.string(), z.unknown()),
            }),
        })
        .optional(),
})

// Deliberately independent of the production schema normalizer, so broken normalization fails the wire mock.
function inspectSchema(value: unknown, depth = 0): void {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
        value.forEach((entry) => inspectSchema(entry, depth))
        return
    }
    const node = value as Record<string, unknown>
    assert(!('$ref' in node) && !('oneOf' in node) && !('allOf' in node))
    const next = depth + (node.type === 'object' || node.type === 'array' ? 1 : 0)
    assert(next <= 10)
    if (node.type === 'object') {
        assert.equal(node.additionalProperties, false)
        assert(node.properties && typeof node.properties === 'object')
        assert.deepEqual(new Set(node.required as string[]), new Set(Object.keys(node.properties)))
    }
    Object.values(node).forEach((entry) => inspectSchema(entry, next))
}

function event(value: unknown): string {
    return `data: ${JSON.stringify(value)}\n\n`
}
function responseEnvelope(
    model: string,
    status: 'completed' | 'failed' | 'incomplete',
    output: unknown[],
    usage: unknown,
): Record<string, unknown> {
    return {
        id: 'resp-842549258569146',
        object: 'response',
        created_at: 1793059200,
        completed_at: status === 'completed' ? 1793059201 : null,
        status,
        model,
        error: status === 'failed' ? { code: 'server_error', message: 'Synthetic provider failure' } : null,
        incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
        output,
        usage,
        instructions: null,
        metadata: {},
        temperature: 1,
        top_p: 1,
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
    }
}
export function samMockStream(scenario: MockScenario, width = 20, height = 16, video = false): string {
    const lane = { item_id: 'msg-842549258569147', output_index: 0, content_index: 0 }
    const frame = (index: number): string =>
        `<${index}f>7<|box;x1=0;y1=0;x2=4;y2=4;w=${width};h=${height}|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n`
    const lines = scenario === 'zero' || scenario === 'failed' ? [] : video ? [frame(0), frame(1)] : [frame(0)]
    const text = lines.join('')
    const status = scenario === 'failed' ? 'failed' : scenario === 'incomplete' ? 'incomplete' : 'completed'
    const response = responseEnvelope(
        'sam-3.1',
        status,
        [
            {
                id: lane.item_id,
                type: 'message',
                role: 'assistant',
                status: status === 'failed' ? 'incomplete' : status,
                content: [{ type: 'output_text', text, annotations: [] }],
            },
        ],
        {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            ...(video ? { video_frames_processed: 50 } : { images_processed: 1 }),
        },
    )
    let sequence = 0
    return (
        lines
            .map((delta) => event({ type: 'response.output_text.delta', ...lane, delta, sequence_number: sequence++ }))
            .join('') +
        event({ type: 'response.output_text.done', ...lane, text, sequence_number: sequence++ }) +
        (scenario === 'truncated' ? '' : event({ type: `response.${status}`, response, sequence_number: sequence }))
    )
}

export async function startMetaMock(
    options: {
        scenario?: MockScenario
        fileExpiration?: 'omitted' | 'null' | 'timestamp'
        secondOpinion?: { scenario: 'correct' | 'reversed' | 'uncertain' | 'failed'; delayMs?: number }
    } = {},
): Promise<{
    transport: typeof fetch
    requests: { path: string; operation: string }[]
    failures: string[]
    wireRequests: z.infer<typeof requestSchema>[]
    close(): Promise<void>
}> {
    const checks = new Set<string>()
    const requests: { path: string; operation: string }[] = []
    const failures: string[] = []
    const wireRequests: z.infer<typeof requestSchema>[] = []
    const server = createServer(async (incoming, outgoing): Promise<void> => {
        try {
            assert.equal(incoming.headers.authorization, `Bearer ${MOCK_PROVIDER_KEY}`)
            const chunks: Buffer[] = []
            let size = 0
            for await (const chunk of incoming) {
                assert(Buffer.isBuffer(chunk))
                size += chunk.length
                assert(size <= 16 * 1_048_576)
                chunks.push(chunk)
            }
            const bytes = Buffer.concat(chunks)
            if (incoming.method === 'POST' && incoming.url === '/v1/files') {
                const form = await new Response(bytes, {
                    headers: { 'content-type': incoming.headers['content-type'] ?? '' },
                }).formData()
                const keys = [...form.keys()]
                assert.equal(keys[0], 'purpose')
                assert.equal(keys.at(-1), 'file')
                assert.equal(form.get('purpose'), 'user_data')
                assert(form.get('file') instanceof File)
                if (keys.length > 2) {
                    assert.deepEqual(keys, ['purpose', 'expires_after[anchor]', 'expires_after[seconds]', 'file'])
                    assert.equal(form.get('expires_after[anchor]'), 'created_at')
                    assert(Number(form.get('expires_after[seconds]')) >= 3600)
                }
                const file = form.get('file') as File
                requests.push({ path: '/v1/files', operation: 'file' })
                outgoing.setHeader('content-type', 'application/json')
                outgoing.end(
                    JSON.stringify({
                        id: 'file-842549258569145',
                        object: 'file',
                        bytes: file.size,
                        filename: file.name,
                        purpose: 'user_data',
                        created_at: 1793059200,
                        status: 'uploaded',
                        ...(options.fileExpiration === 'omitted'
                            ? {}
                            : { expires_at: options.fileExpiration === 'timestamp' ? 1793062800 : null }),
                    }),
                )
                return
            }
            if (incoming.method !== 'POST' || incoming.url !== '/v1/responses') {
                outgoing.statusCode = 404
                outgoing.end()
                return
            }
            const request = requestSchema.parse(JSON.parse(bytes.toString('utf8')))
            wireRequests.push(request)
            assert.match(incoming.headers['content-type'] ?? '', /^application\/json/u)
            const parts = request.input[0].content
            let scenario = options.scenario ?? 'uncertain'
            if (request.model === 'sam-3.1') {
                assert.equal(request.stream, true)
                assert.equal(parts.length, 2)
                assert.equal(parts[0]?.type, 'input_text')
                assert.notEqual(parts[1]?.type, 'input_text')
                assert.equal(request.text, undefined)
                assert.equal(request.reasoning, undefined)
                requests.push({ path: '/v1/responses', operation: 'segment' })
                outgoing.setHeader('content-type', 'text/event-stream')
                const media = parts[1]
                const dimensions =
                    media?.type === 'input_image' && media.image_url?.startsWith('data:')
                        ? await sharp(Buffer.from(media.image_url.split(',')[1]!, 'base64')).metadata()
                        : { width: 20, height: 16 }
                outgoing.end(
                    samMockStream(scenario, dimensions.width, dimensions.height, media?.type === 'input_video'),
                )
                return
            }
            assert.equal(request.stream, false)
            assert.equal(request.reasoning?.effort, request.model === 'muse-wonder-1.0' ? 'high' : 'low')
            assert(request.instructions)
            assert(request.text)
            inspectSchema(request.text.format.schema)
            const operation = request.text.format.name.replace('truebuild_', '')
            assert(['parse', 'check', 'question'].includes(operation))
            assert.equal(
                request.max_output_tokens,
                operation === 'parse' ? 24000 : request.model === 'muse-wonder-1.0' ? 16000 : 1500,
            )
            assert.equal(parts[0]?.type, 'input_text')
            const textParts = parts.filter((part) => part.type === 'input_text')
            assert.equal(textParts.length, 2)
            const stable = z
                .object({ manualContext: z.record(z.string(), z.unknown()) })
                .parse(JSON.parse(textParts[0]!.text)).manualContext
            const dynamic = z
                .object({
                    operation: z.string(),
                    requestId: z.string(),
                    step: z.record(z.string(), z.unknown()).optional(),
                })
                .parse(JSON.parse(textParts[1]!.text))
            assert.equal(dynamic.operation, operation)
            const secondary = operation === 'check' && checks.has(dynamic.requestId) && options.secondOpinion
            if (operation === 'check') checks.add(dynamic.requestId)
            if (secondary) {
                scenario = secondary.scenario
                requests.push({ path: '/v1/responses', operation: 'second_opinion' })
                if (secondary.delayMs)
                    await new Promise<void>((resolve) => {
                        const done = (): void => {
                            clearTimeout(timer)
                            outgoing.off('close', done)
                            resolve()
                        }
                        const timer = setTimeout(done, secondary.delayMs)
                        outgoing.once('close', done)
                    })
                if (outgoing.destroyed) return
                if (secondary.scenario === 'failed') {
                    outgoing.statusCode = 503
                    outgoing.end('synthetic_second_opinion_unavailable')
                    return
                }
            }
            if (operation !== 'parse') {
                assert.equal(parts.at(-1)?.type, 'input_image')
                assert(parts.filter((part) => part.type === 'input_image').length <= 21)
            }
            const pages = z.array(z.object({ pageId: z.string() })).parse(stable.sourcePages)
            assert.equal(request.text.format.schema.type, 'object')
            assert(!('anyOf' in request.text.format.schema))
            assert(pages.length >= 1 && pages.length <= 20)
            assert.equal(parts.length, pages.length + (operation === 'parse' ? 2 : 3))
            pages.forEach((_page, index) => assert.equal(parts[index + 1]?.type, 'input_image'))
            assert.equal(parts[pages.length + 1]?.type, 'input_text')
            const refs = [{ pageId: pages[0]!.pageId, region: null }]
            const step = dynamic.step
            const orientation =
                step &&
                z
                    .object({
                        orientation: z.object({ state: z.string(), sourceRefs: z.array(z.unknown()).optional() }),
                    })
                    .safeParse(step)
            const citations =
                orientation && orientation.success && orientation.data.orientation.sourceRefs?.length
                    ? orientation.data.orientation.sourceRefs
                    : refs
            const value =
                operation === 'parse'
                    ? {
                          ...parsedManualSchema.parse(
                              JSON.parse(
                                  JSON.stringify(createDemoManual().rawExtraction).replaceAll(
                                      'demo-page-1',
                                      pages[0]!.pageId,
                                  ),
                              ),
                          ),
                          unknowns: ['TEST MOCK ONLY: extraction accuracy unverified'],
                      }
                    : operation === 'question'
                      ? {
                            answer: 'TEST MOCK ONLY: consult the cited diagram.',
                            sourceRefs: citations,
                            missingEvidence: [],
                            observedRegion: null,
                        }
                      : {
                            partsAssessment: 'matches',
                            connectionAssessment: 'matches',
                            checks: Array.isArray(step?.visibleChecks)
                                ? step.visibleChecks.map((check: unknown) => ({
                                      checkId: z.object({ checkId: z.string() }).parse(check).checkId,
                                      assessment:
                                          scenario === 'correct'
                                              ? 'matches'
                                              : scenario === 'reversed'
                                                ? 'mismatch'
                                                : 'unobservable',
                                      sourceRefs: z
                                          .object({ description: z.object({ sourceRefs: z.array(z.unknown()) }) })
                                          .parse(check).description.sourceRefs,
                                  }))
                                : [],
                            orientationAssessment:
                                scenario === 'correct' ? 'correct' : scenario === 'reversed' ? 'reversed' : 'uncertain',
                            decision:
                                scenario === 'correct' ? 'pass' : scenario === 'reversed' ? 'refuse' : 'cannot_verify',
                            reason: 'TEST MOCK ONLY: synthetic provider-boundary result.',
                            sourceRefs: citations,
                            observedRegion: scenario === 'reversed' ? { x1: 300, y1: 200, x2: 500, y2: 850 } : null,
                            missingEvidence:
                                scenario === 'correct' || scenario === 'reversed'
                                    ? []
                                    : ['TEST MOCK: no real visual evaluation'],
                        }
            if (!secondary) requests.push({ path: '/v1/responses', operation })
            outgoing.setHeader('content-type', 'application/json')
            outgoing.end(
                JSON.stringify({
                    ...responseEnvelope(request.model, 'completed', [], {}),
                    output: [
                        { type: 'reasoning', id: 'mock-reasoning', summary: [] },
                        {
                            id: 'msg-842549258569147',
                            type: 'message',
                            role: 'assistant',
                            status: 'completed',
                            content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
                        },
                    ],
                    usage: {
                        input_tokens: 100,
                        input_tokens_details: { cached_tokens: 50 },
                        output_tokens: 20,
                        output_tokens_details: { reasoning_tokens: 5 },
                        total_tokens: 120,
                    },
                }),
            )
        } catch {
            failures.push('request_conformance_failed')
            outgoing.statusCode = 400
            outgoing.setHeader('content-type', 'text/plain')
            outgoing.end('mock_request_conformance_failed')
        }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    const transport: typeof fetch = async (url, init) => {
        const target = String(url)
        assert(['https://api.meta.ai/v1/responses', 'https://api.meta.ai/v1/files'].includes(target))
        // Trusted injection never forwards any credential other than the fixed test literal.
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${MOCK_PROVIDER_KEY}`)
        return fetch(`http://127.0.0.1:${address.port}${new URL(target).pathname}`, { ...init, redirect: 'error' })
    }
    return {
        transport,
        requests,
        failures,
        wireRequests,
        close: async (): Promise<void> => {
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        },
    }
}
