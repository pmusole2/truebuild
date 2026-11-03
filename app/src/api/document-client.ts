import {
    canonicalJson,
    screenContextJsonV2,
    screenManualJsonV2,
    screenStageV2,
    verifyDocumentAgainstInputsV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import {
    MODEL_METADATA_MAX_BYTES,
    MODEL_STEP_PAGE_TIMEOUT_MS,
    modelScreensV2MetadataSchema,
    screensV2GenerateRequest,
    screensV2ResultSchema,
    type ModelScreensV2Metadata,
    type PrecomputeKindV2,
    type ScreensV2Result,
} from '@truebuild/contracts/model'
import type { ModelFetch, ModelRequestContext } from './model-client'
import { sha256Hex } from '../features/documents/sha256'
import {
    awaitStopped,
    createCallGuard,
    discardResponse,
    InvalidResponseError,
    parseBaseUrl,
    readBoundedText,
} from './transport'

type JobInputs = {
    readonly session: ManualSession
    readonly uiState?: ScreenUiStateV2 | null
    readonly completedStepIds?: readonly string[]
    readonly requestedKinds?: readonly PrecomputeKindV2[]
}
/** Eight ordinary maximum composed documents plus their envelope; measured headroom, never a token/cost estimate. */
export const DOCUMENT_RESPONSE_MAX_BYTES = 16 * 1_024 * 1_024
export type ScreensV2Request =
    | { readonly op: 'generate'; readonly inputs: ScreenContextInputsV2 }
    | (JobInputs & { readonly op: 'precompute'; readonly focusKey: string | null })
    | (JobInputs & { readonly op: 'progress'; readonly want: readonly string[]; readonly jobContextKey: string })
    | (JobInputs & { readonly op: 'cancel' })

export function inputsFromDocumentMetadata(metadata: ModelScreensV2Metadata): ScreenContextInputsV2 {
    if (metadata.kind === null) throw new Error('document_kind_required')
    return {
        kind: metadata.kind,
        session: metadata.session,
        stepId: metadata.stepId,
        captureId: metadata.captureId,
        result: metadata.result,
        companionAnswer: metadata.companionAnswer ?? null,
        failure: metadata.failure,
        completedStepIds: metadata.completedStepIds,
        uiState: metadata.uiState,
        ...(metadata.pieces == null ? {} : { pieces: metadata.pieces }),
        ...(metadata.stepPieces == null ? {} : { stepPieces: metadata.stepPieces }),
    }
}

/** Mirrors the published server job ordering, retaining the exact state each returned document was composed from. */
export function documentPrecomputeInputs(request: JobInputs): { key: string; inputs: ScreenContextInputsV2 }[] {
    const { session, uiState, completedStepIds } = request
    const reviewed = session.reviewStatus === 'reviewed'
    const steps = reviewed ? session.reviewedSteps : (session.rawExtraction?.steps ?? [])
    const common = { session, stepId: null, captureId: null, result: null, failure: null, uiState } as const
    const items: { key: string; inputs: ScreenContextInputsV2 }[] = [
        { key: 'reading', inputs: { ...common, kind: 'reading' } },
        ...steps.map((step) => ({
            key: `guide:${step.stepId}`,
            inputs: { ...common, kind: 'guide' as const, stepId: step.stepId },
        })),
    ]
    if (reviewed) items.push({ key: 'completion', inputs: { ...common, kind: 'completion', completedStepIds } })
    const sessionless = { ...common, session: null }
    if (uiState?.judge || uiState?.sections) items.push({ key: 'judge', inputs: { ...sessionless, kind: 'judge' } })
    if ((uiState?.library?.entries.length ?? 0) >= 2)
        items.push({ key: 'compare', inputs: { ...sessionless, kind: 'compare' } })
    if (uiState?.library) items.push({ key: 'home', inputs: { ...sessionless, kind: 'home' } })
    const requested = request.requestedKinds
    const selected = new Set<ScreenKindV2>(requested)
    return requested === undefined ? items : items.filter((item) => selected.has(item.inputs.kind))
}

export function documentJobContextKey(request: JobInputs): string {
    return sha256Hex(
        canonicalJson(documentPrecomputeInputs(request).map((item) => sha256Hex(screenContextJsonV2(item.inputs)))),
    )
}

export function documentRequest(request: ScreensV2Request, requestId: string): ModelScreensV2Metadata {
    if (request.op === 'generate') return screensV2GenerateRequest(requestId, request.inputs, sha256Hex)
    if (request.op === 'progress' && request.jobContextKey !== documentJobContextKey(request))
        throw new Error('stale_document_job')
    return {
        mode: 'model',
        requestId,
        op: request.op,
        kind: null,
        binding: { kind: 'manual', manualId: request.session.manualId, revision: request.session.revision },
        session: request.session,
        manualHash: sha256Hex(screenManualJsonV2(request.session)),
        stepId: null,
        captureId: null,
        result: null,
        companionAnswer: null,
        failure: null,
        contextKey: null,
        focusKey: request.op === 'precompute' ? request.focusKey : null,
        want: request.op === 'progress' ? [...request.want] : [],
        ...(request.uiState === undefined ? {} : { uiState: request.uiState }),
        ...(request.completedStepIds === undefined ? {} : { completedStepIds: [...request.completedStepIds] }),
        ...(request.requestedKinds === undefined ? {} : { requestedKinds: [...request.requestedKinds] }),
    }
}

type Code = Extract<ScreensV2Result, { status: 'unavailable' }>['code']
export const documentUnavailable = (requestId: string, code: Code, retryable = false): ScreensV2Result => ({
    status: 'unavailable',
    requestId,
    binding: null,
    code,
    retryable,
})

function validRequest(metadata: ModelScreensV2Metadata, requestId: string): boolean {
    if (metadata.requestId !== requestId) return false
    if (metadata.session !== null && metadata.manualHash !== sha256Hex(screenManualJsonV2(metadata.session)))
        return false
    if (metadata.op === 'generate')
        return (
            metadata.want.length === 0 &&
            metadata.requestedKinds === undefined &&
            metadata.focusKey === null &&
            (metadata.session !== null || metadata.binding === null) &&
            metadata.contextKey === sha256Hex(screenContextJsonV2(inputsFromDocumentMetadata(metadata)))
        )
    if (
        metadata.session === null ||
        metadata.contextKey !== null ||
        metadata.kind !== null ||
        metadata.stepId !== null ||
        metadata.captureId !== null ||
        metadata.result !== null ||
        (metadata.companionAnswer !== undefined && metadata.companionAnswer !== null) ||
        (metadata.stepPieces !== undefined && metadata.stepPieces !== null) ||
        metadata.failure !== null ||
        new Set(metadata.want).size !== metadata.want.length ||
        (metadata.op !== 'progress' && metadata.want.length > 0) ||
        (metadata.op !== 'precompute' && metadata.focusKey !== null) ||
        (metadata.requestedKinds !== undefined &&
            (metadata.requestedKinds.length === 0 ||
                new Set(metadata.requestedKinds).size !== metadata.requestedKinds.length))
    )
        return false
    const known = new Set(
        documentPrecomputeInputs({
            session: metadata.session,
            uiState: metadata.uiState,
            completedStepIds: metadata.completedStepIds,
            requestedKinds: metadata.requestedKinds,
        }).map((item) => item.key),
    )
    return metadata.want.every((key) => known.has(key)) && (metadata.focusKey === null || known.has(metadata.focusKey))
}

export function documentMatchesInputs(document: ScreenDocumentV2, inputs: ScreenContextInputsV2): boolean {
    try {
        return verifyDocumentAgainstInputsV2(document, inputs, sha256Hex, { legacyWaitCopy: true }).length === 0
    } catch {
        return false
    }
}

function statusCode(status: number): Code {
    if (status === 401 || status === 403) return 'unauthorized'
    if (status === 503) return 'unconfigured'
    if ([400, 413, 415].includes(status)) return 'invalid_input'
    if (status === 409) return 'duplicate_request'
    if (status === 429) return 'budget_exhausted'
    if (status === 504) return 'timeout'
    return status >= 500 ? 'provider_error' : 'invalid_output'
}
function retryableStatus(status: number): boolean {
    return status >= 500 && status !== 503
}

export function interpretDocuments(status: number, text: string, metadata: ModelScreensV2Metadata): ScreensV2Result {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return documentUnavailable(metadata.requestId, statusCode(status), retryableStatus(status))
    }
    const parsed = screensV2ResultSchema.safeParse(value)
    if (!parsed.success || parsed.data.requestId !== metadata.requestId)
        return documentUnavailable(
            metadata.requestId,
            status >= 200 && status < 300 ? 'invalid_output' : statusCode(status),
            retryableStatus(status),
        )
    const result = parsed.data
    if (result.status === 'unavailable') return result
    if (status !== 200) return documentUnavailable(metadata.requestId, 'invalid_output')
    const acceptsEvidence = (document: ScreenDocumentV2): boolean =>
        document.metadata.evidence === (result.mode === 'fixture' ? 'synthetic-fixture' : 'live')
    if (metadata.op === 'generate') {
        const { document, documents, progress } = result.value
        return document !== null &&
            documents.length === 0 &&
            progress === null &&
            acceptsEvidence(document) &&
            documentMatchesInputs(document, inputsFromDocumentMetadata(metadata))
            ? result
            : documentUnavailable(metadata.requestId, 'invalid_output')
    }
    if (metadata.session === null || result.value.document !== null)
        return documentUnavailable(metadata.requestId, 'invalid_output')
    const jobs = {
        session: metadata.session,
        uiState: metadata.uiState,
        completedStepIds: metadata.completedStepIds,
        requestedKinds: metadata.requestedKinds,
    }
    const expected = documentPrecomputeInputs(jobs)
    const known = new Map(expected.map((item) => [item.key, item.inputs]))
    const progress = result.value.progress
    if (
        progress !== null &&
        (progress.manualId !== metadata.session.manualId ||
            progress.revision !== metadata.session.revision ||
            progress.contextKey !== documentJobContextKey(jobs) ||
            progress.items.length !== (progress.mode === 'off' ? 0 : expected.length) ||
            new Set(progress.items.map((item) => item.key)).size !== progress.items.length ||
            progress.items.some(
                (item) =>
                    !known.has(item.key) ||
                    known.get(item.key)?.kind !== item.kind ||
                    known.get(item.key)?.stepId !== item.stepId,
            ))
    )
        return documentUnavailable(metadata.requestId, 'invalid_output')
    if (metadata.op !== 'progress')
        return result.value.documents.length === 0 ? result : documentUnavailable(metadata.requestId, 'invalid_output')
    const seen = new Set<string>()
    for (const document of result.value.documents) {
        const key = document.kind === 'guide' ? `guide:${document.bound.stepId}` : document.kind
        const inputs = known.get(key)
        const item = progress?.items.find((candidate) => candidate.key === key)
        if (
            seen.has(key) ||
            !metadata.want.includes(key) ||
            inputs === undefined ||
            item === undefined ||
            item.state !== (document.metadata.source === 'generated' ? 'ready' : 'fallback') ||
            item.screenId !== document.screenId ||
            !acceptsEvidence(document) ||
            !documentMatchesInputs(document, inputs)
        )
            return documentUnavailable(metadata.requestId, 'invalid_output')
        seen.add(key)
    }
    return result
}

