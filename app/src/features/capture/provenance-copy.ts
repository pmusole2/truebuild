import type { CheckResult } from '@truebuild/contracts'

/** True when the server stamped the result as produced by an isolated fixture that ran no model. */
export const isFixtureResult = (result: Pick<CheckResult, 'evidence'> | null | undefined): boolean =>
    result?.evidence === 'synthetic-fixture'

/**
 * The name of the model an offered second opinion is aimed at. On a fixture result the offer's model is only the
 * intended target and nothing ran, so it is never named as if it had been used.
 */
export function secondOpinionTarget(check: Pick<CheckResult, 'evidence'>, model: string): string {
    return isFixtureResult(check) ? 'simulated' : model
}

/** The line that reports what became of an offered second opinion; null when none was offered or it is still open. */
export function secondOpinionLine(check: Pick<CheckResult, 'secondOpinion' | 'evidence'>): string | null {
    const offer = check.secondOpinion
    if (offer === undefined || offer.status === 'available') return null
    return isFixtureResult(check)
        ? `Second opinion: simulated, no model call (${offer.status})`
        : `Second opinion: ${offer.model} (${offer.status})`
}
