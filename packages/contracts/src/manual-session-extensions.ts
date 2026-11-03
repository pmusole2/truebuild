/** Optional step extensions known to compatibility bridge readers. Other unknown keys stay strict. */
export type ManualStepExtension = 'actions' | 'sourceText'
const extensions: readonly ManualStepExtension[] = ['actions', 'sourceText']

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Project only step fields; a correction's actions and unrelated validation are never changed. */
export function projectManualSessionExtensions(
    value: unknown,
    supported: readonly ManualStepExtension[] = ['actions'],
): unknown {
    if (!record(value)) return value
    const steps = (items: unknown): unknown =>
        Array.isArray(items)
            ? items.map((step: unknown) => {
                  if (!record(step)) return step
                  return Object.fromEntries(
                      Object.entries(step).filter(
                          ([key]) => !extensions.some((field) => field === key && !supported.includes(field)),
                      ),
                  )
              })
            : items
    return {
        ...value,
        ...(value.reviewedSteps === undefined ? {} : { reviewedSteps: steps(value.reviewedSteps) }),
        ...(record(value.rawExtraction)
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
