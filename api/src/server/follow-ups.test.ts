import { createHash } from 'node:crypto'

import { createDemoManual, segmentEventSchema } from '@truebuild/contracts'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../app'
import type { ShownScreen } from '../providers/shown-screen'
import { MOCK_PROVIDER_KEY, startMetaMock } from '../test-support/meta-http-mock'
import { createRuntimeFromEnvironment } from './model-runtime'

// The provider is the documented loopback mock only: no Meta request, key or recorded output is involved.
const KEY = 'synthetic-local-test-value'
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()))
    vi.restoreAllMocks()
})

async function media(): Promise<{ session: ReturnType<typeof createDemoManual>; bytes: Uint8Array<ArrayBuffer> }> {
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
    return { session, bytes }
}

interface Booted {
    app: ReturnType<typeof createApp>
    mock: Awaited<ReturnType<typeof startMetaMock>>
    runtime: ReturnType<typeof createRuntimeFromEnvironment>
    form: (extra?: Record<string, unknown>, observation?: Uint8Array<ArrayBuffer>) => FormData
    send: (path: string, body: FormData) => Promise<Response>
    session: ReturnType<typeof createDemoManual>
    partId: string
    bytes: Uint8Array<ArrayBuffer>
    binding: { kind: 'capture'; manualId: string; revision: number; stepId: string; captureId: string }
}

async function boot(
    env: Record<string, string> = {},
    mockOptions: Parameters<typeof startMetaMock>[0] = {},
): Promise<Booted> {
    vi.spyOn(console, 'info').mockImplementation((): void => {})
    const mock = await startMetaMock({ scenario: 'uncertain', ...mockOptions })
    closers.push(() => mock.close())
    const runtime = createRuntimeFromEnvironment(
        { PROVIDER_MODE: 'meta', MODEL_API_KEY: '<synthetic>', API_SHARED_SECRET: KEY, ...env },
        mock.transport,
    )
    const app = createApp({ runtime, onDuration: () => {} })
    const { session, bytes } = await media()
    const binding = {
        kind: 'capture' as const,
        manualId: session.manualId,
        revision: session.revision,
        stepId: 'step-1',
        captureId: 'capture-1',
    }
    const partId = session.reviewedSteps[0]!.parts[0]!.partId
    const form = (extra: Record<string, unknown> = {}, observation: Uint8Array<ArrayBuffer> = bytes): FormData => {
        const body = new FormData()
        body.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'followup-test',
                binding,
                session,
                sourcePageIds: ['demo-page-1'],
                observation: { mimeType: 'image/png', width: 20, height: 16 },
                ...extra,
            }),
        )
        body.set('source-0', new Blob([bytes], { type: 'image/png' }), 'source.png')
        body.set('observation', new Blob([observation], { type: 'image/png' }), 'observation.png')
        return body
    }
    const send = async (path: string, body: FormData): Promise<Response> =>
        app.request(path, { method: 'POST', headers: { 'x-truebuild-key': KEY }, body })
    return { app, mock, runtime, form, send, session, partId, bytes, binding }
}

function newerRevisionForm(session: Booted['session']): FormData {
    const body = new FormData()
    body.set(
        'metadata',
        JSON.stringify({
            mode: 'model',
            requestId: 'newer',
            op: 'generate',
            kind: 'home',
            binding: { kind: 'manual', manualId: session.manualId, revision: session.revision + 1 },
            session: { ...session, revision: session.revision + 1 },
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            focusStepId: null,
            want: [],
        }),
    )
    return body
}

