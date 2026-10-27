import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnv, isDeepStrictEqual } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
    LIMITS,
    apiResultSchema,
    parsedManualSchema,
    checkResultSchema,
    normalizedBoxSchema,
    manualSessionSchema,
    segmentEventSchema,
    matchesBinding,
    type ParsedManual,
    type ManualStep,
    type ManualPage,
    type CaptureBinding,
} from '@truebuild/contracts'
import {
    modelParseMetadataSchema,
    modelCheckMetadataSchema,
    modelSegmentMetadataSchema,
    selectStepSourcePageIds,
} from '@truebuild/contracts/model'

const image = z.strictObject({
    path: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
})
export const manifestSchema = z.strictObject({
    pages: z
        .array(image.extend({ pageId: z.string().min(1), assetId: z.string().min(1) }))
        .min(1)
        .max(LIMITS.manualPages),
    expected: parsedManualSchema,
    observation: image,
    expectedDecision: z.enum(['pass', 'refuse', 'cannot_verify']),
    stepId: z.string().min(1),
    sourcePageIds: z.array(z.string().min(1)).min(1).max(2).optional(),
    localization: z.enum(['spark', 'sam']).optional(),
    expectedObservationRegion: normalizedBoxSchema.optional(),
    minimumBoxIou: z.number().positive().max(1).optional(),
    prompt: z.string().min(1).optional(),
    clip: z.strictObject({ path: z.string().min(1), mimeType: z.enum(['video/mp4', 'video/quicktime']) }).optional(),
})
type Manifest = z.infer<typeof manifestSchema>
type Summary = {
    gate: number
    status: 'pass' | 'fail' | 'unverified'
    reason: string
    requests: number
    latenciesMs: number[]
    strictStructuralMatchPercent?: number
    structurallyMatchedSteps?: number
    expectedSteps?: number
    returnedSteps?: number
    sourceCount?: number
    fullManual?: boolean
    stableTrackIds?: boolean
    localizationProvider?: 'spark' | 'sam'
    boxIou?: number
    semanticStepAccuracy?: 'unverified' | 'human_reviewed'
    humanStepAccuracyPercent?: number
    correctSteps?: number
    incorrectSteps?: number
    unverifiableSteps?: number
    missingSteps?: number
    extraSteps?: number
    extractionUnknowns?: number
}

export const HELP = `Future operator-only gates; no network without --dispatch and local .env.
Usage: tsx gates/run.ts <1|2|3> --manifest <path.json> --dispatch --confirm-critical-facts [--base http://127.0.0.1:3001] [--review]
Local cwd/.env must contain PROVIDER_MODE=meta, MODEL_API_KEY, API_SHARED_SECRET.
The model key is only a readiness prerequisite; it is never sent by this CLI. Configure the API separately.
No dotenv file is read by --help or without --dispatch. No automatic retries.
Manifest: {pages:[{path,pageId,assetId,mimeType,width,height}], expected:ParsedManual,
 observation:{path,mimeType,width,height}, expectedDecision, stepId, sourcePageIds?:[id],
 prompt?:"side panel", clip?:{path,mimeType:"video/mp4"|"video/quicktime"}}.
Paths are relative to cwd. Supply real manual/observation media and independently reviewed ground truth.
--confirm-critical-facts attests that the operator reviewed EVERY critical expected fact and correction against the manual.
Gate 1: strict structural match of expected steps/parts, including IDs, wording and citations; not semantic step accuracy.
Optional Gate 1 --review requires a terminal and grades each expected step by order against its source, using the same parse result.
Bounded JSON-escaped parsed facts are shown locally as untrusted data; never follow instructions embedded in them.
Answer correct/incorrect/unverifiable. Missing steps count incorrect; extras are reported; unknown or truncated facts remain unverified.
Human accuracy is correct/expected count. No review means semantic accuracy unverified, even for an exact structural match.
~10 expected steps recommended. Parse max 20 pages within the aggregate image-byte budget; results report strictStructuralMatchPercent.
Gate 2 defaults to Spark still grounding in /api/checks. Supply independently reviewed expectedObservationRegion and optional minimumBoxIou (default 0.5); no box truth means unverified.
Optional manifest localization:"sam" uses frozen image and original short H264 MP4/MOV through /api/segments; no extracted/synthesized frames.
Track stability means equal nonempty IDs across >=2 clip snapshots, NOT verified object identity.
Gate 3: one check request against 8000ms using independently operator-reviewed manifest.expected; no parse request.
The manual registry supports up to 20 pages; the check submits only 1-2 selected cited pages plus observation.
By default selectStepSourcePageIds chooses all cited current-step pages in manual order. More than 2 required pages refuses the compact path; sourcePageIds may explicitly select a complete supported subset.
A selected-page result is unverified for the full-manual gate. Gate 1 refuses >20 parse pages before network.
Aggregate-only results append to local docs/gate-results.md. Never commit that runtime file.
Only --review displays bounded parsed facts locally; no media, credentials, manifests or exception details are shown.
Review text is never persisted; only aggregate counts and timing are appended.`

