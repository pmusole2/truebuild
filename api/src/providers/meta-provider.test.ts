import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createDemoManual, manualSessionSchema, type CheckResult, type ParsedManual } from '@truebuild/contracts'
import sharp from 'sharp'
import { createHeroResponse } from '@truebuild/contracts/hero'
import { describe, expect, it, vi } from 'vitest'

import { createMetaProvider, MetaProviderError, type CheckStepInput, type MetaProvider } from './meta-provider'

const ENDPOINT = 'https://api.meta.ai/v1/responses'
const signal = (): AbortSignal => new AbortController().signal
const result: CheckResult = {
    orientationAssessment: 'correct',
    decision: 'pass',
    reason: 'The visible connection matches the cited source.',
    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
    observedRegion: null,
    missingEvidence: [],
}

function responseBody(value: unknown): Record<string, unknown> {
    return {
        status: 'completed',
        output: [
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
            },
        ],
    }
}

async function validInput(): Promise<CheckStepInput> {
    const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#aaaaaa' } })
        .png()
        .toBuffer()
    const session = createDemoManual()
    const page = session.pages[0]

    if (!page) {
        throw new Error('Missing generated page')
    }

    page.width = 8
    page.height = 4
    page.mimeType = 'image/png'
    page.contentHash = createHash('sha256').update(bytes).digest('hex')

    return {
        requestId: 'local-1',
        binding: {
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: 'step-1',
            captureId: 'capture-1',
        },
        session,
        sourceImages: [{ page, bytes }],
        observation: { bytes, mimeType: 'image/png', width: 8, height: 4 },
    }
}

type Responder = (response: ServerResponse) => void

interface LocalTransport {
    provider: MetaProvider
    bodies: unknown[]
    dispatches(): number
}

async function localServer(
    respond: Responder,
    run: (transport: LocalTransport) => Promise<void>,
    observeResponse?: (response: Response) => void,
): Promise<void> {
    const bodies: unknown[] = []
    let dispatches = 0
    const server = createServer((request: IncomingMessage, response: ServerResponse): void => {
        dispatches += 1
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer): void => {
            chunks.push(chunk)
        })
        request.on('end', (): void => {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            bodies.push(body)
            respond(response)
        })
    })
    await new Promise<void>((resolve): void => {
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()

    if (address === null || typeof address === 'string') {
        throw new Error('Local server unavailable')
    }

    const fetchImpl: typeof fetch = async (input, init): Promise<Response> => {
        expect(input).toBe(ENDPOINT)

        const response = await fetch(`http://127.0.0.1:${address.port}/responses`, init)
        observeResponse?.(response)

        return response
    }

    try {
        await run({
            provider: createMetaProvider({ apiKey: 'synthetic-test-key', fetchImpl }),
            bodies,
            dispatches: (): number => dispatches,
        })
    } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject): void => {
            server.close((error): void => (error ? reject(error) : resolve()))
        })
    }
}

function jsonResponder(body: unknown): Responder {
    return (response): void => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(body))
    }
}

