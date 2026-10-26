import { createFixtureProvider } from '../providers/fixture'
import { createApiHandlers } from './handlers'
import { preflight } from './cors'

export const fixtureHandlers = createApiHandlers(createFixtureProvider())

export function fixtureOptions(request: Request): Response {
    return preflight(request)
}