/** Zero-file transport with the same origin, byte, absolute deadline, abort and redirect guards as the legacy client. */
export async function postDocuments(options: {
    metadata: ModelScreensV2Metadata
    ctx: ModelRequestContext
    baseUrl: string
    secret: string
    fetch: ModelFetch
}): Promise<ScreensV2Result> {
    const { ctx } = options
    let baseUrl: string
    try {
        baseUrl = parseBaseUrl(options.baseUrl)
    } catch {
        return documentUnavailable(ctx.requestId, 'invalid_input')
    }
    const parsed = modelScreensV2MetadataSchema.safeParse(options.metadata)
    if (!parsed.success || !validRequest(parsed.data, ctx.requestId))
        return documentUnavailable(ctx.requestId, 'invalid_input')
    const metadata = parsed.data
    const json = JSON.stringify(metadata)
    if (new TextEncoder().encode(json).length > MODEL_METADATA_MAX_BYTES || ctx.signal?.aborted)
        return documentUnavailable(ctx.requestId, 'invalid_input')
    const form = new FormData()
    form.append('metadata', json)
    const timeoutMs =
        metadata.op === 'generate'
            ? screenStageV2(metadata.kind!) === 'step-page'
                ? MODEL_STEP_PAGE_TIMEOUT_MS
                : 35_000
            : 10_000
    const guard = createCallGuard(timeoutMs, ctx.signal)
    let response: Response | undefined
    let outerExpired = false
    const checkpoint = (): void => {
        guard.checkpoint()
        try {
            ctx.checkpoint?.()
        } catch (error) {
            outerExpired = true
            throw error
        }
        guard.checkpoint()
    }
    try {
        checkpoint()
        response = await awaitStopped(
            options.fetch(new URL('/api/screens/v2?guideRepair=1', baseUrl).toString(), {
                method: 'POST',
                headers: { 'x-truebuild-key': options.secret, Accept: 'application/json' },
                body: form,
                credentials: 'omit',
                redirect: 'error',
                signal: guard.signal,
            }),
            guard.signal,
            discardResponse,
        )
        checkpoint()
        const body = await readBoundedText(response, guard.signal, checkpoint, DOCUMENT_RESPONSE_MAX_BYTES)
        checkpoint()
        const result = interpretDocuments(response.status, body, metadata)
        checkpoint()
        return result
    } catch (error) {
        if (ctx.signal?.aborted) return documentUnavailable(ctx.requestId, 'invalid_input')
        if (guard.timedOut() || outerExpired) return documentUnavailable(ctx.requestId, 'timeout', true)
        return documentUnavailable(
            ctx.requestId,
            error instanceof InvalidResponseError ? 'invalid_output' : 'provider_error',
            !(error instanceof InvalidResponseError),
        )
    } finally {
        if (response !== undefined) discardResponse(response)
        guard.dispose()
    }
}