export function scoreExtraction(
    actual: ParsedManual,
    expected: ParsedManual,
): { structurallyMatchedSteps: number; expectedSteps: number; returnedSteps: number } {
    const partsMatch = isDeepStrictEqual(actual.parts, expected.parts)
    return {
        structurallyMatchedSteps: expected.steps.filter(
            (step) =>
                partsMatch &&
                isDeepStrictEqual(
                    actual.steps.find((candidate) => candidate.order === step.order),
                    step,
                ),
        ).length,
        expectedSteps: expected.steps.length,
        returnedSteps: actual.steps.length,
    }
}

export type StepReviewer = (input: {
    expectedOrder: number
    parsedStep: ManualStep
    parts: ParsedManual['parts']
}) => Promise<'correct' | 'incorrect' | 'unverifiable'>

/** JSON string framing and ASCII escaping prevent terminal controls from model text executing. */
export function reviewDisplay(input: Parameters<StepReviewer>[0]): { text: string; truncated: boolean } {
    const raw = JSON.stringify(input)
    const escaped = raw.replace(
        /[\u007f-\uffff]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    const truncated = escaped.length > 12_000
    return { text: JSON.stringify(escaped.slice(0, 12_000)), truncated }
}

function hasUnknown(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false
    if ('state' in value && value.state === 'unknown') return true
    return Object.values(value).some(hasUnknown)
}

const terminalReviewer: StepReviewer = async (input) => {
    const display = reviewDisplay(input)
    console.log(`Untrusted parsed facts for expected step order ${input.expectedOrder}: ${display.text}`)
    if (display.truncated) {
        console.log('Facts exceed display limit; this step remains unverifiable.')
        return 'unverifiable'
    }
    const terminal = createInterface({ input: process.stdin, output: process.stdout })
    try {
        const answer = (await terminal.question('Against the source: correct / incorrect / unverifiable? '))
            .trim()
            .toLowerCase()
        return answer === 'correct' || answer === 'incorrect' ? answer : 'unverifiable'
    } finally {
        terminal.close()
    }
}

async function reviewExtraction(
    actual: ParsedManual,
    expected: ParsedManual,
    reviewer: StepReviewer,
    summary: Summary,
): Promise<void> {
    summary.correctSteps = 0
    summary.incorrectSteps = 0
    summary.unverifiableSteps = 0
    summary.missingSteps = 0
    summary.extraSteps = actual.steps.filter(
        (step) => !expected.steps.some((candidate) => candidate.order === step.order),
    ).length
    summary.extractionUnknowns = actual.unknowns.length
    for (const expectedStep of expected.steps) {
        const parsedStep = actual.steps.find((step) => step.order === expectedStep.order)
        if (!parsedStep) {
            summary.missingSteps++
            summary.incorrectSteps++
            continue
        }
        const partIds = new Set([
            ...parsedStep.parts.map((part) => part.partId),
            ...(parsedStep.orientation.state === 'known' ? [parsedStep.orientation.value.partId] : []),
            ...(parsedStep.connection.state === 'known' ? parsedStep.connection.value.partIds : []),
        ])
        const input = {
            expectedOrder: expectedStep.order,
            parsedStep,
            parts: actual.parts.filter((part) => partIds.has(part.partId)),
        }
        const answer = await reviewer(input)
        if (hasUnknown(input) || reviewDisplay(input).truncated || answer === 'unverifiable')
            summary.unverifiableSteps++
        else if (answer === 'correct') summary.correctSteps++
        else summary.incorrectSteps++
    }
    summary.humanStepAccuracyPercent = expected.steps.length
        ? Math.round((10_000 * summary.correctSteps) / expected.steps.length) / 100
        : 0
    const unknown = summary.unverifiableSteps > 0 || summary.extractionUnknowns > 0 || expected.steps.length === 0
    summary.semanticStepAccuracy = unknown ? 'unverified' : 'human_reviewed'
    summary.status = summary.incorrectSteps > 0 || summary.extraSteps > 0 ? 'fail' : unknown ? 'unverified' : 'pass'
    summary.reason = 'human_step_review'
}

export async function loadAuthorization(cwd: string, dispatch: boolean): Promise<{ secret: string }> {
    if (!dispatch) throw new Error('operator_dispatch_required')
    let env: Record<string, string | undefined>
    try {
        env = parseEnv(await readFile(resolve(cwd, '.env'), 'utf8'))
    } catch {
        throw new Error('local_key_required')
    }
    if (env.PROVIDER_MODE !== 'meta') throw new Error('meta_mode_required')
    if (!env.MODEL_API_KEY?.trim()) throw new Error('local_key_required')
    if (!env.API_SHARED_SECRET?.trim()) throw new Error('shared_secret_required')
    return { secret: env.API_SHARED_SECRET }
}

function baseUrl(value: string): URL {
    const url = new URL(value)
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' &&
            !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    ) {
        throw new Error('invalid_api_base')
    }
    return url
}

