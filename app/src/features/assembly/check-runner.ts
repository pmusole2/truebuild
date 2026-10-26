import type { ApiResult, CheckResult } from '@truebuild/contracts'
import { BoundedApiClient } from '../../api/client'
import type { RunCheck } from './check-state'
import { API_BASE_URL, API_SECRET } from '../../config'

// Forwards the caller's requestId and AbortSignal unchanged. The client owns validation of the echoed
// binding, requestId, mode and value schema; the reducer re-checks the result before publishing it.
export const runCheck: RunCheck = (request, signal): Promise<ApiResult<CheckResult>> => {
    const client = new BoundedApiClient({ baseUrl: API_BASE_URL, mode: request.mode, secret: API_SECRET })
    return client.check(request.binding, request.scenario, { requestId: request.requestId, signal })
}
