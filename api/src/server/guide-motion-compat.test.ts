import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { serve } from '@hono/node-server'
import type { Fact, ManualSession, ScreenContextInputsV2 } from '@truebuild/contracts'
import type * as ContractExports from '@truebuild/contracts'
import type * as ModelExports from '@truebuild/contracts/model'
import type * as ClientExports from '../../../app/src/api/model-client'
import type * as DocumentExports from '../../../app/src/api/document-client'
import type * as RegistryExports from '../../../app/src/features/step-motion/step-motion-registry'
import type * as RuntimeExports from './model-runtime'
import type * as AppExports from '../app'
import type * as ContextExports from './documents/context'
import type * as WireExports from '../providers/document-wire'
import type * as FixtureExports from '../test-support/meta-stream'
import type * as FallbackExports from '../../../app/src/features/documents/fallback-v2'
import sharp from 'sharp'
import { expect, it, vi } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const key = 'synthetic-local-compatibility-key'
const currentMain = '50d8c72f079933bb1a923327d98bd1353911d5e8'
const appRefs = ['fc7b706', 'decf006', 'de08511', 'db12e00', 'head']
const serverRefs = ['decf006', 'db12e00', currentMain, 'head']

/** Each frozen source tree resolves its own contracts, while using the installed external dependencies. */
function archive(ref: string, destination: string): string {
    mkdirSync(destination, { recursive: true })
    const bytes = execFileSync(
        'git',
        ['archive', '--format=tar', ref, 'api', 'app', 'packages', 'package.json', 'tsconfig.base.json'],
        {
            cwd: root,
            maxBuffer: 32 * 1024 * 1024,
        },
    )
    execFileSync('tar', ['-xf', '-', '-C', destination], { input: bytes })
    const dependencies = resolve(destination, 'node_modules')
    mkdirSync(dependencies)
    for (const name of readdirSync(resolve(root, 'node_modules'))) {
        if (name !== '@truebuild') symlinkSync(resolve(root, 'node_modules', name), resolve(dependencies, name))
    }
    mkdirSync(resolve(dependencies, '@truebuild'))
    symlinkSync(resolve(destination, 'packages/contracts'), resolve(dependencies, '@truebuild/contracts'))
    return destination
}

async function source<T>(tree: string, path: string): Promise<T> {
    return import(/* @vite-ignore */ pathToFileURL(resolve(tree, path)).href) as Promise<T>
}

type Contracts = typeof ContractExports
type ClientModule = typeof ClientExports
type DocumentModule = typeof DocumentExports
type RegistryModule = typeof RegistryExports
interface Row {
    app: string
    server: string
    operation: string
    protocol: string
    http: number | null
    result: string
    modelCalls: number
    query: string
}

function sessionFor(contracts: Contracts, bytes: Uint8Array): ManualSession {
    const session = contracts.createDemoManual()
    Object.assign(session.pages[0]!, { width: 512, height: 512, contentHash: hash(bytes) })
    const refs = session.rawExtraction!.steps[0]!.sourceRefs
    const known = <T>(value: T): Fact<T> => ({ state: 'known' as const, value, sourceRefs: structuredClone(refs) })
    const fastener = { partId: 'screw-m6', name: known('M6 × 20 mm screw') }
    session.parts.push(structuredClone(fastener))
    session.rawExtraction!.parts.push(structuredClone(fastener))
    for (const step of [session.rawExtraction!.steps[0]!, session.reviewedSteps[0]!]) {
        step.parts.push({ partId: 'screw-m6', quantity: known(2) })
        if ('actions' in contracts.manualStepSchema.shape) {
            step.actions = [
                {
                    actionId: 'secure-panel',
                    instruction: 'Secure the panel with two M6 × 20 mm screws.',
                    sourceRefs: structuredClone(refs),
                },
            ]
        }
        if ('sourceText' in contracts.manualStepSchema.shape)
            step.sourceText = 'Secure the panel with two M6 × 20 mm screws.'
    }
    return contracts.manualSessionSchema.parse(session)
}

