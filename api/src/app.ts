import { Hono, type Context } from 'hono'

import { DEMO_LABEL } from './providers/types'
import { corsResponse, deniedOrigin, isAllowedOrigin, preflight } from './server/cors'
import { createRuntimeFromEnvironment, type ApiRuntime } from './server/model-runtime'

type ApiEnv = { Variables: { runtime: ApiRuntime } }
type Operation = 'parse' | 'check' | 'question' | 'segment'
const methods = new Map<string, 'GET' | 'POST'>([
    ['/health', 'GET'],
    ['/api/health', 'GET'],
    ['/api/session', 'GET'],
    ['/api/manuals/parse', 'POST'],
    ['/api/checks', 'POST'],
    ['/api/questions', 'POST'],
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
            samModel: context.get('runtime').samModel,
            checkContext: context.get('runtime').checkContext,
            model: context.get('runtime').configured ? 'configured' : 'unconfigured',
        }),
    )
    .post('/api/manuals/parse', (context): Promise<Response> => dispatch(context, 'parse'))
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
            await next()
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