describe('verdict follow-ups', (): void => {
    it('publishes the verdict first and offers separate overlay and SAM work plus the stronger second opinion', async (): Promise<void> => {
        const { send, form, mock, session } = await boot({}, { overlay: { delayMs: 300 } })
        const response = await send('/api/checks', form())
        const { value } = await response.json()
        expect(value).toMatchObject({
            decision: 'cannot_verify',
            model: 'muse-spark-1.3',
            secondOpinion: { model: 'muse-wonder-1.0', status: 'available' },
            followUps: {
                overlay: { status: 'available', model: 'muse-wonder-1.0' },
                segments: { status: 'available', model: 'sam-3.1' },
            },
        })
        // Prompts are built only from validated part names of this step.
        const names = session.parts.flatMap((part) => (part.name.state === 'known' ? [part.name.value] : []))
        expect(value.followUps.segments.prompts.length).toBeGreaterThan(0)
        for (const prompt of value.followUps.segments.prompts) expect(names).toContain(prompt)
        // The verdict did not wait for the overlay: it has not even been requested yet.
        expect(mock.requests.map((request) => request.operation)).toEqual(['check'])
    })

    it('adds nothing and keeps the exact previous shape when GENERATIVE_UI is off', async (): Promise<void> => {
        const { send, form } = await boot({ GENERATIVE_UI: 'off', MODEL_SECOND_OPINION: 'off' })
        const { value } = await (await send('/api/checks', form())).json()
        expect(value).not.toHaveProperty('followUps')
        expect(value).not.toHaveProperty('secondOpinion')
        const overlay = await send('/api/checks/overlay', form({ overlayToken: 'x' }))
        expect(overlay.status).toBe(503)
    })

    it('keeps the second opinion independent of GENERATIVE_UI: off alone removes screens and follow-ups, nothing else', async (): Promise<void> => {
        // Documented decision: GENERATIVE_UI=off is "no new screen or overlay UI". Model quality settings (the stronger
        // second opinion, effort, telemetry) are their own flags, so the public shape gains only optional fields.
        const { send, form, mock } = await boot({ GENERATIVE_UI: 'off' }, { scenario: 'reversed' })
        const { value } = await (await send('/api/checks', form())).json()
        expect(value).not.toHaveProperty('followUps')
        expect(value.telemetry).toMatchObject({ stage: 'verdict' })
        // The previous still-highlight request, since no overlay stage will follow.
        expect(value.observedRegion).toMatchObject({ x: 0.3 })
        expect(Object.keys((mock.wireRequests[0]!.text!.format.schema as { properties: object }).properties)).toContain(
            'observedRegion',
        )
        const uncertain = await boot({ GENERATIVE_UI: 'off' }, { scenario: 'uncertain' })
        const { value: unsure } = await (await uncertain.send('/api/checks', uncertain.form())).json()
        expect(unsure.secondOpinion).toMatchObject({ model: 'muse-wonder-1.0', status: 'available' })
    })

    it('stops offering the overlay when MODEL_LAYOUT_WONDER and MODEL_SEGMENTS are off', async (): Promise<void> => {
        const { send, form } = await boot({ MODEL_LAYOUT_WONDER: '0', MODEL_SEGMENTS: '0' })
        const { value } = await (await send('/api/checks', form())).json()
        expect(value).not.toHaveProperty('followUps')
        expect((await send('/api/segments', form())).status).toBe(503)
    })
})

