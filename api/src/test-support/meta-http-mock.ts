/** Tests-only documented protocol simulator. No model/device accuracy or latency evidence. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { z } from 'zod'
import sharp from 'sharp'
import { AI_EFFORTS, createDemoManual, parsedManualSchema } from '@truebuild/contracts'

export const MOCK_PROVIDER_KEY = '<synthetic>'
// Authored fixture copy, never evidence of a model translating a real manual.
const PORTUGUESE_COPY: Readonly<Record<string, string>> = {
    'Stand the side panel upright': 'Coloque o painel lateral na vertical',
    'Groove faces inward toward the divider.': 'A ranhura fica voltada para dentro, em direção à divisória.',
    'Keep the panel free before seating the divider.': 'Mantenha o painel livre antes de encaixar a divisória.',
    'The inward-facing groove is visible.': 'A ranhura voltada para dentro está visível.',
    'Turn the panel so the groove faces inward.': 'Gire o painel para que a ranhura fique voltada para dentro.',
    'Seat the divider in the groove': 'Encaixe a divisória na ranhura',
    'Divider is horizontal and square to the upright panel.': 'A divisória fica horizontal e perpendicular ao painel.',
    'Divider edge rests inside the panel groove.': 'A borda da divisória fica dentro da ranhura do painel.',
    'Divider is fully seated with no visible gap.': 'A divisória está totalmente encaixada, sem folga visível.',
    'Lift the divider and reseat its edge inside the groove.': 'Levante a divisória e recoloque a borda na ranhura.',
    'Side panel': 'Painel lateral',
    'Divider shelf': 'Prateleira divisória',
    'TEST MOCK ONLY: synthetic provider-boundary result.': 'SIMULAÇÃO: resultado sintético do provedor.',
    'TEST MOCK ONLY: consult the cited diagram.': 'SIMULAÇÃO: consulte o diagrama citado.',
    'TEST MOCK: no real visual evaluation': 'SIMULAÇÃO: sem avaliação visual real',
}
/** The documented-protocol simulator restates the default policy independently of production code. */
export function defaultWire(
    operation: string,
    model: string,
    secondary: boolean,
    screenKind?: string,
): { effort: (typeof AI_EFFORTS)[number]; maxOutputTokens: number } {
    if (operation === 'parse') return { effort: 'medium', maxOutputTokens: 48_000 }
    if (operation === 'question') return { effort: 'max', maxOutputTokens: 32_000 }
    if (operation === 'overlay') return { effort: 'medium', maxOutputTokens: 32_000 }
    if (operation === 'screen')
        return {
            effort: model === 'muse-wonder-1.0' || screenKind === 'quick-check' ? 'medium' : 'low',
            maxOutputTokens: ['guide', 'result', 'answer'].includes(screenKind ?? '') ? 8_000 : 32_000,
        }
    // check: Spark verdict is low and provisional; the stronger second opinion is max.
    return secondary || model === 'muse-wonder-1.0'
        ? { effort: 'max', maxOutputTokens: 32_000 }
        : { effort: 'low', maxOutputTokens: 2_500 }
}

