import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ModelApiClient, type ImageBytes } from '../../../app/src/api/model-client'
import { PROOF_ASSETS } from '../../../app/src/features/ai-effort-proof/assets'
import { screensV2GenerateRequest } from '@truebuild/contracts/model'
import { manualSessionSchema } from '@truebuild/contracts'
import { NATIVE_FIXTURE_ASSETS } from './native-fixture-assets'
import { createNativeFixtureApp } from './native-fixture-app'
import { stepFixtures } from './step-fixtures'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const image = (index: number): ImageBytes => {
    const asset = PROOF_ASSETS[index]!
    return {
        bytes: Buffer.from(asset.base64, 'base64'),
        width: asset.width,
        height: asset.height,
        mimeType: 'image/png',
    }
}

it('binds every API fixture identity to the actual synthetic camera bytes, without shipping raster data to the API', () => {
    expect(NATIVE_FIXTURE_ASSETS).toHaveLength(PROOF_ASSETS.length)
    for (const [index, asset] of PROOF_ASSETS.entries()) {
        const { base64, ...identity } = asset
        expect(NATIVE_FIXTURE_ASSETS[index]).toEqual({
            ...identity,
            hash: createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
        })
    }
})

describe('whole-screen fixture uses the real client and Hono admission with no inference transport', () => {
    it('parses actual fixture bytes, checks their held photo and serves an honestly synthetic complete v2 document', async () => {
        const app = createNativeFixtureApp({
            parseDelayMs: 0,
            verdictDelayMs: 0,
            overlayDelayMs: 200,
            jobSyncWaitMs: 100,
        })
        const overlayStatuses: number[] = []
        const evidence: string[] = []
        const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
            const response = await app.fetch(new Request(url, init))
            if (new URL(url).pathname.startsWith('/api/checks/overlay')) overlayStatuses.push(response.status)
            evidence.push(
                `${response.headers.get('x-truebuild-evidence')}/${response.headers.get('x-truebuild-inference')}`,
            )
            return response
        })
        const client = new ModelApiClient({ baseUrl: 'http://127.0.0.1:3101', secret: 'truebuild-fixture-demo', fetch })
        const manual = stepFixtures()[0]!.session
        const page = { ...manual.pages[0]!, ...image(0), bytes: undefined, contentHash: NATIVE_FIXTURE_ASSETS[0]!.hash }
        const { bytes: _bytes, ...sourcePage } = page
        void _bytes
        const binding = { kind: 'manual' as const, manualId: manual.manualId, revision: manual.revision }
        const parsed = await client.parse(binding, [sourcePage], [image(0)], { requestId: 'fixture-parse' })
        expect(parsed.status).toBe('ok')
        if (parsed.status !== 'ok') throw new Error('fixture parse failed')
        expect(parsed.value.model).toBeUndefined()
        // These authored synthetic manuals explicitly declare their safety classification.
        expect(parsed.value.steps.every((step) => Array.isArray(step.safetyNotes))).toBe(true)
        expect(parsed.value.steps.map((step) => step.title)).toEqual(manual.reviewedSteps.map((step) => step.title))

        // The fixture's explicit human-review witness is applied after extraction, never authored by the parser.
        const session = {
            ...manual,
            pages: [sourcePage],
            parts: parsed.value.parts,
            reviewedSteps: parsed.value.steps.map((step) => ({
                ...step,
                correction: step.correction === null ? null : { ...step.correction, reviewed: true },
            })),
        }
        expect(() => manualSessionSchema.parse(session)).not.toThrow()
        const capture = {
            ...binding,
            kind: 'capture' as const,
            stepId: session.reviewedSteps[0]!.stepId,
            captureId: 'photo',
        }
        const checked = await client.check(capture, session, [sourcePage.pageId], [image(0)], image(1), {
            requestId: 'fixture-check',
        })
        expect(checked).toMatchObject({ status: 'ok', value: { decision: 'pass', evidence: 'synthetic-fixture' } })
        if (checked.status !== 'ok') throw new Error('fixture check failed')
        expect(checked.value.model).toBeUndefined()
        expect(checked.value.telemetry).toBeUndefined()
        expect(checked.value.followUps?.overlay?.status).toBe('available')
        const offer = checked.value.followUps?.overlay
        if (offer?.status !== 'available') throw new Error('expected fixture overlay offer')
        const overlay = await client.overlay(capture, session, [sourcePage.pageId], [image(0)], image(1), offer.token, {
            requestId: 'fixture-check',
        })
        expect(overlay).toMatchObject({ status: 'ok', mode: 'fixture', value: { evidence: 'synthetic-fixture' } })
        expect(overlayStatuses).toEqual([202, 200])

        const metadata = screensV2GenerateRequest(
            'fixture-home',
            {
                kind: 'home',
                session: null,
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                uiState: { library: { entries: [], soleManualId: null } },
            },
            digest,
        )
        const document = await client.screensV2(metadata, { requestId: 'fixture-home' })
        expect(document).toMatchObject({
            status: 'ok',
            mode: 'fixture',
            value: {
                document: {
                    version: 2,
                    metadata: { source: 'generated', evidence: 'synthetic-fixture', model: null, effort: null },
                },
            },
        })
        const wrongPhoto = await client.check(
            { ...capture, captureId: 'other-photo' },
            session,
            [sourcePage.pageId],
            [image(0)],
            image(4),
            {
                requestId: 'wrong-manual-photo',
            },
        )
        expect(wrongPhoto.status).toBe('unavailable')
        expect(app.fixtureDispatchCounts()).toMatchObject({ parse: 1, check: 2, overlay: 1, documents: 1 })
        expect(evidence.every((value) => value === 'synthetic-fixture/none')).toBe(true)
        expect(app.inference).toBe('disabled-by-construction')
        expect(fetch.mock.calls.every(([url]) => new URL(url).origin === 'http://127.0.0.1:3101')).toBe(true)
    })
})

