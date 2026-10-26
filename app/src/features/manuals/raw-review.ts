import { manualSessionSchema, type ManualSession, type ManualStep } from '@truebuild/contracts'

/** User-facing refusal. Every refusal leaves the session unchanged. */
export class RawReviewError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RawReviewError'
    }
}

function referencedPartIds(step: ManualStep): string[] {
    return [
        ...new Set([
            ...step.parts.map((part) => part.partId),
            ...(step.orientation.state === 'known' ? [step.orientation.value.partId] : []),
            ...(step.connection.state === 'known' ? step.connection.value.partIds : []),
        ]),
    ]
}

function bump(
    session: ManualSession,
    reviewedSteps: ManualStep[],
    parts: ManualSession['parts'],
    now: string,
): ManualSession {
    const next = manualSessionSchema.safeParse({
        ...session,
        parts,
        reviewedSteps,
        updatedAt: now,
        revision: session.revision + 1,
        reviewStatus: 'unreviewed',
    })
    if (!next.success) {
        throw new RawReviewError('This change does not fit the manual, so nothing was changed.')
    }
    return next.data
}

/**
 * Copies one raw step, and the parts it references, into the editable draft. The raw evidence is read, never changed.
 * Nothing existing is overwritten: a step already in the draft, or a draft part with the same identity but a different
 * name, refuses the copy. The copied facts stay exactly as extracted (unknowns stay unknown and block review).
 */
export function copyRawStepToDraft(session: ManualSession, rawStepId: string, now: string): ManualSession {
    const raw = session.rawExtraction
    if (raw === null) {
        throw new RawReviewError('There is no raw extraction to copy from.')
    }
    const rawStep = raw.steps.find((step) => step.stepId === rawStepId)
    if (rawStep === undefined) {
        throw new RawReviewError('That raw step is no longer in the raw extraction.')
    }
    if (session.reviewedSteps.some((step) => step.stepId === rawStepId)) {
        throw new RawReviewError(
            'This raw step is already in the draft. Copying it again would duplicate it, so nothing changed.',
        )
    }

    const parts = [...session.parts]
    for (const partId of referencedPartIds(rawStep)) {
        const rawPart = raw.parts.find((part) => part.partId === partId)
        if (rawPart === undefined) {
            throw new RawReviewError(
                'This raw step refers to a part that is not in the raw extraction, so nothing was copied.',
            )
        }
        const existing = parts.find((part) => part.partId === partId)
        if (existing === undefined) {
            parts.push({ partId, name: rawPart.name })
        } else if (JSON.stringify(existing.name) !== JSON.stringify(rawPart.name)) {
            throw new RawReviewError(
                `A draft part with this identity already has a different name, so nothing was copied. Edit that draft part first.`,
            )
        }
    }

    const order = session.reviewedSteps.reduce((max, step) => Math.max(max, step.order), 0) + 1
    const copied: ManualStep = { ...(JSON.parse(JSON.stringify(rawStep)) as ManualStep), order }
    return bump(session, [...session.reviewedSteps, copied], parts, now)
}

function stepOrThrow(session: ManualSession, stepId: string): ManualStep {
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
    if (step === undefined) {
        throw new RawReviewError('That step is not in the draft.')
    }
    return step
}

/** Explicit human confirmation of a proposed correction against its cited manual page. Never automatic. */
export function confirmCorrection(session: ManualSession, stepId: string, now: string): ManualSession {
    const step = stepOrThrow(session, stepId)
    if (step.correction === null) {
        throw new RawReviewError('This step has no proposed correction to confirm.')
    }
    if (step.correction.reviewed) {
        throw new RawReviewError('This correction is already confirmed.')
    }
    const updated = { ...step, correction: { ...step.correction, reviewed: true } }
    return bump(
        session,
        session.reviewedSteps.map((candidate) => (candidate.stepId === stepId ? updated : candidate)),
        session.parts,
        now,
    )
}

/** Removes a proposed (or confirmed) correction from a draft step. The step's other facts are untouched. */
export function discardCorrection(session: ManualSession, stepId: string, now: string): ManualSession {
    const step = stepOrThrow(session, stepId)
    if (step.correction === null) {
        throw new RawReviewError('This step has no proposed correction to discard.')
    }
    const updated = { ...step, correction: null }
    return bump(
        session,
        session.reviewedSteps.map((candidate) => (candidate.stepId === stepId ? updated : candidate)),
        session.parts,
        now,
    )
}

/**
 * Why a manual cannot be marked reviewed yet, in plain terms. Mirrors the schema's review rules; the schema remains the
 * authority that actually refuses the review.
 */
export function reviewBlockers(session: ManualSession): string[] {
    const blockers: string[] = []
    if (session.reviewedSteps.length === 0) {
        blockers.push('Add at least one step.')
    }
    for (const part of session.parts) {
        if (part.name.state === 'unknown') {
            blockers.push(`Part ${part.partId} has an unknown name.`)
        }
    }
    for (const step of session.reviewedSteps) {
        const label = `Step ${step.order}`
        if (step.sourceRefs.length === 0) blockers.push(`${label}: cite a source page.`)
        if (step.parts.length === 0) blockers.push(`${label}: add at least one part.`)
        if (step.parts.some((part) => part.quantity.state === 'unknown'))
            blockers.push(`${label}: a part quantity is unknown.`)
        if (step.orientation.state === 'unknown') blockers.push(`${label}: orientation is unknown.`)
        if (step.connection.state === 'unknown') blockers.push(`${label}: connection is unknown.`)
        if (step.visibleChecks.length === 0) blockers.push(`${label}: add a visible check.`)
        if (step.visibleChecks.some((check) => check.description.state === 'unknown')) {
            blockers.push(`${label}: a visible check is unknown.`)
        }
        if (step.correction !== null && !step.correction.reviewed) {
            blockers.push(`${label}: confirm or discard the proposed correction against the manual.`)
        }
    }
    return blockers
}