export type ScreenScenario =
    | 'valid'
    | 'invalid-then-valid'
    | 'invalid'
    | 'not-json'
    | 'incomplete'
    | 'unsupported-fact'
    | 'unsupported-then-valid'
    | 'no-usage'
    /** A valid composition that never names the step's manual facts: the server must still publish them. */
    | 'no-directions'
    /** A valid composition whose directions block names every manual fact of the step, not only the required ones. */
    | 'all-directions'
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
    prompt_cache_key: z
        .string()
        .regex(/^truebuild_(?:parse|check|question|overlay|screen|document)_[a-f0-9]{16}$/u)
        .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    instructions: z.string().optional(),
    reasoning: z.strictObject({ effort: z.enum(AI_EFFORTS), summary: z.literal('auto').optional() }).optional(),
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
/** `model` is what the request asked for: the simulator echoes it, as the documented `Response.model` does. */
export function samMockStream(
    scenario: MockScenario,
    width = 20,
    height = 16,
    video = false,
    model = 'sam-3.1',
): string {
    const lane = { item_id: 'msg-842549258569147', output_index: 0, content_index: 0 }
    const frame = (index: number): string =>
        `<${index}f>7<|box;x1=0;y1=0;x2=4;y2=4;w=${width};h=${height}|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n`
    const lines = scenario === 'zero' || scenario === 'failed' ? [] : video ? [frame(0), frame(1)] : [frame(0)]
    const text = lines.join('')
    const status = scenario === 'failed' ? 'failed' : scenario === 'incomplete' ? 'incomplete' : 'completed'
    const response = responseEnvelope(
        model,
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
    // ResponseCreated opens the stream with the Response, so the model is known before the first snapshot.
    let sequence = 1
    return (
        event({
            type: 'response.created',
            response: { ...responseEnvelope(model, 'completed', [], {}), status: 'in_progress', completed_at: null },
            sequence_number: 0,
        }) +
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
        screen?: { scenario: ScreenScenario; delayMs?: number }
        /** Holds every question answer this long (a slow question: the route answers 202 once the wait is exceeded). */
        question?: { delayMs?: number }
        /** Overlay stage response: regions are on the 0-1000 grid. Default: nothing visible. */
        overlay?: { delayMs?: number; nextPartRegion?: unknown; observedRegion?: unknown }
    } = {},
): Promise<{
    transport: typeof fetch
    requests: { path: string; operation: string }[]
    failures: string[]
    /** Screen-stage dispatch count, including repairs. */
    screenDispatches(): number
    wireRequests: z.infer<typeof requestSchema>[]
    close(): Promise<void>
}> {
    const checks = new Set<string>()
    const requests: { path: string; operation: string }[] = []
    const failures: string[] = []
    const wireRequests: z.infer<typeof requestSchema>[] = []
    let screenCalls = 0
    const server = createServer(async (incoming, outgoing): Promise<void> => {
        try {
            // A stray loopback probe from another process (for example a GET) is not a provider request.
            if (incoming.method !== 'POST') {
                incoming.resume()
                outgoing.statusCode = 404
                outgoing.end()
                return
            }
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
                    samMockStream(
                        scenario,
                        dimensions.width,
                        dimensions.height,
                        media?.type === 'input_video',
                        request.model,
                    ),
                )
                return
            }
            assert(request.instructions)
            assert(request.text)
            inspectSchema(request.text.format.schema)
            const operation = request.text.format.name.replace('truebuild_', '')
            assert.equal(request.stream, operation === 'parse' && request.model === 'muse-spark-1.3')
            assert.equal(
                request.reasoning?.summary,
                operation === 'parse' && request.model === 'muse-spark-1.3' ? 'auto' : undefined,
            )
            assert(['parse', 'check', 'question', 'overlay', 'screen'].includes(operation))
            assert.equal(parts[0]?.type, 'input_text')
            if (operation === 'screen' || operation === 'overlay') {
                const view =
                    parts[1]?.type === 'input_text'
                        ? (JSON.parse(parts[1].text) as { screen?: { kind?: string } })
                        : undefined
                const wire = defaultWire(operation, request.model, false, view?.screen?.kind)
                assert.equal(request.reasoning?.effort, wire.effort)
                assert.equal(request.max_output_tokens, wire.maxOutputTokens)
            }
            if (operation === 'screen') {
                // Text-only: exactly the stable context and the dynamic request, no image of any kind.
                assert.equal(parts.length, 2)
                assert(parts.every((part) => part.type === 'input_text'))
                const dynamicScreen = JSON.parse((parts[1] as { text: string }).text) as {
                    screen?: {
                        kind?: string
                        step?: { order?: number } | null
                        facts?: { id: string; kind: string; text: string; sources: number[] }[]
                        manualFacts?: { id: string; basis: string }[]
                        result?: { decision?: string } | null
                    }
                    requestId: string
                }
                const repairing = request.instructions.includes('Repair: your previous completed answer was rejected')
                screenCalls += 1
                requests.push({ path: '/v1/responses', operation: repairing ? 'screen_repair' : 'screen' })
                const scenario = options.screen?.scenario ?? 'valid'
                if (options.screen?.delayMs) {
                    await new Promise<void>((resolve) => {
                        const done = (): void => {
                            clearTimeout(timer)
                            outgoing.off('close', done)
                            resolve()
                        }
                        const timer = setTimeout(done, options.screen?.delayMs)
                        outgoing.once('close', done)
                    })
                    if (outgoing.destroyed) return
                }
                const invalid =
                    scenario === 'invalid' ||
                    ((scenario === 'invalid-then-valid' || scenario === 'no-usage') && !repairing)
                const unsupported =
                    scenario === 'unsupported-fact' || (scenario === 'unsupported-then-valid' && !repairing)
                // The simulated model restates a supplied fact word for word, as the documented prompt asks.
                const screen = dynamicScreen.screen
                const title = screen?.facts?.find((fact) => fact.kind === 'title')
                const decision = screen?.result?.decision
                const kind = screen?.kind ?? 'home'
                const headerTitle =
                    kind === 'guide'
                        ? `Step ${screen?.step?.order ?? 1}`
                        : kind === 'result'
                          ? decision === 'pass'
                              ? 'Looks right'
                              : decision === 'refuse'
                                ? 'Not quite right'
                                : 'Cannot tell yet'
                          : kind === 'add'
                            ? 'Add a manual'
                            : 'Your manuals'
                const hasManual =
                    JSON.parse((parts[0] as { text: string }).text).manualContext?.manual !== null &&
                    JSON.parse((parts[0] as { text: string }).text).manualContext?.manual !== undefined
                const copy =
                    kind === 'add'
                        ? 'Photograph each page of your manual, one at a time.'
                        : hasManual
                          ? 'Pick up where you left off.'
                          : 'Add a manual to start building.'
                const action =
                    kind === 'guide'
                        ? { label: 'Take photo', intent: { intent: 'capture', target: 'take-photo' } }
                        : kind === 'result'
                          ? { label: 'Retake photo', intent: { intent: 'capture', target: 'retake' } }
                          : kind === 'add'
                            ? { label: 'Take photo', intent: { intent: 'capture', target: 'take-photo' } }
                            : hasManual
                              ? { label: 'Continue building', intent: { intent: 'navigate', target: 'guide' } }
                              : { label: 'Add a manual', intent: { intent: 'navigate', target: 'add' } }
                // The simulated model names every required manual fact in one directions block, as the prompt asks.
                const required = (screen?.manualFacts ?? []).filter(
                    (fact) => scenario === 'all-directions' || fact.basis !== 'direction',
                )
                const proposal = invalid
                    ? { header: { type: 'ScreenHeader', title: 'Broken' } }
                    : {
                          header: { type: 'ScreenHeader', title: headerTitle, subtitle: null, trailing: null },
                          body: [
                              {
                                  type: 'Instruction',
                                  text: unsupported ? 'Insert 99 bolts into the frame now.' : (title?.text ?? copy),
                                  emphasis: 'strong',
                                  citations: unsupported ? [0] : [],
                              },
                              ...(required.length === 0 || unsupported || scenario === 'no-directions'
                                  ? []
                                  : [
                                        {
                                            type: 'ManualDirections',
                                            factIds: required.map((fact) => fact.id),
                                            emphasis: 'strong',
                                        },
                                    ]),
                          ],
                          bar: {
                              primary: {
                                  type: 'PrimaryAction',
                                  label: action.label,
                                  icon: null,
                                  intent: action.intent,
                              },
                              secondary: null,
                          },
                      }
                outgoing.setHeader('content-type', 'application/json')
                outgoing.end(
                    JSON.stringify({
                        ...responseEnvelope(
                            request.model,
                            scenario === 'incomplete' ? 'incomplete' : 'completed',
                            [],
                            {},
                        ),
                        output:
                            scenario === 'incomplete'
                                ? []
                                : [
                                      { type: 'reasoning', id: 'mock-reasoning', summary: [] },
                                      {
                                          id: 'msg-842549258569147',
                                          type: 'message',
                                          role: 'assistant',
                                          status: 'completed',
                                          content: [
                                              {
                                                  type: 'output_text',
                                                  text:
                                                      scenario === 'not-json'
                                                          ? 'not json at all'
                                                          : JSON.stringify(proposal),
                                                  annotations: [],
                                              },
                                          ],
                                      },
                                  ],
                        // `no-usage`: the provider reports no usage at all for the first call (a repair then reports it).
                        usage:
                            scenario === 'no-usage' && !repairing
                                ? {}
                                : {
                                      input_tokens: 400,
                                      input_tokens_details: { cached_tokens: 0 },
                                      output_tokens: 90,
                                      output_tokens_details: { reasoning_tokens: 30 },
                                      total_tokens: 490,
                                  },
                    }),
                )
                return
            }
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
            {
                const wire = defaultWire(operation, request.model, Boolean(secondary))
                assert.equal(request.reasoning?.effort, wire.effort)
                assert.equal(request.max_output_tokens, wire.maxOutputTokens)
            }
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
            if (operation === 'question' && options.question?.delayMs) {
                await new Promise<void>((resolve) => {
                    const done = (): void => {
                        clearTimeout(timer)
                        outgoing.off('close', done)
                        resolve()
                    }
                    const timer = setTimeout(done, options.question?.delayMs)
                    outgoing.once('close', done)
                })
                if (outgoing.destroyed) return
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
            if (operation === 'overlay' && options.overlay?.delayMs) {
                await new Promise<void>((resolve) => setTimeout(resolve, options.overlay?.delayMs))
            }
            const value =
                operation === 'overlay'
                    ? {
                          observedRegion: options.overlay?.observedRegion ?? null,
                          layout: null,
                          nextPartRegion: options.overlay?.nextPartRegion ?? null,
                          targetRegion: null,
                      }
                    : operation === 'parse'
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
                                  scenario === 'correct'
                                      ? 'correct'
                                      : scenario === 'reversed'
                                        ? 'reversed'
                                        : 'uncertain',
                              decision:
                                  scenario === 'correct'
                                      ? 'pass'
                                      : scenario === 'reversed'
                                        ? 'refuse'
                                        : 'cannot_verify',
                              reason: 'TEST MOCK ONLY: synthetic provider-boundary result.',
                              sourceRefs: citations,
                              observedRegion: scenario === 'reversed' ? { x1: 300, y1: 200, x2: 500, y2: 850 } : null,
                              missingEvidence:
                                  scenario === 'correct' || scenario === 'reversed'
                                      ? []
                                      : ['TEST MOCK: no real visual evaluation'],
                          }
            const localized: typeof value =
                stable.language === 'pt-BR'
                    ? JSON.parse(
                          JSON.stringify(value, (_key, text: unknown): unknown =>
                              typeof text === 'string' ? (PORTUGUESE_COPY[text] ?? text) : text,
                          ),
                      )
                    : value
            if (!secondary) requests.push({ path: '/v1/responses', operation })
            // A strict schema admits exactly its listed properties, so a faithful model emits no others (a verdict-only
            // check has no geometry property to fill).
            const allowed = request.text.format.schema.properties
            const emitted =
                allowed && typeof allowed === 'object'
                    ? Object.fromEntries(Object.entries(localized).filter(([key]) => key in allowed))
                    : localized
            const response = {
                ...responseEnvelope(request.model, 'completed', [], {}),
                output: [
                    { type: 'reasoning', id: 'mock-reasoning', summary: [] },
                    {
                        id: 'msg-842549258569147',
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: JSON.stringify(emitted), annotations: [] }],
                    },
                ],
                usage: {
                    input_tokens: 100,
                    input_tokens_details: { cached_tokens: 50 },
                    output_tokens: 20,
                    output_tokens_details: { reasoning_tokens: 5 },
                    total_tokens: 120,
                },
            }
            if (operation === 'parse' && request.model === 'muse-spark-1.3') {
                outgoing.setHeader('content-type', 'text/event-stream')
                outgoing.end(
                    event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }) +
                        event({ type: 'response.completed', response }),
                )
            } else {
                outgoing.setHeader('content-type', 'application/json')
                outgoing.end(JSON.stringify(response))
            }
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
        screenDispatches: (): number => screenCalls,
        close: async (): Promise<void> => {
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        },
    }
}