it.each(['parse-unavailable', 'check-unavailable', 'overlay-unavailable'] as const)(
    'publishes the configured %s recovery through the real fixture client',
    async (scenario) => {
        const app = createNativeFixtureApp({
            scenario,
            parseDelayMs: 0,
            verdictDelayMs: 0,
            overlayDelayMs: 200,
            jobSyncWaitMs: 100,
        })
        const overlayStatuses: number[] = []
        const client = new ModelApiClient({
            baseUrl: 'http://127.0.0.1:3101',
            secret: 'truebuild-fixture-demo',
            fetch: async (url, init): Promise<Response> => {
                const response = await app.fetch(new Request(url, init))
                expect(response.status).not.toBe(504)
                expect(response.headers.get('x-truebuild-inference')).toBe('none')
                if (new URL(url).pathname.startsWith('/api/checks/overlay')) overlayStatuses.push(response.status)
                return response
            },
        })
        const manual = stepFixtures()[0]!.session
        const sourcePage = { ...manual.pages[0]!, contentHash: NATIVE_FIXTURE_ASSETS[0]!.hash }
        const binding = { kind: 'manual' as const, manualId: manual.manualId, revision: manual.revision }
        const parsed = await client.parse(binding, [sourcePage], [image(0)], { requestId: `parse-${scenario}` })
        if (scenario === 'parse-unavailable') {
            expect(parsed.status).toBe('unavailable')
            expect(app.fixtureDispatchCounts()).toMatchObject({ parse: 1, check: 0, overlay: 0 })
            return
        }
        if (parsed.status !== 'ok') throw new Error('fixture parse failed')
        const session = manualSessionSchema.parse({
            ...manual,
            pages: [sourcePage],
            parts: parsed.value.parts,
            reviewedSteps: parsed.value.steps.map((step) => ({
                ...step,
                correction: step.correction === null ? null : { ...step.correction, reviewed: true },
            })),
        })
        const capture = {
            ...binding,
            kind: 'capture' as const,
            stepId: session.reviewedSteps[0]!.stepId,
            captureId: `photo-${scenario}`,
        }
        const checked = await client.check(capture, session, [sourcePage.pageId], [image(0)], image(1), {
            requestId: `check-${scenario}`,
        })
        if (scenario === 'check-unavailable') {
            expect(checked.status).toBe('unavailable')
            expect(app.fixtureDispatchCounts()).toMatchObject({ check: 1, overlay: 0 })
            return
        }
        expect(checked.status).toBe('ok')
        if (checked.status !== 'ok') throw new Error('fixture check failed')
        const offer = checked.value.followUps?.overlay
        if (offer?.status !== 'available') throw new Error('missing fixture overlay offer')
        const overlay = await client.overlay(capture, session, [sourcePage.pageId], [image(0)], image(1), offer.token, {
            requestId: `check-${scenario}`,
        })
        expect(overlay.status).toBe('unavailable')
        expect(overlayStatuses).toEqual([202, 200])
        expect(app.fixtureDispatchCounts()).toMatchObject({ check: 1, overlay: 1 })
    },
)
