import { SCREEN_CATALOG_V2_VERSION, SCREEN_DOCUMENT_V2_VERSION } from '@truebuild/contracts'
import { Hono, type Context } from 'hono'

import { DEMO_LABEL } from './providers/types'
import { corsResponse, deniedOrigin, isAllowedOrigin, preflight } from './server/cors'
import { createRuntimeFromEnvironment, describeAiPolicy, type ApiRuntime } from './server/model-runtime'
import { PUBLIC_LIMIT_MESSAGE, PublicLimitError } from './server/public-limits'

type ApiEnv = { Variables: { runtime: ApiRuntime } }
type Operation = 'parse' | 'check' | 'question' | 'segment'
const methods = new Map<string, 'GET' | 'POST'>([
    ['/health', 'GET'],
    ['/api/health', 'GET'],
    ['/api/session', 'GET'],
    ['/api/manuals/parse', 'POST'],
    ['/api/pieces', 'POST'],
    ['/api/checks', 'POST'],
    ['/api/checks/second-opinion', 'POST'],
    ['/api/checks/overlay', 'POST'],
    ['/api/checks/overlay/result', 'POST'],
    ['/api/checks/overlay/cancel', 'POST'],
    ['/api/questions', 'POST'],
    ['/api/questions/result', 'POST'],
    ['/api/questions/cancel', 'POST'],
    ['/api/screens', 'POST'],
    ['/api/screens/v2', 'POST'],
    ['/api/segments', 'POST'],
])

function health(context: Context<ApiEnv>): Response {
    const runtime = context.get('runtime')
    return context.json({
        status: 'ok',
        fixture: runtime.mode === 'fixture' ? 'available' : 'disabled',
        live: runtime.configured ? 'configured' : 'unconfigured',
        label: runtime.mode === 'fixture' ? DEMO_LABEL : 'Meta model mode',
    })
}

function dispatch(context: Context<ApiEnv>, operation: Operation): Promise<Response> {
    const runtime = context.get('runtime')
    const request = context.req.raw
    return runtime.mode === 'meta' ||
        request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')
        ? runtime.model[operation](request)
        : runtime.fixture[operation](request)
}

const routes = new Hono<ApiEnv>()
    .get('/health', health)
    .get('/api/health', health)
    .get('/api/session', (context): Response =>
        context.json({
            status: 'ok',
            ...context.get('runtime').sessionMetadata,
            providerMode: context.get('runtime').mode,
            sparkModel: context.get('runtime').sparkModel,
            parseModel: context.get('runtime').parseModel,
            secondOpinionModel: context.get('runtime').secondOpinionModel,
            aiPolicy: describeAiPolicy(context.get('runtime').policy),
            followUps: { overlay: context.get('runtime').overlay, segments: context.get('runtime').segments },
            // Secret-free: the whole-screen document version this server speaks and where, never a key or a model detail.
            screensV2: {
                documentVersion: SCREEN_DOCUMENT_V2_VERSION,
                catalogVersion: SCREEN_CATALOG_V2_VERSION,
                route: '/api/screens/v2',
            },
            samModel: context.get('runtime').samModel,
            checkContext: context.get('runtime').checkContext,
            model: context.get('runtime').configured ? 'configured' : 'unconfigured',
        }),
    )
    .post('/api/pieces', (context): Promise<Response> => context.get('runtime').model.pieces(context.req.raw))
    .post('/api/manuals/parse', (context): Promise<Response> => dispatch(context, 'parse'))
    .post('/api/checks/second-opinion', (context): Promise<Response> =>
        context.get('runtime').model.secondOpinion(context.req.raw),
    )
    .post('/api/checks/overlay', (context): Promise<Response> => context.get('runtime').model.overlay(context.req.raw))
    .post('/api/checks/overlay/result', (context): Promise<Response> =>
        context.get('runtime').model.overlayResult(context.req.raw),
    )
    .post('/api/checks/overlay/cancel', (context): Promise<Response> =>
        context.get('runtime').model.overlayCancel(context.req.raw),
    )
    .post('/api/screens', (context): Promise<Response> => context.get('runtime').model.screens(context.req.raw))
    .post('/api/screens/v2', (context): Promise<Response> => context.get('runtime').model.screensV2(context.req.raw))
    .post('/api/questions/result', (context): Promise<Response> =>
        context.get('runtime').model.questionResult(context.req.raw),
    )
    .post('/api/questions/cancel', (context): Promise<Response> =>
        context.get('runtime').model.questionCancel(context.req.raw),
    )
    .post('/api/checks', (context): Promise<Response> => dispatch(context, 'check'))
    .post('/api/questions', (context): Promise<Response> => dispatch(context, 'question'))
    .post('/api/segments', (context): Promise<Response> => dispatch(context, 'segment'))

