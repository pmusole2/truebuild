import type { ApiResult, CheckResult } from '@truebuild/contracts'
import { BoundedApiClient } from '../../api/client'
import type { RunCheck } from './check-state'

// Local fixture API started with the api workspace (see api/package.json dev script).
export const API_BASE_URL = 'http://127.0.0.1:3001'

// Forwards the caller's requestId and AbortSignal unchanged. The client owns validation of the echoed
// binding, requestId, mode and value schema; the reducer re-checks the result before publishing it.
export const runCheck: RunCheck = (request, signal): Promise<ApiResult<CheckResult>> => {
    const client = new BoundedApiClient({ baseUrl: API_BASE_URL, mode: request.mode })
    return client.check(request.binding, request.scenario, { requestId: request.requestId, signal })
}
