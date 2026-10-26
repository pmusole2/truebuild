const ALLOWED_ORIGINS = new Set(['http://localhost:8081', 'http://127.0.0.1:8081'])

export function isAllowedOrigin(request: Request): boolean {
    const origin = request.headers.get('origin')

    return origin === null || ALLOWED_ORIGINS.has(origin)
}

export function corsResponse(request: Request, response: Response): Response {
    response.headers.set('vary', 'Origin')

    const origin = request.headers.get('origin')

    if (origin !== null && ALLOWED_ORIGINS.has(origin)) {
        response.headers.set('access-control-allow-origin', origin)
    }

    return response
}

export function deniedOrigin(): Response {
    return Response.json(
        {
            status: 'unavailable',
            requestId: 'invalid-request',
            binding: null,
            code: 'unauthorized',
            retryable: false,
        },
        { status: 403, headers: { 'cache-control': 'no-store', vary: 'Origin' } },
    )
}

export function preflight(request: Request, method: 'POST' | 'GET' = 'POST'): Response {
    const requestedMethod = request.headers.get('access-control-request-method')
    const requestedHeaders = request.headers.get('access-control-request-headers')
    const allowedHeaders =
        requestedHeaders === null ||
        requestedHeaders.split(',').every((header) => header.trim().toLowerCase() === 'content-type')

    if (!isAllowedOrigin(request) || (requestedMethod !== null && requestedMethod !== method) || !allowedHeaders) {
        return deniedOrigin()
    }

    return corsResponse(
        request,
        new Response(null, {
            status: 204,
            headers: {
                'access-control-allow-methods': `${method}, OPTIONS`,
                'access-control-allow-headers': 'Content-Type',
                'cache-control': 'no-store',
            },
        }),
    )
}
