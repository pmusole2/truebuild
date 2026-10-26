import { createMetaProvider } from '../providers/meta-provider'
import { createSamProvider } from '../providers/sam'
import { OwnerSessionManager, requireOwnerSession } from './auth'
import { protectedDirectory, RunLedger } from './budget'
import { corsResponse } from './cors'
import { createModelHandlers, guardModelFetch, modelOptions, unconfiguredModelResponse } from './model-service'

export interface ModelRuntime {
    manager: OwnerSessionManager
    ledger: RunLedger
    handlers: ReturnType<typeof createModelHandlers>
    configured: boolean
}

export async function createModelRuntime(config: {
    enabled: boolean
    ownerAction: string
    privateDirectory: string
    apiKey?: string
    fetchImpl?: typeof fetch
}): Promise<ModelRuntime | null> {
    if (!config.enabled || config.ownerAction !== 'resume') {
        return null
    }
    try {
        await protectedDirectory(config.privateDirectory)
        const ledger = new RunLedger({ privateDirectory: config.privateDirectory })
        await ledger.load()
        const manager = new OwnerSessionManager({ privateDirectory: config.privateDirectory, ledger })
        // A server boot can rotate authentication, never replenish a persisted budget.
        await manager.createSession({ newRun: false })
        const configured = Boolean(config.apiKey?.trim())
        const fetchImpl = guardModelFetch(config.fetchImpl)
        const handlers = createModelHandlers({
            manager,
            ledger,
            provider: configured ? createMetaProvider({ apiKey: config.apiKey, fetchImpl }) : null,
            samProvider: configured ? createSamProvider({ apiKey: config.apiKey, fetchImpl }) : null,
        })
        return { manager, ledger, handlers, configured }
    } catch {
        throw new Error('model_runtime_unavailable')
    }
}

declare global {
    var __truebuildModelRuntimeV1: Promise<ModelRuntime | null> | undefined
}

/** Called only by Node instrumentation under explicit trusted operator flags. */
export function initializeModelRuntimeFromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ModelRuntime | null> {
    if (globalThis.__truebuildModelRuntimeV1) {
        return globalThis.__truebuildModelRuntimeV1
    }
    if (environment.TRUEBUILD_ENABLE_MODELS !== '1' || environment.TRUEBUILD_OWNER_ACTION !== 'resume') {
        globalThis.__truebuildModelRuntimeV1 = Promise.resolve(null)
    } else {
        globalThis.__truebuildModelRuntimeV1 = createModelRuntime({
            enabled: true,
            ownerAction: 'resume',
            privateDirectory: environment.TRUEBUILD_PRIVATE_DIRECTORY ?? '',
            apiKey: environment.MODEL_API_KEY,
        })
    }
    return globalThis.__truebuildModelRuntimeV1
}

export function getModelRuntime(): Promise<ModelRuntime | null> {
    return globalThis.__truebuildModelRuntimeV1 ?? Promise.resolve(null)
}

export async function dispatchModelRoute(
    operation: 'parse' | 'check' | 'question' | 'segment',
    request: Request,
): Promise<Response> {
    let runtime: ModelRuntime | null
    try {
        runtime = await getModelRuntime()
    } catch {
        return unconfiguredModelResponse(request)
    }
    return runtime ? runtime.handlers[operation](request) : unconfiguredModelResponse(request)
}

export async function modelSessionResponse(request: Request): Promise<Response> {
    let runtime: ModelRuntime | null
    try {
        runtime = await getModelRuntime()
    } catch {
        return unconfiguredModelResponse(request)
    }
    if (!runtime) {
        return unconfiguredModelResponse(request)
    }
    try {
        const session = requireOwnerSession(request, runtime.manager)
        const response = Response.json(
            {
                status: 'ok',
                runId: session.runId,
                expiresAt: session.expiresAt,
                model: runtime.configured ? 'configured' : 'unconfigured',
            },
            { headers: { 'cache-control': 'no-store' } },
        )
        requireOwnerSession(request, runtime.manager)
        return corsResponse(request, response)
    } catch {
        return corsResponse(
            request,
            Response.json(
                { status: 'unavailable', code: 'unauthorized' },
                {
                    status: 401,
                    headers: { 'cache-control': 'no-store' },
                },
            ),
        )
    }
}

export { modelOptions }
