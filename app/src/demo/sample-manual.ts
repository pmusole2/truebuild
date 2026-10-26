import {
    createDemoManual,
    manualSessionSchema,
    type ManualPage,
    type ManualSession,
    type ParsedManual,
} from '@truebuild/contracts'

/** Original synthetic reviewed fixture. It is not a real manual and is not physically qualified. */
export const SAMPLE_MANUAL_LABEL = 'Sample manual — original synthetic fixture, not physically qualified'

export function sampleManual(): ManualSession {
    return createDemoManual()
}

export type PlanConfirmation =
    | { readonly status: 'confirmed'; readonly session: ManualSession }
    | { readonly status: 'blocked' }

/**
 * Turns a parsed plan into the reviewed session that checks use. Only an explicit user confirmation reaches this.
 * Model corrections are dropped, never accepted. If any critical fact is unknown, or the plan does not validate as a
 * fully reviewed session, confirmation is blocked and nothing is silently filled in.
 */
export function confirmParsedPlan(
    current: ManualSession,
    parsed: ParsedManual,
    pages: readonly ManualPage[],
): PlanConfirmation {
    const candidate = manualSessionSchema.safeParse({
        ...current,
        pages: [...pages],
        parts: parsed.parts,
        rawExtraction: parsed,
        reviewedSteps: parsed.steps.map((step) => ({ ...step, correction: null })),
        reviewStatus: 'reviewed',
    })

    return candidate.success ? { status: 'confirmed', session: candidate.data } : { status: 'blocked' }
}
