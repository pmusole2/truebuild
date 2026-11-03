import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
    SCREEN_KINDS_V2,
    canonicalJson,
    screenContextJsonV2,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
} from '@truebuild/contracts'
import {
    screensV2GenerateRequest,
    screensV2ResultSchema,
    type ScreensV2Result,
    modelScreensV2MetadataSchema,
    type ModelScreensV2Metadata,
} from '@truebuild/contracts/model'
import { describe, expect, it, vi } from 'vitest'

import {
    documentJobContextKey,
    documentMatchesInputs,
    interpretDocuments,
} from '../../../../app/src/api/document-client'
import { precomputeItems } from './service'
import { checkPrompt39, checkPrompt39Response } from '../../../../packages/contracts/src/fixtures/prompt39/checker.mjs'
import provenance from '../../../../packages/contracts/src/fixtures/prompt39/checker-provenance.json'
import { createApp } from '../../app'
import { encodeWireProposal } from '../../providers/document-wire'
import { buildFallbackProposalV2 } from '@truebuild/contracts'
import { documentInputs, fullUi } from '../../test-support/document-inputs'
import { createRuntimeFromEnvironment } from '../model-runtime'

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const key = 'synthetic-local-test-value'
function app(mode = 'full'): ReturnType<typeof createApp> {
    return createApp({
        runtime: createRuntimeFromEnvironment({
            PROVIDER_MODE: 'fixture',
            API_SHARED_SECRET: key,
            GENERATIVE_UI: mode,
        }),
        onDuration: () => {},
    })
}
async function read(
    application: ReturnType<typeof createApp>,
    inputs: ScreenContextInputsV2,
    query: string,
): Promise<Extract<ScreensV2Result, { status: 'ok' }>> {
    const form = new FormData()
    form.set('metadata', JSON.stringify(screensV2GenerateRequest('wait-copy', inputs, hash)))
    const response = await application.request(`/api/screens/v2${query}`, {
        method: 'POST',
        headers: { 'x-truebuild-key': key },
        body: form,
    })
    expect(response.status).toBe(200)
    const body = screensV2ResultSchema.parse(await response.json())
    if (body.status !== 'ok') throw new Error(body.code)
    return body
}