describe('inactive direct Meta transport', (): void => {
    it.each(['correct', 'reversed', 'uncertain'] as const)(
        'accepts conservative synthetic %s orientation',
        async (orientation) => {
            const value = createHeroResponse(orientation)
            await localServer(jsonResponder(responseBody(value)), async (transport) => {
                expect(await transport.provider.checkStep(await validInput(), signal())).toEqual(value)
                expect(JSON.stringify(transport.bodies[0])).toContain('ORIENTATION ASSESSMENT')
            })
        },
    )

    it('rejects a new panel pass that omits the optional public orientation field', async () => {
        const { orientationAssessment: _, ...legacyPass } = result
        await localServer(jsonResponder(responseBody(legacyPass)), async (transport) => {
            await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                code: 'invalid_output',
            })
            expect(transport.dispatches()).toBe(1)
        })
    })

    it('recognizes a panel by its reviewed name even when parsed IDs are opaque', async () => {
        const { orientationAssessment: _, ...legacyPass } = result
        await localServer(jsonResponder(responseBody(legacyPass)), async (transport) => {
            const input = await validInput()
            input.session = manualSessionSchema.parse(
                JSON.parse(JSON.stringify(input.session).replaceAll('side-panel', 'part-01')),
            )
            await expect(transport.provider.checkStep(input, signal())).rejects.toMatchObject({
                code: 'invalid_output',
            })
        })
    })

    it('recognizes underscore-separated panel identities without relying on a groove description', async () => {
        const { orientationAssessment: _, ...legacyPass } = result
        await localServer(jsonResponder(responseBody(legacyPass)), async (transport) => {
            const input = await validInput()
            input.session = manualSessionSchema.parse(
                JSON.parse(
                    JSON.stringify(input.session)
                        .replaceAll('side-panel', 'side_panel')
                        .replaceAll('Side panel', 'side_panel'),
                ),
            )
            const orientation = input.session.reviewedSteps[0]!.orientation
            if (orientation.state === 'known') {
                orientation.value.description = 'Marked face points inward.'
            }
            await expect(transport.provider.checkStep(input, signal())).rejects.toMatchObject({
                code: 'invalid_output',
            })
        })
    })

    it('rejects explicit correct orientation without the expected diagram citation', async () => {
        const value = {
            ...result,
            sourceRefs: [{ pageId: 'demo-page-1', region: { x: 0, y: 0, width: 0.1, height: 0.1 } }],
        }
        await localServer(jsonResponder(responseBody(value)), async (transport) => {
            await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                code: 'invalid_output',
            })
        })
    })

    it('rejects reversed citations that do not identify the expected orientation diagram', async () => {
        const value = createHeroResponse('reversed')
        value.sourceRefs = [{ pageId: 'demo-page-1', region: { x: 0, y: 0, width: 0.1, height: 0.1 } }]
        await localServer(jsonResponder(responseBody(value)), async (transport) => {
            await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                code: 'invalid_output',
            })
        })
    })

    it.each([
        { ...createHeroResponse('reversed'), decision: 'pass' },
        { ...createHeroResponse('uncertain'), decision: 'pass', missingEvidence: [] },
    ])('rejects a confident contradictory orientation result %#', async (value) => {
        await localServer(jsonResponder(responseBody(value)), async (transport) => {
            await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                code: 'invalid_output',
            })
        })
    })

    it('accepts only a positive check budget at or below eight seconds', () => {
        expect(() => createMetaProvider({ checkTimeoutMs: 500 })).not.toThrow()
        for (const checkTimeoutMs of [0, -1, NaN, Infinity, 8001]) {
            expect(() => createMetaProvider({ checkTimeoutMs })).toThrow(MetaProviderError)
        }
    })

    it('fails unconfigured before any validation/media/network work', async (): Promise<void> => {
        const fetchImpl = vi.fn<typeof fetch>()
        const input = await validInput()
        input.observation.bytes = new Uint8Array(0)
        await expect(createMetaProvider({ fetchImpl }).checkStep(input, signal())).rejects.toMatchObject({
            code: 'unconfigured',
            message: 'unconfigured',
        })
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('sends one fixed Standard-model request with inline normalized media and strict schema', async (): Promise<void> => {
        await localServer(jsonResponder(responseBody(result)), async (transport): Promise<void> => {
            const input = await validInput()
            expect(await transport.provider.checkStep(input, signal())).toEqual(result)
            expect(transport.dispatches()).toBe(1)
            expect(transport.bodies[0]).toMatchObject({
                model: 'muse-spark-1.3',
                store: false,
                stream: false,
                max_output_tokens: 1500,
                text: {
                    format: {
                        type: 'json_schema',
                        strict: true,
                        schema: { type: 'object', additionalProperties: false },
                    },
                },
                input: [
                    {
                        role: 'user',
                        content: expect.arrayContaining([
                            expect.objectContaining({
                                type: 'input_image',
                                image_url: expect.stringMatching(/^data:image\/jpeg;base64,/),
                            }),
                        ]),
                    },
                ],
            })
            const body = JSON.stringify(transport.bodies[0])

            expect(body).not.toContain('step-2')
            expect(body).not.toContain('previous_response_id')
            expect(body).not.toContain('tools')
            expect(body).not.toContain('file_id')
            expect(body).not.toContain('contributor')
        })
    })

    it('parses selected pages preserving explicit unknowns and unreviewed corrections', async (): Promise<void> => {
        const input = await validInput()
        const parsed: ParsedManual = {
            parts: input.session.parts,
            steps: input.session.reviewedSteps.map((step) => ({
                ...step,
                correction: step.correction ? { ...step.correction, reviewed: false } : null,
            })),
            unknowns: ['The hidden screw head cannot be read.'],
        }

        await localServer(jsonResponder(responseBody(parsed)), async (transport): Promise<void> => {
            expect(
                await transport.provider.parseManual(
                    {
                        requestId: input.requestId,
                        binding: { kind: 'manual', manualId: input.binding.manualId, revision: input.binding.revision },
                        pages: input.sourceImages,
                    },
                    signal(),
                ),
            ).toEqual(parsed)
            expect(transport.dispatches()).toBe(1)
        })
    })

    it('answers an observation-bound question with cited output', async (): Promise<void> => {
        const answer = { answer: 'Use the cited visible edge.', sourceRefs: result.sourceRefs, missingEvidence: [] }

        await localServer(jsonResponder(responseBody(answer)), async (transport): Promise<void> => {
            expect(
                await transport.provider.answerQuestion(
                    {
                        ...(await validInput()),
                        question: 'Which way?',
                        target: { kind: 'point', x: 0.3, y: 0.4 },
                    },
                    signal(),
                ),
            ).toEqual(answer)
            expect(transport.dispatches()).toBe(1)
        })
    })

    it('rejects extraction references outside the selected source pages', async (): Promise<void> => {
        const input = await validInput()
        const extracted: ParsedManual = { parts: input.session.parts, steps: [], unknowns: [] }

        for (const part of extracted.parts) {
            if (part.name.state === 'known') {
                part.name.sourceRefs = [{ pageId: 'unsubmitted-page', region: null }]
            }
        }

        await localServer(jsonResponder(responseBody(extracted)), async (transport): Promise<void> => {
            await expect(
                transport.provider.parseManual(
                    {
                        requestId: input.requestId,
                        binding: { kind: 'manual', manualId: input.binding.manualId, revision: input.binding.revision },
                        pages: input.sourceImages,
                    },
                    signal(),
                ),
            ).rejects.toMatchObject({ code: 'invalid_output' })
            expect(transport.dispatches()).toBe(1)
        })
    })

    it('rejects stale/unreviewed/mismatched source contexts before dispatch', async (): Promise<void> => {
        const fetchImpl = vi.fn<typeof fetch>()
        const provider = createMetaProvider({ apiKey: 'synthetic-test-key', fetchImpl })

        for (const variant of [
            'stale',
            'unreviewed',
            'unknown-orientation',
            'foreign-source',
            'changed-bytes',
            'bad-step',
        ] as const) {
            const input = await validInput()

            if (variant === 'stale') {
                input.binding.revision += 1
            }
            if (variant === 'unreviewed') {
                input.session.reviewStatus = 'unreviewed'
            }
            if (variant === 'unknown-orientation') {
                input.session.reviewedSteps[0]!.orientation = {
                    state: 'unknown',
                    reason: 'Facing direction is hidden.',
                }
            }
            if (variant === 'foreign-source' && input.sourceImages[0]) {
                input.sourceImages[0].page = { ...input.sourceImages[0].page, assetId: 'foreign' }
            }
            if (variant === 'changed-bytes' && input.sourceImages[0]) {
                input.sourceImages[0].bytes = new Uint8Array([1, 2, 3])
            }
            if (variant === 'bad-step') {
                input.binding.stepId = 'not-a-step'
            }

            await expect(provider.checkStep(input, signal())).rejects.toMatchObject({ code: 'invalid_input' })
        }

        await expect(
            provider.answerQuestion(
                {
                    ...(await validInput()),
                    question: 'Which?',
                    target: { kind: 'part', partId: 'missing' },
                },
                signal(),
            ),
        ).rejects.toMatchObject({ code: 'invalid_input' })
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it.each([
        { status: 'incomplete', output: [] },
        { status: 'completed', output: [{ type: 'function_call', name: 'unsafe' }] },
        {
            status: 'completed',
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'refusal', refusal: 'private refusal' }],
                },
            ],
        },
        { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [] }] },
        responseBody({ ...result, sourceRefs: [{ pageId: 'wrong-page', region: null }] }),
        responseBody({ ...result, sourceRefs: [] }),
    ])('rejects incomplete/refusal/tool/semantic output without retry: %#', async (body): Promise<void> => {
        await localServer(jsonResponder(body), async (transport): Promise<void> => {
            await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                code: 'invalid_output',
                message: 'invalid_output',
            })
            expect(transport.dispatches()).toBe(1)
        })
    })

    it('rejects multiple text payloads and invalid model JSON', async (): Promise<void> => {
        for (const texts of [[JSON.stringify(result), JSON.stringify(result)], ['private malformed JSON']]) {
            const body = {
                status: 'completed',
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: texts.map((text) => ({ type: 'output_text', text })),
                    },
                ],
            }

            await localServer(jsonResponder(body), async (transport): Promise<void> => {
                await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                    code: 'invalid_output',
                    message: 'invalid_output',
                })
                expect(transport.dispatches()).toBe(1)
            })
        }
    })

    it('bounds response bytes, content type, partial JSON and HTTP failures without raw leakage', async (): Promise<void> => {
        const cases: Responder[] = [
            (response): void => {
                response.setHeader('content-type', 'text/plain')
                response.end('private raw text')
            },
            (response): void => {
                response.setHeader('content-type', 'application/json')
                response.end('{"private":')
            },
            (response): void => {
                response.setHeader('content-type', 'application/json')
                response.end('x'.repeat(1_048_577))
            },
            (response): void => {
                response.setHeader('content-type', 'application/json')
                response.write('x'.repeat(524_289))
                response.end('x'.repeat(524_289))
            },
            (response): void => {
                response.setHeader('content-type', 'application/json')
                response.end(Buffer.from([0xff]))
            },
            (response): void => {
                response.statusCode = 429
                response.end('private provider detail')
            },
            (response): void => {
                response.destroy()
            },
        ]

        for (const respond of cases) {
            await localServer(respond, async (transport): Promise<void> => {
                try {
                    await transport.provider.checkStep(await validInput(), signal())
                    throw new Error('Expected provider rejection')
                } catch (error: unknown) {
                    expect(error).toBeInstanceOf(MetaProviderError)
                    expect(error instanceof Error ? error.message : '').toMatch(/^(invalid_output|provider_error)$/)
                    expect(transport.dispatches()).toBe(1)
                }
            })
        }
    })

    it('cancels a partial response body with no retry or late success', async (): Promise<void> => {
        const parent = new AbortController()

        await localServer(
            (response): void => {
                response.setHeader('content-type', 'application/json')
                response.write('{"status":')
                parent.abort('private abort reason')
            },
            async (transport): Promise<void> => {
                await expect(transport.provider.checkStep(await validInput(), parent.signal)).rejects.toMatchObject({
                    code: 'provider_error',
                    message: 'provider_error',
                })
                expect(transport.dispatches()).toBe(1)
            },
        )
    })

    it('applies the eight-second deadline to a stalled response body', async (): Promise<void> => {
        await localServer(
            (response): void => {
                response.setHeader('content-type', 'application/json')
                response.write('{"status":')
            },
            async (transport): Promise<void> => {
                await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                    code: 'timeout',
                    message: 'timeout',
                })
                expect(transport.dispatches()).toBe(1)
            },
        )
    }, 12_000)

    it('rejects an absolute deadline crossed before timer callbacks can run', async (): Promise<void> => {
        let monotonic = 100
        const clock = vi.spyOn(performance, 'now').mockImplementation((): number => monotonic)

        try {
            await localServer(
                (response): void => {
                    monotonic += 8_001
                    jsonResponder(responseBody(result))(response)
                },
                async (transport): Promise<void> => {
                    await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                        code: 'timeout',
                        message: 'timeout',
                    })
                    expect(transport.dispatches()).toBe(1)
                },
            )
        } finally {
            clock.mockRestore()
        }
    })

    it('owns and cancels a settled body when a delayed continuation crosses the deadline', async (): Promise<void> => {
        let monotonic = 100
        const clock = vi.spyOn(performance, 'now').mockImplementation((): number => monotonic)
        let cancelled = false

        try {
            await localServer(
                jsonResponder(responseBody(result)),
                async (transport): Promise<void> => {
                    await expect(transport.provider.checkStep(await validInput(), signal())).rejects.toMatchObject({
                        code: 'timeout',
                    })
                    expect(cancelled).toBe(true)
                },
                (response): void => {
                    monotonic += 8_001

                    if (response.body) {
                        const original = response.body.cancel.bind(response.body)
                        vi.spyOn(response.body, 'cancel').mockImplementation(async (reason): Promise<void> => {
                            cancelled = true
                            await original(reason)
                        })
                    }
                },
            )
        } finally {
            clock.mockRestore()
        }
    })
})