describe('asynchronous overlay', (): void => {
    async function overlayFor(
        env: Record<string, string> = {},
        mockOverlay: Parameters<typeof startMetaMock>[0] = {},
    ): Promise<Booted & { token: string }> {
        const context = await boot(env, mockOverlay)
        const { value } = await (await context.send('/api/checks', context.form())).json()
        return { ...context, token: value.followUps.overlay.token as string }
    }

    it('adds only validated presentation guidance and has no way to change the decision', async (): Promise<void> => {
        const probe = await boot()
        const context = await overlayFor(
            {},
            {
                overlay: {
                    observedRegion: { x1: 100, y1: 100, x2: 600, y2: 700 },
                    nextPartRegion: { partId: probe.partId, region: { x1: 200, y1: 200, x2: 500, y2: 500 } },
                },
            },
        )
        const response = await context.send('/api/checks/overlay', context.form({ overlayToken: context.token }))
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toMatchObject({
            status: 'ok',
            mode: 'model',
            binding: context.binding,
            value: {
                model: 'muse-wonder-1.0',
                effort: 'medium',
                observedRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.6 },
                nextPartRegion: { partId: context.partId, region: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } },
                layout: { source: 'fallback' },
            },
        })
        expect(body.value).not.toHaveProperty('decision')
        expect(body.value).not.toHaveProperty('reason')
        // The verdict decision was fixed context for the model, never an output field.
        const wire = context.mock.wireRequests.at(-1)!
        expect(wire.text?.format.name).toBe('truebuild_overlay')
        expect(Object.keys((wire.text!.format.schema as { properties: object }).properties).sort()).toEqual([
            'layout',
            'nextPartRegion',
            'observedRegion',
            'targetRegion',
        ])
    })

    it('drops a region for a part the step does not have and one outside the image, never inventing either', async (): Promise<void> => {
        const unknown = await overlayFor(
            {},
            {
                overlay: {
                    nextPartRegion: { partId: 'not-in-this-step', region: { x1: 100, y1: 100, x2: 300, y2: 300 } },
                },
            },
        )
        const first = await (
            await unknown.send('/api/checks/overlay', unknown.form({ overlayToken: unknown.token }))
        ).json()
        expect(first.value).not.toHaveProperty('nextPartRegion')
        const outside = await overlayFor(
            {},
            { overlay: { nextPartRegion: { partId: 'x', region: { x1: 100, y1: 100, x2: 1200, y2: 300 } } } },
        )
        const second = await (
            await outside.send('/api/checks/overlay', outside.form({ overlayToken: outside.token }))
        ).json()
        expect(second.value).not.toHaveProperty('nextPartRegion')
        expect(second.value.observedRegion).toBeNull()
    })

    it('is one-use custody bound to the exact photo: replay and a different photo are refused', async (): Promise<void> => {
        const context = await overlayFor()
        const other = new Uint8Array(
            await sharp({ create: { width: 20, height: 16, channels: 3, background: 'blue' } })
                .png()
                .toBuffer(),
        )
        const swapped = await context.send('/api/checks/overlay', context.form({ overlayToken: context.token }, other))
        expect(swapped.status).toBe(409)
        const replay = await context.send('/api/checks/overlay', context.form({ overlayToken: context.token }))
        expect(replay.status).toBe(409)
        expect(await replay.json()).toMatchObject({ status: 'unavailable', code: 'duplicate_request' })
    })

    it('is refused for a manual revision older than one already seen', async (): Promise<void> => {
        const context = await overlayFor()
        await context.send('/api/screens', newerRevisionForm(context.session))
        const response = await context.send('/api/checks/overlay', context.form({ overlayToken: context.token }))
        expect(response.status).toBe(409)
    })
})

describe('SAM stage after the verdict', (): void => {
    it('carries the validated mask for the native outline and server-observed stage metadata', async (): Promise<void> => {
        const context = await boot({}, { scenario: 'correct' })
        const form = new FormData()
        form.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'sam-test',
                binding: context.binding,
                capturedAt: '2026-01-01T00:00:00.000Z',
                prompt: 'divider',
                media: { kind: 'image', mimeType: 'image/png', width: 20, height: 16 },
            }),
        )
        form.set('media', new Blob([context.bytes], { type: 'image/png' }), 'media.png')
        const response = await context.send('/api/segments', form)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        const events = (await response.text())
            .split('\n\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)))
        const snapshot = events
            .map((event) => segmentEventSchema.parse(event.value))
            .find((event) => event.type === 'snapshot')
        expect(snapshot?.type === 'snapshot' && snapshot.snapshot.records[0]?.mask).toMatchObject({
            width: expect.any(Number),
            height: expect.any(Number),
            path: expect.stringMatching(/^M/u),
        })
        expect(snapshot?.type === 'snapshot' && snapshot.snapshot.stage).toMatchObject({
            model: 'sam-3.1',
            elapsedMs: expect.any(Number),
        })
    })
})

