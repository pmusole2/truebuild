/**
 * Parse time budget, in one place so the route, the provider and `/api/session` cannot disagree. These are application
 * budgets, not measured provider bounds: the overall budget covers one first attempt plus at most one repair, and the
 * route allows a small margin on top of it before it answers.
 */
export const PARSE_DEFAULT_OVERALL_MS = 100_000
export const PARSE_FIRST_ATTEMPT_BASE_MS = 55_000
export const PARSE_FIRST_ATTEMPT_PER_EXTRA_PAGE_MS = 10_000
export const PARSE_FIRST_ATTEMPT_MAX_MS = 95_000
export const PARSE_BASE_PAGES = 4
export const PARSE_REPAIR_MS = 40_000
export const PARSE_RETURN_MARGIN_MS = 1_000
/** Route allowance beyond the overall budget (admission, multipart, media, response); also the client's minimum margin. */
export const PARSE_ROUTE_MARGIN_MS = 5_000

/** 55 s through four pages, then 10 s per page, capped at 95 s and at what the overall budget leaves for a return. */
export function parseFirstAttemptTimeoutMs(pageCount: number, overallMs = PARSE_DEFAULT_OVERALL_MS): number {
    return Math.min(
        PARSE_FIRST_ATTEMPT_MAX_MS,
        PARSE_FIRST_ATTEMPT_BASE_MS + Math.max(0, pageCount - PARSE_BASE_PAGES) * PARSE_FIRST_ATTEMPT_PER_EXTRA_PAGE_MS,
        Math.max(1_000, overallMs - PARSE_RETURN_MARGIN_MS),
    )
}

/** The layered parse budgets actually executed for a configured overall budget. */
export function describeParseBudget(overallMs: number): Record<string, number> {
    return {
        overallMs,
        routeMs: overallMs + PARSE_ROUTE_MARGIN_MS,
        firstAttemptMinMs: parseFirstAttemptTimeoutMs(1, overallMs),
        firstAttemptMaxMs: parseFirstAttemptTimeoutMs(Number.MAX_SAFE_INTEGER, overallMs),
        repairMs: PARSE_REPAIR_MS,
        clientMinimumMs: overallMs + PARSE_ROUTE_MARGIN_MS,
    }
}
