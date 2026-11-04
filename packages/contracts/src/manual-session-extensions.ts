/**
 * Every optional step field this build names. Both fields are modeled by manualStepSchema; registered fields may
 * be projected away for an older reader. Fields outside this list stay strictly rejected.
 */
export const SUPPORTED_STEP_EXTENSIONS = ['actions', 'sourceText'] as const
export type StepExtension = (typeof SUPPORTED_STEP_EXTENSIONS)[number]
export type ManualStepExtension = StepExtension

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Step extensions a request asks for: `stepFields` names (comma-separated, repeatable) and the `stepActions=1` alias. */
export function requestedStepExtensions(query: { getAll(name: string): string[] }): ReadonlySet<StepExtension> {
    const named = query.getAll('stepFields').flatMap((value) => value.split(',').map((name) => name.trim()))
    const aliases = query.getAll('stepActions')
    const requested = new Set<string>(named)
    if (aliases.length === 1 && aliases[0] === '1') requested.add('actions')
    return new Set(SUPPORTED_STEP_EXTENSIONS.filter((name) => requested.has(name)))
}

/** Drops registered extension fields that `modeled` does not include from one step; other keys stay for strict validation. */
export function projectStepExtensions(step: unknown, modeled: ReadonlySet<StepExtension>): unknown {
    if (!isRecord(step)) return step
    const unmodeled = SUPPORTED_STEP_EXTENSIONS.filter((name) => !modeled.has(name))
    return Object.fromEntries(Object.entries(step).filter(([key]) => !unmodeled.some((name) => name === key)))
}

/** Project only step fields; a correction's actions and unrelated validation are never changed. */
export function projectManualSessionExtensions(
    value: unknown,
    supported: readonly StepExtension[] = SUPPORTED_STEP_EXTENSIONS,
): unknown {
    if (!isRecord(value)) return value
    const modeled = new Set(supported)
    const steps = (items: unknown): unknown =>
        Array.isArray(items) ? items.map((step: unknown) => projectStepExtensions(step, modeled)) : items
    return {
        ...value,
        ...(value.reviewedSteps === undefined ? {} : { reviewedSteps: steps(value.reviewedSteps) }),
        ...(isRecord(value.rawExtraction)
            ? { rawExtraction: { ...value.rawExtraction, steps: steps(value.rawExtraction.steps) } }
            : {}),
    }
}

/** Long prose is bounded at a complete word when possible, including languages without spaces. */
export function boundedActionInstruction(text: string): string {
    const trimmed = text.trim()
    if (trimmed.length <= 120) return trimmed
    const prefix = trimmed.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '')
    const boundary = prefix.search(/\s+\S*$/u)
    return (boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()
}
