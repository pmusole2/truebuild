import { DEMO_LABEL } from '../../../providers/types'
import { corsResponse, deniedOrigin, isAllowedOrigin, preflight } from '../../../server/cors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request?: Request): Response {
    if (request && !isAllowedOrigin(request)) {
        return deniedOrigin()
    }

    const response = Response.json(
        {
            status: 'ok',
            fixture: 'available',
            live: 'unconfigured',
            label: DEMO_LABEL,
        },
        { headers: { 'cache-control': 'no-store' } },
    )

    return request ? corsResponse(request, response) : response
}

export function OPTIONS(request: Request): Response {
    return preflight(request, 'GET')
}