async function bytes(cwd: string, path: string, max: number): Promise<Uint8Array<ArrayBuffer>> {
    const data = await readFile(resolve(cwd, path))
    if (data.length === 0 || data.length > max) throw new Error('invalid_media')
    return new Uint8Array(data)
}

async function boundedText(response: Response): Promise<string> {
    if (!response.body) throw new Error('invalid_response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            if (size > 4_194_304) throw new Error('invalid_response')
            chunks.push(value)
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } finally {
        await reader.cancel().catch(() => {})
    }
}

export async function runGate(
    gate: number,
    manifest: Manifest,
    cwd: string,
    base: URL,
    secret: string,
    fetchImpl: typeof fetch = fetch,
    reviewer?: StepReviewer,
): Promise<Summary> {
    const summary: Summary = { gate, status: 'unverified', reason: 'not_completed', requests: 0, latenciesMs: [] }
    const manualId = randomUUID()
    const binding = { kind: 'manual' as const, manualId, revision: 1 }
    const capture: CaptureBinding = { ...binding, kind: 'capture', stepId: manifest.stepId, captureId: randomUUID() }
    async function post(
        route: string,
        metadata: unknown,
        files: { name: string; data: Uint8Array<ArrayBuffer>; mime: string }[],
    ): Promise<string> {
        const form = new FormData()
        form.set('metadata', JSON.stringify(metadata))
        for (const file of files) form.set(file.name, new Blob([file.data], { type: file.mime }), 'media')
        const start = performance.now()
        summary.requests += 1
        try {
            const response = await fetchImpl(new URL(route, base), {
                method: 'POST',
                redirect: 'error',
                headers: { 'x-truebuild-key': secret },
                body: form,
                signal: AbortSignal.timeout(45_000),
            })
            if (!response.ok) {
                await response.body?.cancel()
                throw new Error('api_unavailable')
            }
            return await boundedText(response)
        } finally {
            summary.latenciesMs.push(Math.round(performance.now() - start))
        }
    }
    try {
        if (gate === 2 && manifest.localization !== 'sam' && !manifest.expectedObservationRegion) {
            summary.reason = 'operator_box_truth_required'
            return summary
        }
        if (gate === 2 && manifest.localization === 'sam') {
            summary.localizationProvider = 'sam'
            if (!manifest.clip || !manifest.prompt) throw new Error('clip_and_prompt_required')
            const tracks: string[][] = []
            for (const media of [manifest.observation, manifest.clip]) {
                const isClip = media === manifest.clip
                const requestId = randomUUID()
                const metadata = modelSegmentMetadataSchema.parse({
                    mode: 'model',
                    requestId,
                    binding: capture,
                    capturedAt: new Date().toISOString(),
                    prompt: manifest.prompt,
                    media: isClip
                        ? { kind: 'clip', mimeType: media.mimeType }
                        : {
                              kind: 'image',
                              mimeType: manifest.observation.mimeType,
                              width: manifest.observation.width,
                              height: manifest.observation.height,
                          },
                })
                const raw = await post('/api/segments', metadata, [
                    {
                        name: 'media',
                        data: await bytes(cwd, media.path, isClip ? 20 * 1_024 * 1_024 : LIMITS.imageBytes),
                        mime: media.mimeType,
                    },
                ])
                let completed = false
                let snapshots = 0
                let streamId: string | undefined
                let frameIndex = -1
                for (const block of raw.split(/\r?\n\r?\n/u).filter((block) => block.trim())) {
                    const data = block
                        .split(/\r?\n/u)
                        .filter((line) => line.startsWith('data:'))
                        .map((line) => line.slice(5).trim())
                        .join('\n')
                    if (!data) continue
                    if (completed) throw new Error('invalid_stream')
                    const envelope = apiResultSchema(segmentEventSchema).parse(JSON.parse(data))
                    if (
                        envelope.status !== 'ok' ||
                        envelope.mode !== 'model' ||
                        envelope.requestId !== requestId ||
                        !matchesBinding(envelope.binding, capture)
                    )
                        throw new Error('invalid_stream')
                    const event = envelope.value
                    if (event.type === 'unavailable') throw new Error('api_unavailable')
                    if (event.type === 'completed') {
                        completed = true
                        continue
                    }
                    if (
                        !matchesBinding(event.snapshot.binding, capture) ||
                        event.snapshot.frameIndex <= frameIndex ||
                        (streamId && streamId !== event.snapshot.streamId)
                    )
                        throw new Error('invalid_stream')
                    streamId = event.snapshot.streamId
                    frameIndex = event.snapshot.frameIndex
                    snapshots += 1
                    if (isClip) tracks.push(event.snapshot.records.map((record) => record.objectId).sort())
                }
                if (!completed || snapshots === 0) throw new Error('incomplete_stream')
            }
            summary.stableTrackIds =
                tracks.length >= 2 && tracks.every((ids) => ids.length > 0 && isDeepStrictEqual(ids, tracks[0]))
            summary.status = summary.stableTrackIds ? 'pass' : 'unverified'
            summary.reason = summary.stableTrackIds ? 'transport_and_id_stability_only' : 'track_stability_unverified'
            return summary
        }
        if (gate === 3) {
            summary.sourceCount = manifest.sourcePageIds?.length ?? manifest.pages.length
            summary.fullManual = !manifest.sourcePageIds || manifest.sourcePageIds.length === manifest.pages.length
            if (manifest.sourcePageIds && summary.sourceCount > 2) throw new Error('check_source_limit_2')
        }
        if (gate === 1 && manifest.pages.length > LIMITS.manualPages) throw new Error('parse_source_limit_20')
        const sources = await Promise.all(
            manifest.pages.map(async (page) => {
                const data = await bytes(cwd, page.path, LIMITS.imageBytes)
                const metadata: ManualPage = {
                    pageId: page.pageId,
                    assetId: page.assetId,
                    mimeType: page.mimeType,
                    width: page.width,
                    height: page.height,
                    contentHash: createHash('sha256').update(data).digest('hex'),
                }
                return { data, metadata }
            }),
        )
        if (gate === 1) {
            const requestId = randomUUID()
            const parseMetadata = modelParseMetadataSchema.parse({
                mode: 'model',
                requestId,
                binding,
                pages: sources.map((source) => source.metadata),
            })
            const parsed = apiResultSchema(parsedManualSchema).parse(
                JSON.parse(
                    await post(
                        '/api/manuals/parse',
                        parseMetadata,
                        sources.map((source, index) => ({
                            name: `source-${index}`,
                            data: source.data,
                            mime: source.metadata.mimeType,
                        })),
                    ),
                ),
            )
            if (
                parsed.status !== 'ok' ||
                parsed.mode !== 'model' ||
                parsed.requestId !== requestId ||
                !matchesBinding(parsed.binding, binding)
            )
                throw new Error('invalid_parse')
            manualSessionSchema.parse({
                manualId,
                revision: 1,
                title: 'Unreviewed gate extraction',
                updatedAt: new Date().toISOString(),
                pages: sources.map((source) => source.metadata),
                parts: [],
                rawExtraction: parsed.value,
                reviewedSteps: [],
                reviewStatus: 'unreviewed',
            })
            Object.assign(summary, scoreExtraction(parsed.value, manifest.expected))
            summary.strictStructuralMatchPercent = summary.expectedSteps
                ? Math.round((10000 * summary.structurallyMatchedSteps!) / summary.expectedSteps) / 100
                : 0
            summary.semanticStepAccuracy = 'unverified'
            summary.status = 'unverified'
            summary.reason = 'structural_score_only_semantic_unverified'
            if (reviewer) await reviewExtraction(parsed.value, manifest.expected, reviewer, summary)
            return summary
        }
        const session = manualSessionSchema.parse({
            manualId,
            revision: 1,
            title: 'Operator gate',
            updatedAt: new Date().toISOString(),
            pages: sources.map((source) => source.metadata),
            parts: manifest.expected.parts,
            rawExtraction: manifest.expected,
            reviewedSteps: manifest.expected.steps.map((step) => ({
                ...step,
                correction: step.correction ? { ...step.correction, reviewed: true } : null,
            })),
            reviewStatus: 'reviewed',
        })
        const selected = manifest.sourcePageIds ?? selectStepSourcePageIds(session, manifest.stepId)
        if (!selected) throw new Error('check_source_limit_2')
        summary.sourceCount = selected.length
        summary.fullManual = selected.length === sources.length
        const checkRequestId = randomUUID()
        const metadata = modelCheckMetadataSchema.parse({
            mode: 'model',
            requestId: checkRequestId,
            binding: capture,
            session,
            sourcePageIds: selected,
            observation: {
                mimeType: manifest.observation.mimeType,
                width: manifest.observation.width,
                height: manifest.observation.height,
            },
        })
        const selectedFiles = selected.map((id, index) => {
            const source = sources.find((source) => source.metadata.pageId === id)!
            return { name: `source-${index}`, data: source.data, mime: source.metadata.mimeType }
        })
        const checked = apiResultSchema(checkResultSchema).parse(
            JSON.parse(
                await post('/api/checks', metadata, [
                    ...selectedFiles,
                    {
                        name: 'observation',
                        data: await bytes(cwd, manifest.observation.path, LIMITS.imageBytes),
                        mime: manifest.observation.mimeType,
                    },
                ]),
            ),
        )
        if (
            checked.status !== 'ok' ||
            checked.mode !== 'model' ||
            checked.requestId !== checkRequestId ||
            !matchesBinding(checked.binding, capture)
        )
            throw new Error('invalid_check')
        if (gate === 2) {
            summary.localizationProvider = 'spark'
            const actual = checked.value.observedRegion
            const expected = manifest.expectedObservationRegion
            if (!actual || !expected) {
                summary.reason = 'operator_box_truth_or_observation_missing'
                return summary
            }
            const intersection =
                Math.max(
                    0,
                    Math.min(actual.x + actual.width, expected.x + expected.width) - Math.max(actual.x, expected.x),
                ) *
                Math.max(
                    0,
                    Math.min(actual.y + actual.height, expected.y + expected.height) - Math.max(actual.y, expected.y),
                )
            summary.boxIou = Math.min(
                1,
                intersection / (actual.width * actual.height + expected.width * expected.height - intersection),
            )
            const meets =
                checked.value.decision === manifest.expectedDecision &&
                summary.boxIou >= (manifest.minimumBoxIou ?? 0.5)
            summary.status = meets ? 'pass' : 'fail'
            summary.reason = meets ? 'spark_still_box_operator_truth' : 'spark_decision_or_box_failed'
            return summary
        }
        const meets = checked.value.decision === manifest.expectedDecision && summary.latenciesMs.at(-1)! <= 8_000
        summary.status = !meets ? 'fail' : summary.fullManual ? 'pass' : 'unverified'
        summary.reason = !meets
            ? 'decision_or_latency_failed'
            : summary.fullManual
              ? 'supported_full_sources_within_8s'
              : 'selected_sources_only_full_manual_unverified'
    } catch (error: unknown) {
        summary.status = 'unverified'
        summary.reason =
            error instanceof Error &&
            ['parse_source_limit_20', 'check_source_limit_2', 'clip_and_prompt_required'].includes(error.message)
                ? error.message
                : 'request_or_contract_refused_no_retry'
    }
    return summary
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
    if (argv.includes('--help')) {
        console.log(HELP)
        return 0
    }
    const gate = Number(argv[0])
    if (![1, 2, 3].includes(gate)) {
        console.log('Specify gate 1, 2, or 3; use --help.')
        return 2
    }
    const option = (name: string): string | undefined => {
        const index = argv.indexOf(name)
        return index < 0 ? undefined : argv[index + 1]
    }
    let summary: Summary
    try {
        const { secret } = await loadAuthorization(cwd, argv.includes('--dispatch'))
        if (!argv.includes('--confirm-critical-facts')) throw new Error('critical_facts_confirmation_required')
        if (argv.includes('--review') && (gate !== 1 || !process.stdin.isTTY || !process.stdout.isTTY))
            throw new Error('interactive_gate1_review_required')
        const manifestPath = option('--manifest')
        if (!manifestPath) throw new Error('manifest_required')
        const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(cwd, manifestPath), 'utf8')))
        summary = await runGate(
            gate,
            manifest,
            cwd,
            baseUrl(option('--base') ?? 'http://127.0.0.1:3001'),
            secret,
            fetch,
            argv.includes('--review') ? terminalReviewer : undefined,
        )
    } catch (error: unknown) {
        const allowed = [
            'operator_dispatch_required',
            'local_key_required',
            'meta_mode_required',
            'shared_secret_required',
            'critical_facts_confirmation_required',
            'manifest_required',
            'interactive_gate1_review_required',
        ]
        summary = {
            gate,
            status: 'unverified',
            reason: error instanceof Error && allowed.includes(error.message) ? error.message : 'input_refused',
            requests: 0,
            latenciesMs: [],
        }
    }
    const latency = summary.latenciesMs
    const report = {
        ...summary,
        latencyMeanMs: latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : null,
        latencyMaxMs: latency.length ? Math.max(...latency) : null,
    }
    const line = JSON.stringify(report)
    await mkdir(resolve(cwd, 'docs'), { recursive: true })
    await appendFile(resolve(cwd, 'docs/gate-results.md'), `- ${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
    console.log(line)
    return summary.status === 'pass' ? 0 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code
        })
        .catch(() => {
            console.log('Gate unverified: local execution failed.')
            process.exitCode = 2
        })
}
