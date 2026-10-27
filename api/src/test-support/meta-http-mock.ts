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
    z.strictObject({ type: z.literal('input_image'), image_url: z.string().startsWith('data:image/jpeg;base64,') }),
    z.strictObject({ type: z.literal('input_video'), video_url: z.string().startsWith('data:video/mp4;base64,') }),
])
const requestSchema = z.strictObject({
    model: z.enum(['muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-wonder-1.0', 'sam-3.1']),
    store: z.literal(false),
    stream: z.boolean(),
    max_output_tokens: z.number().int().min(16),
    instructions: z.string().optional(),
    reasoning: z.strictObject({ effort: z.literal('low') }).optional(),
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
export function samMockStream(scenario: MockScenario, width = 20, height = 16): string {
    const lane = { item_id: 'mock-message', output_index: 0, content_index: 0 }
    if (scenario === 'failed')
        return event({ type: 'response.failed', response: { error: { message: 'private mock error' } } })
    // Completed empty output is a documented zero-match result, not a fabricated mask.
    const text =
        scenario === 'zero'
            ? ''
            : `<0f>7<|box;x1=0;y1=0;x2=4;y2=4;w=${width};h=${height}|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n`
    return (
        event({ type: 'response.output_text.done', ...lane, text }) +
        (scenario === 'truncated'
            ? ''
            : event({ type: scenario === 'incomplete' ? 'response.incomplete' : 'response.completed', response: {} }))
    )
}

export async function startMetaMock(
    options: { scenario?: MockScenario; fileExpiration?: 'omitted' | 'null' | 'timestamp' } = {},
): Promise<{
    transport: typeof fetch
    requests: { path: string; operation: string }[]
    failures: string[]
    close(): Promise<void>
}> {
    const requests: { path: string; operation: string }[] = []
    const failures: string[] = []
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
                        id: 'file-mock',
                        object: 'file',
                        bytes: file.size,
                        filename: file.name,
                        purpose: 'user_data',
                        created_at: 1,
                        status: 'processed',
                        ...(options.fileExpiration === 'omitted'
                            ? {}
                            : { expires_at: options.fileExpiration === 'timestamp' ? 3601 : null }),
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
            assert.match(incoming.headers['content-type'] ?? '', /^application\/json/u)
            const parts = request.input[0].content
            const scenario = options.scenario ?? 'uncertain'
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
                    media?.type === 'input_image'
                        ? await sharp(Buffer.from(media.image_url.split(',')[1]!, 'base64')).metadata()
                        : { width: 20, height: 16 }
                outgoing.end(samMockStream(scenario, dimensions.width, dimensions.height))
                return
            }
            assert.equal(request.stream, false)
            assert.equal(request.reasoning?.effort, 'low')
            assert(request.instructions)
            assert(request.text)
            inspectSchema(request.text.format.schema)
            const operation = request.text.format.name.replace('truebuild_', '')
            assert(['parse', 'check', 'question'].includes(operation))
            assert.equal(request.max_output_tokens, operation === 'parse' ? 24000 : 1500)
            assert.equal(parts[0]?.type, 'input_text')
            const textParts = parts.filter((part) => part.type === 'input_text')
            assert.equal(textParts.length, 2)
            const stable = z
                .object({ manualContext: z.record(z.string(), z.unknown()) })
                .parse(JSON.parse(textParts[0]!.text)).manualContext
            const dynamic = z
                .object({ operation: z.string(), step: z.record(z.string(), z.unknown()).optional() })
                .parse(JSON.parse(textParts[1]!.text))
            assert.equal(dynamic.operation, operation)
            if (operation !== 'parse') {
                assert.equal(parts.at(-1)?.type, 'input_image')
                assert(parts.filter((part) => part.type === 'input_image').length <= 3)
            }
            const pages = z.array(z.object({ pageId: z.string() })).parse(stable.sourcePages)
            assert.equal(request.text.format.schema.type, 'object')
            assert(!('anyOf' in request.text.format.schema))
            assert(pages.length >= 1 && pages.length <= (operation === 'parse' ? 20 : 2))
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
            requests.push({ path: '/v1/responses', operation })
            outgoing.setHeader('content-type', 'application/json')
            outgoing.end(
                JSON.stringify({
                    status: 'completed',
                    output: [
                        { type: 'reasoning', id: 'mock-reasoning', summary: [] },
                        {
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
        close: async (): Promise<void> => {
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        },
    }
}
