import { selectedStepSourcePageIds } from './source-selection'
import type {
    ApiResult,
    CaptureBinding,
    CheckResult,
    ManualPage,
    ManualSession,
    ManualStep,
    QuestionResult,
    QuestionTarget,
} from '@truebuild/contracts'
import type { PendingResult, ScreenContext } from '@truebuild/contracts/model'
import type { ImageBytes, ModelApiClient } from '../../api/model-client'
import { MODEL_CHECK_TIMEOUT_MS, MODEL_QUESTION_FIRST_TIMEOUT_MS } from '../../api/model-client'
import { awaitStopped, createCallGuard, unavailableResult, type CallGuard } from '../../api/transport'
import { beforeDispatch, type PrepStopReason } from './prep-budget'
import type { Observation } from './observation'

/** A page original held in memory for the current session, as the model check needs it. */
export type SourcePageAsset = {
    readonly assetId: string
    readonly mimeType: ManualPage['mimeType']
    readonly bytes: Uint8Array
}

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
    readonly client: Pick<ModelApiClient, 'check' | 'questions'>
    readonly requestId: string
    readonly binding: CaptureBinding
    readonly session: ManualSession
    readonly step: ManualStep
    readonly observation: Observation
    readonly loadPageAsset: (assetId: string) => Promise<SourcePageAsset | null>
    readonly signal: AbortSignal
    /** The shown, validated guide page's identity (see ModelRequestContext.screen). */
    readonly screen?: ScreenContext
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

/** A question may wait up to the server's own job budget (60 s by default) plus this margin before the app gives up. */
export const QUESTION_JOB_MARGIN_MS = 5_000
export const QUESTION_JOB_CEILING_MS = 75_000
// Preparing the cited pages is still bounded like a check; the first request then gets its own, longer budget.
const QUESTION_PREP_MS = MODEL_CHECK_TIMEOUT_MS
const QUESTION_FIRST_ACTION_MS = QUESTION_PREP_MS + MODEL_QUESTION_FIRST_TIMEOUT_MS
const POLL_MIN_MS = 500
const POLL_MAX_MS = 3_000

export type ModelQuestionRequest = Omit<ModelCheckRequest, 'loadPageAsset' | 'client'> & {
    readonly client: Pick<ModelApiClient, 'check' | 'questions'> &
        Partial<Pick<ModelApiClient, 'questionResult' | 'questionCancel'>>
    /** Called once when the server hands back a ticket instead of an answer, so the screen can say it is still working. */
    readonly onSlow?: () => void
    readonly question: string
    readonly target: QuestionTarget
    readonly loadPageAsset: ModelCheckRequest['loadPageAsset']
}

/** Grounded question about the current step, with the reviewed plan, ordered manual pages, and frozen photo. */
export async function askModelQuestion(request: ModelQuestionRequest): Promise<ApiResult<QuestionResult>> {
    const { requestId, binding } = request
    const outcome = await beforeDispatch(
        request.signal,
        QUESTION_FIRST_ACTION_MS,
        async (guard): Promise<ApiResult<QuestionResult> | PendingResult> => {
            const pageIds = selectedStepSourcePageIds(request.session, request.step)
            guard.checkpoint()

            if (pageIds.length === 0 || pageIds.length > 20) {
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
                    {
                        requestId,
                        signal: guard.signal,
                        checkpoint: guard.checkpoint,
                        ...(request.screen === undefined ? {} : { screen: request.screen }),
                    },
                ),
                guard.signal,
            )
            guard.checkpoint()

            return result
        },
    )

    if (!outcome.ok) {
        return stoppedResult<QuestionResult>(requestId, binding, outcome.reason)
    }
    if (outcome.value.status !== 'pending') {
        return outcome.value
    }
    request.onSlow?.()
    return collectQuestion(request, outcome.value)
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject): void => {
        if (signal.aborted) {
            reject(new Error('Request stopped'))
            return
        }
        const onAbort = (): void => {
            clearTimeout(timer)
            reject(new Error('Request stopped'))
        }
        const timer = setTimeout((): void => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, milliseconds)
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * Follows a 202 ticket to its final response. The question and its photo are never sent again; the only requests are
 * reads of this one ticket. A caller stop or the ticket's own horizon stops the job on the server and reports it as
 * stopped, so a late answer can never appear after the person moved on.
 */
async function collectQuestion(
    request: ModelQuestionRequest,
    first: PendingResult,
): Promise<ApiResult<QuestionResult>> {
    const { requestId, binding, client } = request
    if (client.questionResult === undefined) {
        return unavailableResult<QuestionResult>(requestId, binding, 'invalid_output', false)
    }
    const pageIds = selectedStepSourcePageIds(request.session, request.step)
    const guard = createCallGuard(
        Math.min(first.expiresInMs + QUESTION_JOB_MARGIN_MS, QUESTION_JOB_CEILING_MS),
        request.signal,
    )
    let ticket = first
    try {
        for (;;) {
            await pause(Math.min(Math.max(ticket.retryAfterMs, POLL_MIN_MS), POLL_MAX_MS), guard.signal)
            guard.checkpoint()
            const next = await awaitStopped(
                client.questionResult(
                    binding,
                    first.ticket,
                    { requestId, signal: guard.signal, checkpoint: guard.checkpoint },
                    pageIds,
                ),
                guard.signal,
            )
            guard.checkpoint()
            if (next.status !== 'pending') {
                return next
            }
            ticket = next
        }
    } catch {
        const reason: PrepStopReason = guard.callerAborted() ? 'caller' : 'timeout'
        // Fire and forget: the job is stopped so nothing keeps working for an answer nobody will see.
        void client.questionCancel?.(binding, first.ticket, { requestId })
        return stoppedResult<QuestionResult>(requestId, binding, reason)
    } finally {
        guard.dispose()
    }
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
 * Current-step model check. Full context uses all ordered manual pages; server compact policy may narrow them.
 * The observation is the frozen photo for this capture. The client validates the whole request before any I/O.
 */
export const runModelCheck: RunModelCheck = async (request): Promise<ApiResult<CheckResult>> => {
    const { requestId, binding } = request
    const outcome = await beforeDispatch(
        request.signal,
        MODEL_CHECK_TIMEOUT_MS,
        async (guard): Promise<ApiResult<CheckResult>> => {
            const pageIds = selectedStepSourcePageIds(request.session, request.step)
            guard.checkpoint()

            if (pageIds.length === 0 || pageIds.length > 20) {
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