describe('verdict-only Spark call and observed telemetry', (): void => {
    it('asks Spark for a decision and evidence without any geometry, and a grounded refusal needs no region', async (): Promise<void> => {
        const { send, form, mock } = await boot({}, { scenario: 'reversed' })
        const response = await send('/api/checks', form())
        expect(response.status).toBe(200)
        const { value } = await response.json()
        expect(value).toMatchObject({ decision: 'refuse', observedRegion: null, orientationAssessment: 'reversed' })
        expect(value.sourceRefs.length).toBeGreaterThan(0)
        const properties = Object.keys((mock.wireRequests[0]!.text!.format.schema as { properties: object }).properties)
        for (const geometry of ['observedRegion', 'layout', 'nextPartRegion', 'targetRegion']) {
            expect(properties).not.toContain(geometry)
        }
        // The evidence the decision rests on is still asked for.
        expect(properties).toEqual(
            expect.arrayContaining(['partsAssessment', 'connectionAssessment', 'checks', 'orientationAssessment']),
        )
        const sent = JSON.stringify(mock.wireRequests[0]!.input)
        expect(sent).toContain('Verdict only')
    })

    it('keeps the previous still-highlight request when no overlay stage is offered', async (): Promise<void> => {
        const { send, form, mock } = await boot({ MODEL_LAYOUT_WONDER: '0' }, { scenario: 'reversed' })
        const { value } = await (await send('/api/checks', form())).json()
        expect(value.observedRegion).toMatchObject({ x: 0.3, y: 0.2 })
        expect(Object.keys((mock.wireRequests[0]!.text!.format.schema as { properties: object }).properties)).toContain(
            'observedRegion',
        )
    })

    it('attaches the observed call to the public verdict and overlay: unknown stays null, nothing is invented', async (): Promise<void> => {
        const { send, form } = await boot({}, { scenario: 'uncertain' })
        const { value } = await (await send('/api/checks', form())).json()
        expect(value.telemetry).toMatchObject({
            stage: 'verdict',
            model: 'muse-spark-1.3',
            effort: 'low',
            // Exactly what the simulated provider reported; the cached-token field is its own number.
            usage: { inputTokens: 100, cachedTokens: 50, outputTokens: 20, reasoningTokens: 5 },
        })
        const timing = value.telemetry.timing as Record<string, number | null>
        for (const stage of [
            'timeToProviderMs',
            'paceWaitMs',
            'networkMs',
            'bodyMs',
            'providerMs',
            'parseValidateMs',
            'totalMs',
        ]) {
            expect(timing[stage]).toEqual(expect.any(Number))
        }
        // providerMs is dispatch to end of body: pace + network + body, measured separately from validation.
        expect(timing.providerMs!).toBeGreaterThanOrEqual(timing.networkMs! + timing.bodyMs! - 1)
        expect(timing.totalMs!).toBeGreaterThanOrEqual(timing.timeToProviderMs! + timing.providerMs! - 1)
        const overlay = await send('/api/checks/overlay', form({ overlayToken: value.followUps.overlay.token }))
        const result = (await overlay.json()).value
        expect(result.telemetry).toMatchObject({ stage: 'overlay', model: 'muse-wonder-1.0', effort: 'medium' })
    })

    it('starts the clock at real admission, so a slow request body counts as time before the provider', async (): Promise<void> => {
        const { app, form, mock } = await boot({}, { scenario: 'uncertain' })
        const encoded = new Response(form())
        const bytes = new Uint8Array(await encoded.arrayBuffer())
        const headers = { 'content-type': encoded.headers.get('content-type')!, 'x-truebuild-key': KEY }
        const half = Math.floor(bytes.length / 2)
        const body = new ReadableStream<Uint8Array>({
            async start(controller): Promise<void> {
                controller.enqueue(bytes.slice(0, half))
                await new Promise((resolve) => setTimeout(resolve, 250))
                controller.enqueue(bytes.slice(half))
                controller.close()
            },
        })
        const response = await app.request('/api/checks', {
            method: 'POST',
            headers,
            body,
            duplex: 'half',
        } as RequestInit)
        expect(response.status).toBe(200)
        const { value } = await response.json()
        expect(value.telemetry.timing.timeToProviderMs).toBeGreaterThanOrEqual(240)
        expect(value.telemetry.timing.providerMs).toBeLessThan(240)
        expect(mock.requests.map((request) => request.operation)).toEqual(['check'])
    })

    it('logs one outcome line per request with the path, model, effort and timing and no body or credential', async (): Promise<void> => {
        const { send, form } = await boot({}, { scenario: 'uncertain' })
        const info = vi.spyOn(console, 'info').mockImplementation((): void => {})
        await send('/api/checks', form())
        const logged = info.mock.calls.map((call) => String(call[0]))
        const outcome = logged
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((line) => line.event === 'model_outcome')
        expect(outcome).toMatchObject({
            route: 'check',
            outcome: 'ok',
            path: 'verdict-only',
            source: 'provider',
            model: 'muse-spark-1.3',
            effort: 'low',
            stage: 'verdict',
            totalMs: expect.any(Number),
            timeToProviderMs: expect.any(Number),
        })
        const text = logged.join('\n')
        expect(text).not.toContain(MOCK_PROVIDER_KEY)
        expect(text).not.toContain('TEST MOCK')
    })
})