it('keeps the actual installed clients compatible with pinned current-main and working-tree HTTP servers using only a synthetic model', async () => {
    mkdirSync(resolve(root, '.local'), { recursive: true })
    const scratch = mkdtempSync(resolve(root, '.local/guide-motion-compat-'))
    const rows: Row[] = []
    const logs: string[] = []
    const serverPromptVersions: Record<string, number> = {}
    let completed = false
    const log = vi.spyOn(console, 'info').mockImplementation((value: unknown): void => {
        logs.push(String(value))
    })
    const trees = new Map<string, string>([
        ...[...appRefs.filter((ref) => ref !== 'head'), currentMain].map((ref): [string, string] => [
            ref,
            archive(ref, resolve(scratch, ref)),
        ]),
        ['head', root],
    ])
    const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#abcdef' } })
        .png()
        .toBuffer()
    try {
        for (const serverRef of serverRefs) {
            const serverTree = trees.get(serverRef)!
            const serverContracts = await source<Contracts>(serverTree, 'packages/contracts/src/index.ts')
            const runtimeModule = await source<typeof RuntimeExports>(serverTree, 'api/src/server/model-runtime.ts')
            const appModule = await source<typeof AppExports>(serverTree, 'api/src/app.ts')
            const contextModule = await source<typeof ContextExports>(serverTree, 'api/src/server/documents/context.ts')
            const wireModule = await source<typeof WireExports>(serverTree, 'api/src/providers/document-wire.ts')
            const fixtureModule = await source<typeof FixtureExports>(serverTree, 'api/src/test-support/meta-stream.ts')
            expect(serverContracts.LIMITS.requestBytes).toBe(8_388_608)
            expect(serverContracts.STEP_MOTION_PROMPT_VERSION).toBe(
                serverRef === 'head' ? 5 : serverRef === 'decf006' ? 2 : serverRef === 'db12e00' ? 3 : 4,
            )
            serverPromptVersions[serverRef] = serverContracts.STEP_MOTION_PROMPT_VERSION
            const parsed = sessionFor(serverContracts, bytes).rawExtraction!
            for (const appRef of appRefs) {
                for (const protocol of ['json', 'sse']) {
                    let guideWire: unknown
                    let motionValues: unknown[] = []
                    let parsePageId = 'demo-page-1'
                    let modelCalls = 0
                    const transport: typeof fetch = async (url, init) => {
                        expect(url).toBe('https://api.meta.ai/v1/responses')
                        const body = JSON.parse(String(init?.body)) as {
                            model: string
                            text: { format: { name: string; strict: boolean; schema: unknown } }
                        }
                        expect(body.text.format.strict).toBe(true)
                        modelCalls++
                        const operation = body.text.format.name
                        let value: unknown
                        if (operation === 'truebuild_parse') {
                            value = JSON.parse(JSON.stringify(parsed).replaceAll('demo-page-1', parsePageId))
                            // The fake respects the actually requested strict sourceText schema.
                            if (!JSON.stringify(body.text.format.schema).includes('"sourceText"')) {
                                for (const step of (value as typeof parsed).steps) delete step.sourceText
                            }
                        } else if (operation === 'truebuild_document') value = guideWire
                        else if (operation === 'truebuild_stepMotion') value = motionValues.shift() ?? { scene: null }
                        else throw new Error(`Unexpected model operation: ${operation}`)
                        return fixtureModule.asRequestedMetaResponse(
                            Response.json({
                                status: 'completed',
                                model: body.model,
                                output: [
                                    {
                                        type: 'message',
                                        role: 'assistant',
                                        status: 'completed',
                                        content: [{ type: 'output_text', text: JSON.stringify(value) }],
                                    },
                                ],
                            }),
                            init,
                        )
                    }
                    const runtime = runtimeModule.createRuntimeFromEnvironment(
                        {
                            PROVIDER_MODE: 'meta',
                            MODEL_API_KEY: '<synthetic>',
                            API_SHARED_SECRET: key,
                            PARSE_LIMIT_PER_HOUR: '100',
                            MODEL_CALL_LIMIT_PER_CLIENT_DAY: '500',
                        },
                        transport,
                    )
                    const app = appModule.createApp({ runtime, onDuration: () => {} })
                    const listener = serve({
                        fetch: app.fetch,
                        hostname: '127.0.0.1',
                        port: 0,
                        overrideGlobalObjects: false,
                    })
                    try {
                        if (!listener.listening) await once(listener, 'listening')
                        const address = listener.address()
                        if (address === null || typeof address === 'string')
                            throw new Error('Missing ephemeral listener')
                        const baseUrl = `http://127.0.0.1:${address.port}`
                        const appTree = trees.get(appRef)!
                        const contracts = await source<Contracts>(appTree, 'packages/contracts/src/index.ts')
                        const modelContracts = await source<typeof ModelExports>(
                            appTree,
                            'packages/contracts/src/model.ts',
                        )
                        expect(modelContracts.MAX_PARSE_PAGES).toBe(['head', 'db12e00'].includes(appRef) ? 12 : 8)
                        expect(contracts.LIMITS.requestBytes).toBe(8_388_608)
                        const clients = await source<ClientModule>(appTree, 'app/src/api/model-client.ts')
                        const documents = await source<DocumentModule>(appTree, 'app/src/api/document-client.ts')
                        const session = sessionFor(contracts, bytes)
                        const original = structuredClone(session)
                        let lastHttp: number | null = null
                        let lastType = ''
                        let lastQuery = ''
                        const httpResponses: { status: number; query: string }[] = []
                        let wireMetadata: unknown
                        const clientFetch = async (url: string, init: RequestInit): Promise<Response> => {
                            const target = new URL(url)
                            expect(target.origin).toBe(baseUrl)
                            lastQuery = target.search
                            if (init.body instanceof FormData) {
                                wireMetadata = JSON.parse(String(init.body.get('metadata')))
                                if (target.pathname === '/api/manuals/parse') {
                                    parsePageId = (wireMetadata as { pages: { pageId: string }[] }).pages[0]!.pageId
                                }
                            }
                            const headers = new Headers(init.headers)
                            headers.set('Accept', protocol === 'sse' ? 'text/event-stream' : 'application/json')
                            const response = await fetch(url, { ...init, headers })
                            lastHttp = response.status
                            httpResponses.push({ status: response.status, query: target.search })
                            lastType = response.headers.get('content-type') ?? ''
                            return response
                        }
                        const client = new clients.ModelApiClient({
                            baseUrl,
                            secret: key,
                            fetch: clientFetch,
                            streamFetch: clientFetch,
                        })
                        const binding = {
                            kind: 'manual' as const,
                            manualId: session.manualId,
                            revision: session.revision,
                        }
                        const image = {
                            bytes: new Uint8Array(bytes),
                            mimeType: 'image/png' as const,
                            width: 512,
                            height: 512,
                        }
                        const before = modelCalls
                        const phases: string[] = []
                        const result = await client.parse(binding, session.pages, [image], {
                            requestId: `${appRef}-${serverRef}-${protocol}`,
                            ...(protocol === 'sse'
                                ? {
                                      onProgress: (phase: string): void => {
                                          phases.push(phase)
                                      },
                                  }
                                : {}),
                        })
                        rows.push({
                            app: appRef,
                            server: serverRef,
                            operation: 'parse',
                            protocol,
                            http: lastHttp,
                            result: result.status,
                            modelCalls: modelCalls - before,
                            query: lastQuery,
                        })
                        expect(result.status, JSON.stringify(rows.at(-1))).toBe('ok')
                        expect(modelCalls - before).toBe(1)
                        expect(lastHttp).toBe(200)
                        expect(lastType).toContain(protocol === 'sse' ? 'text/event-stream' : 'application/json')
                        if (protocol === 'sse') expect(phases.length).toBeGreaterThan(0)
                        const inputs: ScreenContextInputsV2 = {
                            kind: 'guide',
                            session,
                            stepId: 'step-1',
                            captureId: null,
                            result: null,
                            failure: null,
                        }
                        const requestId = `${appRef}-${serverRef}-guide`
                        const metadata = documents.documentRequest({ op: 'generate', inputs }, requestId)
                        const outgoing = metadata as typeof metadata & { session: ManualSession }
                        const context = contextModule.buildDocumentContext(
                            { ...inputs, session: outgoing.session },
                            appRef === 'fc7b706',
                        )
                        guideWire = wireModule.encodeWireProposal(
                            serverContracts.buildFallbackProposalV2(context.material),
                        )
                        const beforeGuide = modelCalls
                        const guide = await client.screensV2(metadata, { requestId })
                        rows.push({
                            app: appRef,
                            server: serverRef,
                            operation: 'guide',
                            protocol,
                            http: lastHttp,
                            result: guide.status,
                            modelCalls: modelCalls - beforeGuide,
                            query: lastQuery,
                        })
                        expect(guide.status, JSON.stringify(rows.at(-1))).toBe('ok')
                        // PR16 serves deterministic Guides for actions-capable clients; decf006 still calls the model.
                        expect(modelCalls - beforeGuide).toBe(appRef === 'fc7b706' || serverRef === 'decf006' ? 1 : 0)
                        expect(lastType).toContain('application/json')
                        if (guide.status === 'ok') {
                            expect(guide.value.document).not.toBeNull()
                            expect(documents.documentMatchesInputs(guide.value.document!, inputs)).toBe(true)
                        }
                        if (typeof client.stepMotion !== 'function') {
                            rows.push({
                                app: appRef,
                                server: serverRef,
                                operation: 'motion',
                                protocol: `${protocol}-absent-client`,
                                http: null,
                                result: 'not-supported',
                                modelCalls: 0,
                                query: '',
                            })
                        } else {
                            const registry = await source<RegistryModule>(
                                appTree,
                                'app/src/features/step-motion/step-motion-registry.ts',
                            )
                            const request = registry.motionRequestForStep(
                                session,
                                'step-1',
                                `${appRef}-${serverRef}-motion`,
                            )
                            // Older clients may decline to form a no-region motion request; this is a safe missing hint.
                            const beforeMotion = modelCalls
                            lastHttp = null
                            const result =
                                request === null
                                    ? { status: 'not_sent' }
                                    : await client.stepMotion(request, {
                                          'demo-page-1': `data:image/png;base64,${bytes.toString('base64')}`,
                                      })
                            const outcome = 'scene' in result ? 'scene-null' : result.status
                            rows.push({
                                app: appRef,
                                server: serverRef,
                                operation: 'motion-no-region',
                                protocol,
                                http: lastHttp,
                                result: outcome,
                                modelCalls: modelCalls - beforeMotion,
                                query: lastQuery,
                            })
                            expect(['scene-null', 'not_sent']).toContain(outcome)
                            expect(modelCalls - beforeMotion).toBe(request !== null ? 1 : 0)
                            expect(lastType).toContain('application/json')
                            expect(session).toEqual(original)
                            if (serverRef === 'head') {
                                const motionSession = structuredClone(session)
                                for (const step of [
                                    motionSession.rawExtraction!.steps[0]!,
                                    motionSession.reviewedSteps[0]!,
                                ])
                                    step.sourceRefs = [
                                        {
                                            pageId: 'demo-page-1',
                                            region: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
                                        },
                                    ]
                                const fixtureScene = (
                                    name: string,
                                ): NonNullable<ContractExports.StepMotionResult['scene']> => {
                                    const raw: unknown = JSON.parse(
                                        readFileSync(
                                            resolve(root, `api/src/test-support/motion-scenes/${name}.json`),
                                            'utf8',
                                        ),
                                    )
                                    const value = serverContracts.stepMotionResultSchema.parse(
                                        serverContracts.dropDegenerateStepMotionShapes(raw),
                                    ).scene!
                                    value.stepId = 'step-1'
                                    for (const mover of value.movers) mover.actionIndex = null
                                    return value
                                }
                                const overlapping = fixtureScene('noble-step-1')
                                // Preserve every shape and its size: a repair changes placement, not the modeled parts.
                                const repaired = structuredClone(overlapping)
                                for (const mover of repaired.movers)
                                    for (const shape of mover.shapes) shape.position[0] += 200
                                for (const accepted of [false, true]) {
                                    const operation = accepted ? 'motion-overlap-repaired' : 'motion-overlap-terminal'
                                    const motionRequest = registry.motionRequestForStep(
                                        motionSession,
                                        'step-1',
                                        `${appRef}-${serverRef}-${protocol}-${operation}`,
                                    )!
                                    expect(motionRequest).not.toBeNull()
                                    // Distinct source context prevents either scenario from reading the other's cache.
                                    motionRequest.instructionText += accepted
                                        ? ' Repaired output.'
                                        : ' Terminal output.'
                                    motionValues = [
                                        { scene: overlapping },
                                        { scene: accepted ? repaired : overlapping },
                                    ]
                                    const beforeRepair = modelCalls
                                    const beforeHttp = httpResponses.length
                                    const values = new Map<string, string>()
                                    const storage = {
                                        getAllKeys: async (): Promise<string[]> => [...values.keys()],
                                        getItem: async (item: string): Promise<string | null> =>
                                            values.get(item) ?? null,
                                        setItem: async (item: string, value: string): Promise<void> => {
                                            values.set(item, value)
                                        },
                                        removeItem: async (item: string): Promise<void> => {
                                            values.delete(item)
                                        },
                                    }
                                    const generate = client.stepMotion.bind(client)
                                    const deviceRegistry = new registry.StepMotionRegistry(storage, generate)
                                    const pageUris = {
                                        'demo-page-1': `data:image/png;base64,${bytes.toString('base64')}`,
                                    }
                                    const outcome = await deviceRegistry.load(motionRequest, pageUris)
                                    rows.push({
                                        app: appRef,
                                        server: serverRef,
                                        operation,
                                        protocol,
                                        http: httpResponses[beforeHttp]!.status,
                                        result: outcome === null ? 'hint-hidden' : `scene-v${outcome.version}`,
                                        modelCalls: modelCalls - beforeRepair,
                                        query: httpResponses[beforeHttp]!.query,
                                    })
                                    expect(outcome).toEqual(accepted ? repaired : null)
                                    expect(modelCalls - beforeRepair).toBe(2)
                                    expect(motionValues).toEqual([])
                                    expect(httpResponses[beforeHttp]!.status).toBe(accepted ? 200 : 503)
                                    // A failed generation is unknown to shipped clients; their recovery lookup cannot dispatch.
                                    expect(httpResponses.slice(beforeHttp).map(({ status }) => status)).toEqual(
                                        accepted ? [200] : [503, 404],
                                    )
                                    expect(lastType).toContain('application/json')
                                    const reread = new registry.StepMotionRegistry(storage, generate)
                                    const beforeReread = httpResponses.length
                                    expect(await reread.load(motionRequest, pageUris)).toEqual(outcome)
                                    expect(httpResponses).toHaveLength(beforeReread)
                                    const cached = await client.stepMotion({ ...motionRequest, cacheOnly: true }, {})
                                    expect(cached).toEqual(accepted ? { scene: repaired } : { status: 'unknown' })
                                    expect(lastHttp).toBe(accepted ? 200 : 404)
                                    expect(lastQuery).toBe('?cacheOnly=1')
                                    expect(modelCalls - beforeRepair).toBe(2)
                                    if (!accepted) {
                                        values.clear()
                                        const refused = new clients.ModelApiClient({
                                            baseUrl,
                                            secret: 'synthetic-refused-key',
                                            fetch: clientFetch,
                                            streamFetch: clientFetch,
                                        })
                                        const errorRegistry = new registry.StepMotionRegistry(
                                            storage,
                                            refused.stepMotion.bind(refused),
                                        )
                                        const beforeRefusal = modelCalls
                                        expect(await errorRegistry.load(motionRequest, pageUris)).toBeNull()
                                        rows.push({
                                            app: appRef,
                                            server: serverRef,
                                            operation: 'motion-http-refused',
                                            protocol,
                                            http: lastHttp,
                                            result: 'hint-hidden',
                                            modelCalls: modelCalls - beforeRefusal,
                                            query: lastQuery,
                                        })
                                        expect(lastHttp).toBe(401)
                                        expect(modelCalls).toBe(beforeRefusal)
                                    }
                                }
                            }
                        }
                        if (appRef === 'head') {
                            const pages = Array.from({ length: 12 }, (_, index) => ({
                                ...session.pages[0]!,
                                pageId: `page-${index}`,
                                assetId: `asset-${index}`,
                            }))
                            const savedPages = structuredClone(pages)
                            const beforeLarge = modelCalls
                            lastHttp = null
                            const result = await client.parse(
                                binding,
                                pages,
                                pages.map(() => image),
                                {
                                    requestId: `${serverRef}-twelve-pages`,
                                    ...(protocol === 'sse' ? { onProgress: (): void => {} } : {}),
                                },
                            )
                            rows.push({
                                app: appRef,
                                server: serverRef,
                                operation: 'parse-12-pages',
                                protocol,
                                http: lastHttp,
                                result: result.status === 'ok' ? 'ok' : `${result.code}:${result.message ?? ''}`,
                                modelCalls: modelCalls - beforeLarge,
                                query: lastQuery,
                            })
                            if (serverRef === 'decf006') {
                                expect(result).toMatchObject({
                                    status: 'unavailable',
                                    code: 'invalid_input',
                                    retryable: false,
                                    message: expect.stringContaining('8'),
                                })
                                expect(lastHttp).toBe(400)
                                expect(modelCalls).toBe(beforeLarge)
                            } else {
                                expect(result.status).toBe('ok')
                                expect(lastHttp).toBe(200)
                                expect(modelCalls - beforeLarge).toBe(1)
                            }
                            expect(pages).toEqual(savedPages)
                            expect(session).toEqual(original)
                            expect(wireMetadata).toHaveProperty('pages')
                            const plural = structuredClone(session)
                            plural.manualId = 'plural-no-count'
                            for (const part of [
                                plural.parts.find((part) => part.partId === 'screw-m6')!,
                                plural.rawExtraction!.parts.find((part) => part.partId === 'screw-m6')!,
                            ]) {
                                if (part.name.state === 'known') part.name.value = 'M6 × 20 mm screws'
                            }
                            for (const step of [plural.rawExtraction!.steps[0]!, plural.reviewedSteps[0]!]) {
                                const requirement = step.parts.find((part) => part.partId === 'screw-m6')!
                                requirement.quantity = { state: 'unknown', reason: 'Manual gives no count.' }
                                requirement.quantityBasis = null
                                step.actions![0]!.instruction = 'Secure the panel with the M6 × 20 mm screws.'
                                step.sourceText = 'Secure the panel with the M6 × 20 mm screws.'
                            }
                            expect(contracts.manualSessionSchema.safeParse(plural).success).toBe(true)
                            const pluralOriginal = structuredClone(plural)
                            const pluralInputs = { ...inputs, session: plural }
                            const pluralId = `${serverRef}-${protocol}-plural-guide`
                            const pluralMetadata = documents.documentRequest(
                                { op: 'generate', inputs: pluralInputs },
                                pluralId,
                            )
                            const beforePlural = modelCalls
                            const pluralGuide = await client.screensV2(pluralMetadata, { requestId: pluralId })
                            rows.push({
                                app: appRef,
                                server: serverRef,
                                operation: 'guide-plural-unknown-count',
                                protocol,
                                http: lastHttp,
                                result: pluralGuide.status === 'ok' ? 'ok' : pluralGuide.code,
                                modelCalls: modelCalls - beforePlural,
                                query: lastQuery,
                            })
                            if (serverRef === 'decf006') {
                                expect(pluralGuide).toMatchObject({ status: 'unavailable', code: 'invalid_input' })
                                expect(lastHttp).toBe(400)
                            } else {
                                expect(pluralGuide.status).toBe('ok')
                                expect(lastHttp).toBe(200)
                            }
                            expect(modelCalls).toBe(beforePlural)
                            const fallbackModule = await source<typeof FallbackExports>(
                                appTree,
                                'app/src/features/documents/fallback-v2.ts',
                            )
                            const fallback = fallbackModule.sharedFallbackDocument(pluralInputs)
                            expect(documents.documentMatchesInputs(fallback, pluralInputs)).toBe(true)
                            const registry = await source<RegistryModule>(
                                appTree,
                                'app/src/features/step-motion/step-motion-registry.ts',
                            )
                            const pluralMotion = registry.motionRequestForStep(plural, 'step-1', `${pluralId}-motion`)!
                            expect(pluralMotion.parts.find((part) => part.id === 'screw-m6')?.quantity).toBeNull()
                            const beforePluralMotion = modelCalls
                            const pluralAttempt = await client.stepMotion(pluralMotion, {
                                'demo-page-1': `data:image/png;base64,${bytes.toString('base64')}`,
                            })
                            rows.push({
                                app: appRef,
                                server: serverRef,
                                operation: 'motion-plural-unknown-count',
                                protocol,
                                http: lastHttp,
                                result: 'scene' in pluralAttempt ? 'scene-null' : pluralAttempt.status,
                                modelCalls: modelCalls - beforePluralMotion,
                                query: lastQuery,
                            })
                            expect(pluralAttempt).toEqual({ scene: null })
                            expect(modelCalls - beforePluralMotion).toBe(1)
                            expect(plural).toEqual(pluralOriginal)
                        }
                        expect(runtime.counter.used).toBe(modelCalls)
                    } finally {
                        await new Promise<void>((resolve, reject) => {
                            listener.close((error) => (error ? reject(error) : resolve()))
                            if ('closeAllConnections' in listener) listener.closeAllConnections()
                        })
                    }
                }
            }
        }
        completed = true
    } finally {
        log.mockRestore()
        writeFileSync(
            resolve(root, '.local/prompt24b-compat-results.json'),
            JSON.stringify(
                {
                    completed,
                    headBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
                    currentMain,
                    revisions: Object.fromEntries(
                        [...appRefs.filter((ref) => ref !== 'head'), currentMain].map((ref) => [
                            ref,
                            execFileSync('git', ['rev-parse', `${ref}^{commit}`], {
                                cwd: root,
                                encoding: 'utf8',
                            }).trim(),
                        ]),
                    ),
                    serverPromptVersions,
                    responseSceneVersion: 1,
                    requestBytes: 8_388_608,
                    currentParsePages: 12,
                    workingDiffSha256: hash(
                        execFileSync(
                            'git',
                            ['diff', '--binary', 'HEAD', '--', 'app/src', 'api/src', 'packages/contracts/src'],
                            { cwd: root },
                        ),
                    ),
                    untrackedSourcesSha256: hash(
                        JSON.stringify(
                            execFileSync(
                                'git',
                                [
                                    'ls-files',
                                    '--others',
                                    '--exclude-standard',
                                    '-z',
                                    '--',
                                    'app/src',
                                    'api/src',
                                    'packages/contracts/src',
                                ],
                                { cwd: root, encoding: 'utf8' },
                            )
                                .split('\0')
                                .filter(Boolean)
                                .sort()
                                .map((path) => [path, hash(readFileSync(resolve(root, path)))]),
                        ),
                    ),
                    basis: 'Actual frozen clients fc7b706/decf006/de08511/db12e00 and current working tree; frozen decf006/db12e00, pinned current-main 50d8c72 and working-tree Hono servers; loopback HTTP only; injected synthetic Meta transport; Guide and motion are JSON-only. Head overlap cells use a saved first scene and a placement-only synthetic repair through the actual client registry. Failed repairs return 503, recovery/cache-only reads miss without dispatch, and device markers prevent implicit resends; accepted scenes cache. Older-server failure caches and physical-quality behavior are unchanged and not exercised here. No live model, device, visual-quality or deployment proof.',
                    rows,
                },
                null,
                2,
            ),
        )
        writeFileSync(resolve(root, '.local/prompt24b-compat.log'), logs.join('\n'))
        rmSync(scratch, { recursive: true, force: true })
    }
}, 60_000)