/** Import with `import type` in future hono/client consumers. It does not start a server. */
export type AppType = typeof routes

export function createApp(
    options: {
        runtime?: ApiRuntime
        onDuration?: (milliseconds: number) => void
    } = {},
): AppType {
    const runtime = options.runtime ?? createRuntimeFromEnvironment()
    const onDuration =
        options.onDuration ?? ((milliseconds: number): void => console.info(`duration_ms=${milliseconds.toFixed(1)}`))
    const app = new Hono<ApiEnv>()
    app.use('*', async (context, next): Promise<Response | void> => {
        const started = performance.now()
        const request = context.req.raw
        context.set('runtime', runtime)
        const sessionFailure = (): Response =>
            corsResponse(
                request,
                Response.json(
                    { status: 'unavailable', code: 'unauthorized' },
                    { status: 401, headers: { 'cache-control': 'no-store' } },
                ),
                runtime.allowedOrigins,
            )
        try {
            if (!isAllowedOrigin(request, runtime.allowedOrigins)) {
                await request.body?.cancel().catch((): void => {})
                if (request.method === 'OPTIONS') {
                    return deniedOrigin(401)
                }
                return context.req.path === '/api/session' ? sessionFailure() : deniedOrigin()
            }
            const method = methods.get(context.req.path)
            if (method && request.method === 'OPTIONS') {
                return preflight(request, method, runtime.allowedOrigins)
            }
            if (method && !['/health', '/api/health'].includes(context.req.path)) {
                try {
                    runtime.auth.authenticate(request)
                } catch {
                    await request.body?.cancel().catch((): void => {})
                    return context.req.path === '/api/session'
                        ? sessionFailure()
                        : corsResponse(request, deniedOrigin(401), runtime.allowedOrigins)
                }
            }
            // Collection/cancellation spends no model calls and must remain available after a ceiling is reached.
            const generates =
                method === 'POST' && !context.req.path.endsWith('/result') && !context.req.path.endsWith('/cancel')
            try {
                if (generates)
                    await runtime.counter.runForClient(request, context.req.path === '/api/manuals/parse', next)
                else await next()
            } catch (error) {
                if (!(error instanceof PublicLimitError)) throw error
                await request.body?.cancel().catch((): void => {})
                return corsResponse(
                    request,
                    Response.json(
                        {
                            status: 'unavailable',
                            requestId: 'invalid-request',
                            binding: null,
                            code: 'budget_exhausted',
                            retryable: false,
                            message: PUBLIC_LIMIT_MESSAGE,
                        },
                        { status: 429, headers: { 'cache-control': 'no-store' } },
                    ),
                    runtime.allowedOrigins,
                )
            }
            context.res.headers.set('cache-control', 'no-store')
            corsResponse(request, context.res, runtime.allowedOrigins)
        } finally {
            onDuration(Math.max(0, performance.now() - started))
        }
    })
    app.onError((_error, context): Response =>
        context.json(
            {
                status: 'unavailable',
                requestId: 'invalid-request',
                binding: null,
                code: 'provider_error',
                retryable: false,
            },
            500,
        ),
    )
    app.notFound((context): Response => {
        const method = methods.get(context.req.path)
        if (method) {
            context.header('Allow', `${method}, ${method === 'GET' ? 'HEAD, ' : ''}OPTIONS`)
            return context.body(null, 405)
        }
        return context.text('Not Found', 404)
    })
    return app.route('/', routes)
}