describe('the generated step screen a check names', (): void => {
    const screenForm = (session: Booted['session'], revision = session.revision): FormData => {
        const body = new FormData()
        body.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'screen-for-check',
                op: 'generate',
                kind: 'guide',
                binding: { kind: 'manual', manualId: session.manualId, revision },
                session: { ...session, revision },
                stepId: 'step-1',
                captureId: null,
                result: null,
                failure: null,
                focusStepId: null,
                want: [],
            }),
        )
        return body
    }
    const guideIdentity = async (context: Booted): Promise<{ screenId: string; contextKey: string }> => {
        const response = await context.send('/api/screens', screenForm(context.session))
        const { value } = await response.json()
        return { screenId: value.document.screenId, contextKey: value.document.bound.contextKey }
    }
    const checkManualContext = (mock: Booted['mock']): { screen?: Record<string, unknown> } =>
        JSON.parse((mock.wireRequests.at(-1)!.input[0].content[0] as { text: string }).text).manualContext

    it('binds the server-issued screen identity and the facts the server resolved into the check input', async (): Promise<void> => {
        const context = await boot()
        const screen = await guideIdentity(context)
        const response = await context.send('/api/checks', context.form({ screen }))
        expect(response.status).toBe(200)
        expect(checkManualContext(context.mock).screen).toMatchObject({
            ...screen,
            kind: 'guide',
            facts: expect.arrayContaining([{ id: 'title', kind: 'title', text: 'Stand the side panel upright' }]),
        })
        // Without it the previous request is unchanged.
        const plain = await boot()
        await plain.send('/api/checks', plain.form())
        expect(checkManualContext(plain.mock)).not.toHaveProperty('screen')
    })

    it('hands the check the composition the person was shown, in order, not every fact of the step', async (): Promise<void> => {
        // An explicit empty safety classification makes the other directions optional, so only what was composed is shown.
        const context = await boot()
        context.session.reviewedSteps[0]!.safetyNotes = []
        const screen = await guideIdentity(context)
        expect((await context.send('/api/checks', context.form({ screen }))).status).toBe(200)
        const sent = checkManualContext(context.mock).screen as { facts: { id: string }[]; shown: ShownScreen }
        expect(sent.shown.blocks).toEqual([
            expect.objectContaining({
                path: 'body.0',
                type: 'Instruction',
                origin: 'generated',
                emphasis: 'strong',
                text: 'Stand the side panel upright',
            }),
        ])
        expect(sent.shown.header).toMatchObject({ title: 'Step 1' })
        expect(sent.shown.bar?.primary).toMatchObject({ label: 'Take photo', intent: 'capture', target: 'take-photo' })
        // The orientation, connection, check and correction texts were not on the page the person saw.
        expect(sent.facts.map((fact) => fact.id)).toEqual(['title'])
    })

    it('lists the complete directions the shown page names, in the order it names them', async (): Promise<void> => {
        const context = await boot()
        const screen = await guideIdentity(context)
        await context.send('/api/checks', context.form({ screen }))
        const sent = checkManualContext(context.mock).screen as {
            facts: { id: string; text: string }[]
            shown: ShownScreen
        }
        const directions = sent.shown.blocks.find((block: { type: string }) => block.type === 'ManualDirections')
        expect(sent.shown.blocks.map((block: { type: string }) => block.type)).toEqual([
            'Instruction',
            'ManualDirections',
        ])
        expect(directions?.factIds).toEqual([
            'title',
            'orientation',
            'connection',
            'check:groove-inward',
            'correction:turn-panel',
        ])
        expect(sent.shown.remainderFactIds).toEqual([])
        const step = context.session.reviewedSteps[0]!
        expect(sent.facts.find((fact) => fact.id === 'correction:turn-panel')?.text).toBe(
            step.correction!.actions[0]!.instruction,
        )
    })

    it('does not fail a check because a large step put more than two hundred facts on its page', async (): Promise<void> => {
        const context = await boot({}, { screen: { scenario: 'all-directions' } })
        const step = context.session.reviewedSteps[0]!
        const refs = [{ pageId: 'demo-page-1', region: null }]
        step.safetyNotes = Array.from({ length: 100 }, (_unused, index) => ({
            noteId: `n${index}`,
            note: { state: 'known' as const, value: `Safety note number ${index}.`, sourceRefs: refs },
        }))
        step.visibleChecks = Array.from({ length: 100 }, (_unused, index) => ({
            checkId: `c${index}`,
            description: { state: 'known' as const, value: `Visible check number ${index}.`, sourceRefs: refs },
        }))
        const screen = await guideIdentity(context)
        const response = await context.send('/api/checks', context.form({ screen }))
        expect(response.status).toBe(200)
        const sent = checkManualContext(context.mock).screen as { facts: unknown[] }
        expect(sent.facts.length).toBeGreaterThan(200)
    })

    it('gives the overlay and the second opinion the same shown composition as the check', async (): Promise<void> => {
        const context = await boot()
        context.session.reviewedSteps[0]!.safetyNotes = []
        const screen = await guideIdentity(context)
        const checked = await (await context.send('/api/checks', context.form({ screen }))).json()
        const shownOnCheck = checkManualContext(context.mock).screen
        expect(shownOnCheck).toHaveProperty('shown')
        const overlay = await context.send(
            '/api/checks/overlay',
            context.form({ screen, overlayToken: checked.value.followUps.overlay.token }),
        )
        expect(overlay.status).toBe(200)
        expect(checkManualContext(context.mock).screen).toEqual(shownOnCheck)
    })

    it('refuses a context key that is not the one the server computes for this session and step', async (): Promise<void> => {
        const context = await boot()
        const screen = await guideIdentity(context)
        const wrong = await context.send(
            '/api/checks',
            context.form({ screen: { ...screen, contextKey: 'a'.repeat(64) } }),
        )
        expect(wrong.status).toBe(400)
        expect(await wrong.json()).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
        // A screen id this server never issued contributes nothing (a restart, say) and does not block the verdict.
        const unknown = await context.send(
            '/api/checks',
            context.form({ screen: { ...screen, screenId: 'b'.repeat(64) } }),
        )
        expect(unknown.status).toBe(200)
        expect(checkManualContext(context.mock)).not.toHaveProperty('screen')
        // A screen id issued for another context cannot be paired with this one.
        const other = await boot()
        const edited = structuredClone(other.session)
        edited.reviewedSteps[0]!.title = 'A different title'
        const otherResponse = await other.send('/api/screens', screenForm(edited))
        const issued = (await otherResponse.json()).value.document
        const mixed = await other.send(
            '/api/checks',
            other.form({ screen: { screenId: issued.screenId, contextKey: (await guideIdentity(other)).contextKey } }),
        )
        expect(mixed.status).toBe(400)
    })
})

