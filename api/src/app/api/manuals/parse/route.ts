import { fixtureHandlers } from '../../../../server/routes'
import { dispatchModelRoute, modelOptions } from '../../../../server/model-runtime'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
    return request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')
        ? dispatchModelRoute('parse', request)
        : fixtureHandlers.parse(request)
}

export const OPTIONS = modelOptions