describe('waitCopy query compatibility', () => {
    it('pins the generated oracle bytes to the reviewed provenance', () => {
        const bytes = readFileSync(
            new URL('../../../../packages/contracts/src/fixtures/prompt39/checker.mjs', import.meta.url),
        )
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.bundleSha256)
        expect(
            provenance.sources.every(
                (source) => source.path.startsWith('packages/contracts/src/') && !source.path.includes('/wait-copy.ts'),
            ),
        ).toBe(true)
    })

    it.each(['', '?guideRepair=1'])(
        'cancels old-copy work %s when a capable request observes a newer manual revision',
        async (oldQuery) => {
            const log = vi.spyOn(console, 'info').mockImplementation(() => {})
            let release: () => void = () => {}
            const held = new Promise<void>((resolve) => {
                release = resolve
            })
            let oldSignal: AbortSignal | undefined
            const runtime = createRuntimeFromEnvironment(
                { PROVIDER_MODE: 'fixture', API_SHARED_SECRET: key },
                undefined,
                {
                    documentFixtures: async (request, signal) => {
                        if (request.revision === 1) {
                            oldSignal = signal
                            await Promise.race([
                                held,
                                new Promise<void>((resolve) =>
                                    signal.addEventListener('abort', () => resolve(), { once: true }),
                                ),
                            ])
                        }
                        return encodeWireProposal(buildFallbackProposalV2(request.context.material))
                    },
                },
            )
            const application = createApp({ runtime, onDuration: () => {} })
            const inputs = documentInputs('guide')
            const old = read(application, inputs, oldQuery)
            try {
                await vi.waitFor(() => expect(oldSignal).toBeDefined())
                const newer = { ...inputs, session: { ...inputs.session!, revision: inputs.session!.revision + 1 } }
                await read(application, newer, '?guideRepair=1&waitCopy=2')
                expect(oldSignal!.aborted).toBe(true)
                expect((await old).value.document!.metadata.fallbackReason).toBe('stale')
            } finally {
                release()
                await old
                log.mockRestore()
            }
        },
    )

    it('unflagged v40 generated and fallback documents retain the actual v39 checker contract for every kind and activity', async () => {
        const log = vi.spyOn(console, 'info').mockImplementation(() => {})
        try {
            const application = app()
            const cases = []
            for (const kind of SCREEN_KINDS_V2) {
                for (const activity of [
                    'working',
                    'saving',
                    'checking',
                    'reading',
                    'asking',
                    'second-opinion',
                    'question-waiting',
                ] as const) {
                    const inputs = { ...documentInputs(kind), uiState: { ...fullUi, busy: { activity } } }
                    const body = await read(application, inputs, '?guideRepair=1')
                    expect(body).not.toHaveProperty('waitCopy')
                    expect(documentMatchesInputs(body.value.document!, inputs)).toBe(true)
                    cases.push({ body, inputs })
                    const modern = await read(application, inputs, '?guideRepair=1&waitCopy=2')
                    expect(modern.waitCopy).toBe(2)
                    expect(verifyDocumentAgainstInputsV2(modern.value.document!, inputs, hash)).toEqual([])
                }
            }
            // Negative controls exercise the frozen copy gate, with the capability echo removed.
            for (const kind of SCREEN_KINDS_V2) {
                const inputs = documentInputs(kind)
                const modern = await read(application, inputs, '?guideRepair=1&waitCopy=2')
                const { waitCopy: _echo, ...oldShape } = modern
                expect(checkPrompt39([{ body: oldShape, inputs }]), kind).toEqual([
                    { response: true, document: true, issues: expect.arrayContaining(['literal_not_listed']) },
                ])
            }
            const fallback = app('off')
            for (const kind of SCREEN_KINDS_V2) {
                const inputs = documentInputs(kind)
                const body = await read(fallback, inputs, '')
                expect(body.value.document!.metadata.source).toBe('fallback')
                expect(documentMatchesInputs(body.value.document!, inputs)).toBe(true)
                cases.push({ body, inputs })
                const modern = await read(fallback, inputs, '?waitCopy=2')
                expect(modern.waitCopy).toBe(2)
                expect(verifyDocumentAgainstInputsV2(modern.value.document!, inputs, hash)).toEqual([])
            }
            expect(checkPrompt39(cases)).toEqual(cases.map(() => ({ response: true, document: true, issues: [] })))
        } finally {
            log.mockRestore()
        }
    }, 30_000)

    it('preserves array job hashes and app acceptance through precompute, progress and cancel in both copy modes', async () => {
        const log = vi.spyOn(console, 'info').mockImplementation(() => {})
        try {
            const application = app()
            const inputs = documentInputs('guide')
            const base = screensV2GenerateRequest('copy-jobs', inputs, hash)
            const common = {
                ...base,
                kind: null,
                stepId: null,
                contextKey: null,
                focusKey: null,
                requestedKinds: ['guide'],
                want: [],
            }
            const jobs = {
                session: inputs.session!,
                focusKey: null,
                uiState: inputs.uiState,
                completedStepIds: inputs.completedStepIds,
                requestedKinds: ['guide'] as const,
            }
            const expected = hash(
                canonicalJson(precomputeItems(jobs).map((item) => hash(screenContextJsonV2(item.inputs)))),
            )
            expect(documentJobContextKey(jobs)).toBe(expected)
            const invoke = async (
                op: 'precompute' | 'progress' | 'cancel',
                query: string,
            ): Promise<Extract<ScreensV2Result, { status: 'ok' }>> => {
                const metadata: ModelScreensV2Metadata = modelScreensV2MetadataSchema.parse({
                    ...common,
                    op,
                    want: op === 'progress' ? ['guide:step-1'] : [],
                })
                const form = new FormData()
                form.set('metadata', JSON.stringify(metadata))
                const response = await application.request(`/api/screens/v2${query}`, {
                    method: 'POST',
                    headers: { 'x-truebuild-key': key },
                    body: form,
                })
                const text = await response.text()
                if (!query.includes('waitCopy')) expect(checkPrompt39Response(JSON.parse(text))).toBe(true)
                const interpreted = interpretDocuments(response.status, text, metadata)
                expect(interpreted.status).toBe('ok')
                if (interpreted.status !== 'ok') throw new Error(interpreted.code)
                expect(interpreted.value.progress?.contextKey).toBe(expected)
                return interpreted
            }
            const oldQuery = '?guideRepair=1'
            const newQuery = '?guideRepair=1&waitCopy=2'
            await invoke('precompute', oldQuery)
            await invoke('precompute', newQuery)
            const documents = []
            for (const query of [oldQuery, newQuery]) {
                await vi.waitFor(async () => {
                    const result = await invoke('progress', query)
                    expect(result.value.documents).toHaveLength(1)
                })
                documents.push((await invoke('progress', query)).value.documents[0]!)
            }
            expect(documents[0]!.screenId).not.toBe(documents[1]!.screenId)
            await invoke('cancel', oldQuery)
            const modern = await invoke('progress', newQuery)
            expect(modern.value.progress!.items.every((item) => item.state !== 'cancelled')).toBe(true)
            await invoke('cancel', newQuery)
        } finally {
            log.mockRestore()
        }
    })

    it('flags only exact singleton 2 and keeps old/new requests isolated on the same server', async () => {
        const log = vi.spyOn(console, 'info').mockImplementation(() => {})
        try {
            const application = app()
            const inputs = documentInputs('guide')
            const modern = await read(application, inputs, '?guideRepair=1&waitCopy=2')
            expect(modern.waitCopy).toBe(2)
            expect(verifyDocumentAgainstInputsV2(modern.value.document!, inputs, hash)).toEqual([])
            for (const query of ['', '?waitCopy=1', '?waitCopy=true', '?waitCopy=2&waitCopy=2']) {
                const legacy = await read(application, inputs, query)
                expect(legacy).not.toHaveProperty('waitCopy')
                expect(legacy.value.document!.screenId).not.toBe(modern.value.document!.screenId)
            }
            const again = await read(application, inputs, '?guideRepair=1&waitCopy=2')
            expect(again.waitCopy).toBe(2)
            expect(again.value.document!.screenId).toBe(modern.value.document!.screenId)
        } finally {
            log.mockRestore()
        }
    })
})
