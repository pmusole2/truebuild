import { MAX_PARSE_PAGES } from '@truebuild/contracts/model'

/**
 * Parse time budget, in one place so the route, the provider and `/api/session` cannot disagree. These are application
 * budgets, not measured provider bounds: the overall budget covers one first attempt plus at most one repair, and the
 * route allows a small margin on top of it before it answers.
 */
export const PARSE_DEFAULT_OVERALL_MS = 345_000 // Maximum first attempt plus one 40 s repair and response overhead.
export const PARSE_FIRST_ATTEMPT_BASE_MS = 120_000 // Created within 15 s; reasoning silence is allowed, then visible-output idle is 30 s.
export const PARSE_FIRST_ATTEMPT_PAGE_MS = 25_000
export const PARSE_FIRST_ATTEMPT_MAX_MS = 300_000
export const PARSE_REPAIR_MS = 40_000
export const PARSE_MIN_REPAIR_MS = 20_000 // User-selected repair floor after the user-paid 31–35 s parse baseline.
export const PARSE_RETURN_MARGIN_MS = 1_000
/** Route allowance beyond the overall budget (admission, multipart, media, response); also the client's minimum margin. */
export const PARSE_ROUTE_MARGIN_MS = 5_000

/** Explicit overall overrides remain hard ceilings; short overrides may admit repair only after an early reply. */
export function parseFirstAttemptTimeoutMs(pageCount: number, overallMs = PARSE_DEFAULT_OVERALL_MS): number {
    const pageBudgetMs = Math.min(
        PARSE_FIRST_ATTEMPT_MAX_MS,
        PARSE_FIRST_ATTEMPT_BASE_MS +
            Math.max(0, Math.min(MAX_PARSE_PAGES, pageCount) - 3) * PARSE_FIRST_ATTEMPT_PAGE_MS,
    )
    return Math.min(pageBudgetMs, Math.max(1_000, overallMs - PARSE_RETURN_MARGIN_MS))
}

/** The layered parse budgets actually executed for a configured overall budget. */
export function describeParseBudget(overallMs: number): Record<string, number> {
    return {
        overallMs,
        routeMs: overallMs + PARSE_ROUTE_MARGIN_MS,
        firstAttemptMinMs: parseFirstAttemptTimeoutMs(1, overallMs),
        firstAttemptMaxMs: parseFirstAttemptTimeoutMs(Number.MAX_SAFE_INTEGER, overallMs),
        repairMs: PARSE_REPAIR_MS,
        minimumRepairMs: PARSE_MIN_REPAIR_MS,
        clientMinimumMs: overallMs + PARSE_ROUTE_MARGIN_MS,
    }
}
