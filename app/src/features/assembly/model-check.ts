import type { ApiResult, CaptureBinding, CheckResult, ManualSession, ManualStep } from '@truebuild/contracts'
import type { ImageBytes, ModelApiClient } from '../../api/model-client'
import type { QuestionTarget, QuestionResult } from '@truebuild/contracts'
import { MODEL_CHECK_TIMEOUT_MS } from '../../api/model-client'
import { awaitStopped, unavailableResult, type CallGuard } from '../../api/transport'
import { beforeDispatch, type PrepStopReason } from './prep-budget'
import type { StoredPageAsset } from '../../storage/manual-store.types'
import type { Observation } from './observation'

/** Every page a reviewed step cites, including the registry names of the parts it uses. Sorted and unique. */
export function citedPageIds(session: ManualSession, step: ManualStep): string[] {
    const factRefs = (fact: {
        state: string
        sourceRefs?: readonly { pageId: string }[]
    }): readonly { pageId: string }[] =>
        fact.state === 'known' && fact.sourceRefs !== undefined ? fact.sourceRefs : []
    const partIds = new Set([
        ...step.parts.map((part) => part.partId),
        ...(step.orientation.state === 'known' ? [step.orientation.value.partId] : []),
        ...(step.connection.state === 'known' ? step.connection.value.partIds : []),
    ])
    const refs = [
        ...step.sourceRefs,
        ...step.parts.flatMap((part) => factRefs(part.quantity)),
        ...factRefs(step.orientation),
        ...factRefs(step.connection),
        ...step.visibleChecks.flatMap((check) => factRefs(check.description)),
        ...(step.correction?.actions.flatMap((action) => action.sourceRefs) ?? []),
        ...session.parts.filter((part) => partIds.has(part.partId)).flatMap((part) => factRefs(part.name)),
    ]
    return [...new Set(refs.map((ref) => ref.pageId))].sort()
}

export type ModelCheckRequest = {
    readonly client: ModelApiClient
    readonly requestId: string
    readonly binding: CaptureBinding
    readonly session: ManualSession
    readonly step: ManualStep
    readonly observation: Observation
    readonly loadPageAsset: (assetId: string) => Promise<StoredPageAsset | null>
    readonly signal: AbortSignal
}

/** The frozen photo as the wire type. Same bytes and geometry; no re-encoding happens here. */
export function observationImage(observation: Observation): ImageBytes {
    return {
        bytes: observation.bytes,
        mimeType: observation.mimeType,
        width: observation.width,
        height: observation.height,
    }
}

export type ModelQuestionRequest = Omit<ModelCheckRequest, 'loadPageAsset'> & {
    readonly question: string
    readonly target: QuestionTarget
    readonly loadPageAsset: ModelCheckRequest['loadPageAsset']
}

/** Grounded question about the current step, answered from its cited pages and the frozen photo only. */
export async function askModelQuestion(request: ModelQuestionRequest): Promise<ApiResult<QuestionResult>> {
    const { requestId, binding } = request
    const outcome = await beforeDispatch(
        request.signal,
        MODEL_CHECK_TIMEOUT_MS,
        async (guard): Promise<ApiResult<QuestionResult>> => {
            const pageIds = citedPageIds(request.session, request.step)
            guard.checkpoint()

            if (pageIds.length === 0 || pageIds.length > 2) {
                return unavailableResult<QuestionResult>(requestId, binding, 'invalid_input', false)
            }

            const sources = await loadCitedSources(request.session, pageIds, request.loadPageAsset, guard)
            guard.checkpoint()

            if (sources === null) {
                return unavailableResult<QuestionResult>(requestId, binding, 'invalid_input', false)
            }

            const result = await awaitStopped(
                request.client.questions(
                    binding,
                    request.session,
                    pageIds,
                    sources,
                    observationImage(request.observation),
                    request.question,
                    request.target,
                    { requestId, signal: guard.signal, checkpoint: guard.checkpoint },
                ),
                guard.signal,
            )
            guard.checkpoint()

            return result
        },
    )

    return outcome.ok ? outcome.value : stoppedResult<QuestionResult>(requestId, binding, outcome.reason)
}

export type RunModelCheck = (request: ModelCheckRequest) => Promise<ApiResult<CheckResult>>

/** Loads the stored originals for the cited pages. Any missing page means the check cannot be sent: no partial set. */
export async function loadCitedSources(
    session: ManualSession,
    pageIds: readonly string[],
    loadPageAsset: ModelCheckRequest['loadPageAsset'],
    guard?: CallGuard,
): Promise<ImageBytes[] | null> {
    const sources: ImageBytes[] = []
    for (const pageId of pageIds) {
        guard?.checkpoint()
        const page = session.pages.find((candidate) => candidate.pageId === pageId)
        if (page === undefined) {
            return null
        }
        const pending = loadPageAsset(page.assetId)
        const asset = guard === undefined ? await pending : await awaitStopped(pending, guard.signal)
        guard?.checkpoint()
        if (asset === null || asset.assetId !== page.assetId || asset.mimeType !== page.mimeType) {
            return null
        }
        sources.push({ bytes: asset.bytes, mimeType: page.mimeType, width: page.width, height: page.height })
    }
    return sources
}

/**
 * Current-step model check. Sources are the step's own cited pages; the observation is the frozen photo for this
 * capture. The client validates the whole request before any I/O, so an out-of-policy step is never dispatched.
 */
export const runModelCheck: RunModelCheck = async (request): Promise<ApiResult<CheckResult>> => {
    const { requestId, binding } = request
    const outcome = await beforeDispatch(
        request.signal,
        MODEL_CHECK_TIMEOUT_MS,
        async (guard): Promise<ApiResult<CheckResult>> => {
            const pageIds = citedPageIds(request.session, request.step)
            guard.checkpoint()

            if (pageIds.length === 0 || pageIds.length > 2) {
                return unavailableResult<CheckResult>(requestId, binding, 'invalid_input', false)
            }

            const sources = await loadCitedSources(request.session, pageIds, request.loadPageAsset, guard)
            guard.checkpoint()

            if (sources === null) {
                return unavailableResult<CheckResult>(requestId, binding, 'invalid_input', false)
            }

            const result = await awaitStopped(
                request.client.check(
                    binding,
                    request.session,
                    pageIds,
                    sources,
                    observationImage(request.observation),
                    { requestId, signal: guard.signal, checkpoint: guard.checkpoint },
                ),
                guard.signal,
            )
            guard.checkpoint()

            return result
        },
    )

    return outcome.ok ? outcome.value : stoppedResult<CheckResult>(requestId, binding, outcome.reason)
}

/** Maps an action stop to the existing wire union; an ambiguous dispatched operation is never retried here. */
export function stoppedResult<T>(requestId: string, binding: CaptureBinding, reason: PrepStopReason): ApiResult<T> {
    return reason === 'timeout'
        ? unavailableResult<T>(requestId, binding, 'timeout', true)
        : unavailableResult<T>(requestId, binding, 'invalid_input', false)
}
