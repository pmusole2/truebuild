export const DEFAULT_ORIGINS = ['http://localhost:8081', 'http://127.0.0.1:8081'] as const

export function isAllowedOrigin(request: Request, origins: readonly string[] = DEFAULT_ORIGINS): boolean {
    const origin = request.headers.get('origin')

    return origin === null || origins.includes(origin)
}

export function corsResponse(
    request: Request,
    response: Response,
    origins: readonly string[] = DEFAULT_ORIGINS,
): Response {
    const vary = (response.headers.get('vary') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    if (!vary.some((value) => ['origin', '*'].includes(value.toLowerCase()))) {
        response.headers.set('vary', [...vary, 'Origin'].join(', '))
    }
    const origin = request.headers.get('origin')
    if (origin !== null && origins.includes(origin)) {
        response.headers.set('access-control-allow-origin', origin)
    }

    return response
}

export function deniedOrigin(status = 403): Response {
    return Response.json(
        { status: 'unavailable', requestId: 'invalid-request', binding: null, code: 'unauthorized', retryable: false },
        { status, headers: { 'cache-control': 'no-store', vary: 'Origin' } },
    )
}

export function preflight(
    request: Request,
    method: 'POST' | 'GET' = 'POST',
    origins: readonly string[] = DEFAULT_ORIGINS,
): Response {
    const requestedMethod = request.headers.get('access-control-request-method')
    const requestedHeaders = request.headers.get('access-control-request-headers')
    const allowedHeaders =
        requestedHeaders === null ||
        requestedHeaders
            .split(',')
            .every((header) => ['content-type', 'x-truebuild-key'].includes(header.trim().toLowerCase()))

    if (
        !isAllowedOrigin(request, origins) ||
        (requestedMethod !== null && requestedMethod !== method) ||
        !allowedHeaders
    ) {
        return deniedOrigin(401)
    }

    return corsResponse(
        request,
        new Response(null, {
            status: 204,
            headers: {
                'access-control-allow-methods': `${method}, OPTIONS`,
                'access-control-allow-headers': 'Content-Type, X-TrueBuild-Key',
                'cache-control': 'no-store',
            },
        }),
        origins,
    )
}