describe('shared provider capacity', (): void => {
    const segmentForm = (context: Booted): FormData => {
        const body = new FormData()
        body.set(
            'metadata',
            JSON.stringify({
                mode: 'model',
                requestId: 'sam-hold',
                binding: context.binding,
                capturedAt: '2026-01-01T00:00:00.000Z',
                prompt: 'divider',
                media: { kind: 'image', mimeType: 'image/png', width: 20, height: 16 },
            }),
        )
        body.set('media', new Blob([context.bytes], { type: 'image/png' }), 'media.png')
        return body
    }

    it('holds a slot for a segmentation stream until it ends, so a second stream or a second opinion is refused', async (): Promise<void> => {
        const context = await boot({ MODEL_MAX_CONCURRENCY: '1' }, { scenario: 'uncertain' })
        const checked = await context.send('/api/checks', context.form())
        const { value } = await checked.json()
        const held = await context.send('/api/segments', segmentForm(context))
        expect(held.status).toBe(200)
        // The stream is open: capacity is spent for as long as it lives.
        const second = await context.send('/api/segments', segmentForm(context))
        expect(second.status).toBe(429)
        const secondOpinion = await context.send(
            '/api/checks/second-opinion',
            context.form({ secondOpinionToken: value.secondOpinion.token }),
        )
        expect(secondOpinion.status).toBe(429)
        expect(await secondOpinion.json()).toMatchObject({ status: 'unavailable', code: 'budget_exhausted' })
        await held.body?.cancel()
        // Refusing for capacity did not spend the one-use second-opinion token.
        const retried = await context.send(
            '/api/checks/second-opinion',
            context.form({ secondOpinionToken: value.secondOpinion.token }),
        )
        expect(retried.status).toBe(200)
        expect((await retried.json()).value.secondOpinion).toMatchObject({ status: 'completed' })
        // And a stream that ran to its end releases its slot.
        const finished = await context.send('/api/segments', segmentForm(context))
        await finished.text()
        expect((await context.send('/api/segments', segmentForm(context))).status).toBe(200)
    })
})
