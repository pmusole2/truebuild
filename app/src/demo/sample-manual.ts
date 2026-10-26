import {
    createDemoManual,
    manualSessionSchema,
    type Fact,
    type ManualBinding,
    type ManualPage,
    type ManualSession,
    type ManualStep,
    type ParsedManual,
} from '@truebuild/contracts'

/** Original synthetic reviewed fixture. It is not a real manual and is not physically qualified. */
export const SAMPLE_MANUAL_LABEL = 'Sample manual — original synthetic fixture, not physically qualified'

export function sampleManual(): ManualSession {
    return createDemoManual()
}

export type PlanConfirmation =
    | { readonly status: 'confirmed'; readonly session: ManualSession }
    | { readonly status: 'blocked'; readonly unknowns: readonly string[] }

function unknownOf<T>(fact: Fact<T>, label: string, unknowns: string[]): void {
    if (fact.state === 'unknown') {
        unknowns.push(`${label}: ${fact.reason}`)
    }
}

/** Every critical fact the user must see resolved before a plan can be used for checks. */
export function unknownCriticalFacts(parsed: ParsedManual): string[] {
    const unknowns: string[] = []
    for (const part of parsed.parts) {
        unknownOf(part.name, `Part ${part.partId} name`, unknowns)
    }
    for (const step of parsed.steps) {
        const where = `Step ${step.order}`
        for (const part of step.parts) {
            unknownOf(part.quantity, `${where} quantity of ${part.partId}`, unknowns)
        }
        unknownOf(step.orientation, `${where} orientation`, unknowns)
        unknownOf(step.connection, `${where} connection`, unknowns)
        for (const check of step.visibleChecks) {
            unknownOf(check.description, `${where} visible check ${check.checkId}`, unknowns)
        }
    }
    return unknowns
}

function buildSession(
    current: ManualSession | null,
    parsed: ParsedManual,
    pages: readonly ManualPage[],
    binding: ManualBinding,
): ManualSession {
    return {
        manualId: binding.manualId,
        title: current?.title ?? 'Manual from your photo',
        updatedAt: new Date().toISOString(),
        revision: binding.revision,
        pages: [...pages],
        parts: parsed.parts,
        rawExtraction: parsed,
        reviewedSteps: parsed.steps.map((step: ManualStep): ManualStep => ({ ...step, correction: null })),
        reviewStatus: 'reviewed',
    }
}

/**
 * Turns a parsed plan into the reviewed session that checks use. Only an explicit user confirmation reaches this.
 * Model corrections are dropped, never accepted. Any unknown critical fact blocks confirmation and is returned so it can
 * be shown; nothing is filled in silently. `current` may be null: a photographed manual has no sample to replace.
 */
export function confirmParsedPlan(
    current: ManualSession | null,
    parsed: ParsedManual,
    pages: readonly ManualPage[],
    binding: ManualBinding,
): PlanConfirmation {
    const unknowns = unknownCriticalFacts(parsed)
    if (unknowns.length > 0) {
        return { status: 'blocked', unknowns }
    }
    const candidate = manualSessionSchema.safeParse(buildSession(current, parsed, pages, binding))
    return candidate.success
        ? { status: 'confirmed', session: candidate.data }
        : { status: 'blocked', unknowns: ['The plan does not match its cited source pages. Nothing was filled in.'] }
}
