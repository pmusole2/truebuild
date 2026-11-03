import { createDemoManual, type CheckResult, type ParsedManual, type QuestionResult } from '@truebuild/contracts'
import { ModelApiClient, type ModelFetch } from '../../../api/model-client'
import { jpegHeader } from '../../../media/test-fixtures'
import type { locateInPhoto } from '../../assembly/localize'
import { CaptureController } from '../../capture/controller'
import { LibraryStorage, type KeyValueStorage, type LibraryEntry } from '../../capture/library'

// Shared device/transport boundary for tests that mount the real routes with the real controller. Everything the person
// sees comes from the production routes; only the fetch, storage and image normalization are injected.

export const bytes = Uint8Array.from(jpegHeader(600, 800))
export const source = { uri: 'file:///synthetic-flow-source.jpg', width: 600, height: 800 }
const image = { ...source, bytes, mimeType: 'image/jpeg' as const }
const digest = async (): Promise<string> => 'a'.repeat(64)

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

export function parsed(pageId: string): ParsedManual {
    const manual = createDemoManual()
    const value = JSON.parse(
        JSON.stringify({ parts: manual.parts, steps: manual.reviewedSteps, unknowns: [] }).replaceAll(
            'demo-page-1',
            pageId,
        ),
    ) as ParsedManual
    for (const step of value.steps) {
        if (step.correction !== null) step.correction.reviewed = false
    }
    return value
}

export function entry(
    manualId = 'flow-manual',
    stage: 'reviewed' | 'unreviewed' | 'unparsed' = 'reviewed',
    steps = 3,
    label = 'Step',
): LibraryEntry {
    const session = createDemoManual()
    session.manualId = manualId
    session.title = manualId
    session.pages[0]!.contentHash = 'a'.repeat(64)
    session.reviewStatus = stage === 'reviewed' ? 'reviewed' : 'unreviewed'
    session.rawExtraction = stage === 'unparsed' ? null : parsed(session.pages[0]!.pageId)
    if (stage === 'unparsed') {
        session.reviewedSteps = []
        session.parts = []
    } else {
        const first = session.reviewedSteps[0]!
        session.reviewedSteps = Array.from({ length: steps }, (_, index) => ({
            ...first,
            stepId: `step-${index + 1}`,
            order: index + 1,
            title: `${label} ${index + 1}: ${first.title}`,
        }))
    }
    return { session, stepIndex: 0, completedStepIds: [], capture: null }
}

export type Replies = {
    /** Makes the check call fail at the transport boundary, as an unreachable checker would. */
    failCheck?: boolean
    /** Offered after the verdict. Absent means the server offered nothing (generated screens off). */
    followUps?: CheckResult['followUps']
    overlay?: Record<string, unknown>
    locate?: typeof locateInPhoto
    check?: Partial<CheckResult> | (() => Promise<Partial<CheckResult>>)
    answer?: Partial<QuestionResult>
    /** Held until released, so a test can observe the working state. */
    parse?: Promise<void>
    check_gate?: Promise<void>
    /** The closer look is held until released, then replies with these overrides on the primary check's shape. */
    second_opinion_gate?: Promise<void>
    second_opinion?: Partial<CheckResult>
    /** Held until released, so a test can observe the pending question before its answer arrives. */
    question_gate?: Promise<void>
    /** The question is handed back as a 202 ticket (the screen then says it is still thinking); the gate holds its result. */
    question_ticket?: boolean
}

export async function runtime(
    entries: LibraryEntry[],
    replies: Replies = {},
): Promise<{ controller: CaptureController; storage: LibraryStorage; calls: string[] }> {
    const data = new Map<string, string>()
    const kv: KeyValueStorage = {
        getItem: async (key) => data.get(key) ?? null,
        setItem: async (key, value) => void data.set(key, value),
        removeItem: async (key) => void data.delete(key),
        getAllKeys: async () => [...data.keys()],
    }
    const storage = new LibraryStorage(kv, digest)
    await storage.restore()
    if (entries.length > 0) {
        await storage.save(
            entries,
            entries.flatMap((item) => item.session.pages.map((page) => ({ assetId: page.assetId, bytes }))),
        )
    }
    const calls: string[] = []
    let askedPages: string[] | undefined
    const fetch: ModelFetch = async (url, init) => {
        const path = new URL(url).pathname
        calls.push(path)
        // A ticketed question is collected with a JSON body that names no pages; they were named by the question itself.
        const collecting = url.endsWith('/questions/result')
        const meta = JSON.parse(String(collecting ? init.body : (init.body as FormData).get('metadata'))) as {
            requestId: string
            binding: Record<string, unknown>
            pages?: { pageId: string }[]
            sourcePageIds?: string[]
        }
        if (path === '/api/manuals/parse') await replies.parse
        if (url.endsWith('/checks') && replies.failCheck === true) return new Response('', { status: 502 })
        if (url.endsWith('/checks')) await replies.check_gate
        const closer = url.endsWith('/second-opinion')
        if (closer) await replies.second_opinion_gate
        if (url.endsWith('/questions') && replies.question_ticket === true) {
            askedPages = meta.sourcePageIds
            return new Response(
                JSON.stringify({
                    status: 'pending',
                    requestId: meta.requestId,
                    binding: meta.binding,
                    ticket: 'flow-ticket',
                    retryAfterMs: 500,
                    expiresInMs: 30_000,
                }),
                { status: 202, headers: { 'content-type': 'application/json' } },
            )
        }
        if (url.endsWith('/questions') || collecting) await replies.question_gate
        const ref = { pageId: (collecting ? askedPages : meta.sourcePageIds)?.[0] ?? 'page', region: null }
        if (url.endsWith('/checks/overlay')) {
            const body = replies.overlay ?? { model: 'muse-wonder-1.0', effort: 'max', observedRegion: null }
            return new Response(
                JSON.stringify({
                    status: 'ok',
                    mode: 'model',
                    requestId: meta.requestId,
                    binding: meta.binding,
                    value: body,
                }),
                { headers: { 'content-type': 'application/json' } },
            )
        }
        const overrides =
            closer && replies.second_opinion !== undefined
                ? replies.second_opinion
                : typeof replies.check === 'function'
                  ? await replies.check()
                  : (replies.check ?? {})
        const value =
            path === '/api/manuals/parse'
                ? parsed(meta.pages![0]!.pageId)
                : url.endsWith('/questions') || collecting
                  ? { answer: 'The groove faces inward.', sourceRefs: [ref], missingEvidence: [], ...replies.answer }
                  : ({
                        decision: 'pass',
                        reason: 'The groove faces inward.',
                        sourceRefs: [ref],
                        observedRegion: null,
                        missingEvidence: [],
                        ...(replies.followUps === undefined ? {} : { followUps: replies.followUps }),
                        ...overrides,
                    } satisfies CheckResult)
        return new Response(
            JSON.stringify({ status: 'ok', mode: 'model', requestId: meta.requestId, binding: meta.binding, value }),
            { headers: { 'content-type': 'application/json' } },
        )
    }
    let sequence = 0
    const controller = new CaptureController({
        storage,
        client: new ModelApiClient({ baseUrl: 'https://flow.invalid', secret: '', fetch }),
        digest,
        normalize: async (): Promise<typeof image> => image,
        id: (): string => `flow-${++sequence}`,
        ...(replies.locate === undefined ? {} : { locate: replies.locate }),
    })
    return { controller, storage, calls }
}
