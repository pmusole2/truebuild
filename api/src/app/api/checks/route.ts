import { fixtureHandlers } from '../../../server/routes'
import { dispatchModelRoute, modelOptions } from '../../../server/model-runtime'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
    return request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')
        ? dispatchModelRoute('check', request)
        : fixtureHandlers.check(request)
}

export const OPTIONS = modelOptions
