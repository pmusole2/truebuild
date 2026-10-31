import { manualSessionSchema, type ManualSession } from '@truebuild/contracts'

/** The exact candidate Confirm saves, shared with private destination preparation. */
export function reviewedSession(session: ManualSession): ManualSession | null {
    const candidate = {
        ...session,
        reviewStatus: 'reviewed',
        reviewedSteps: session.reviewedSteps.map((step) => ({
            ...step,
            correction: step.correction === null ? null : { ...step.correction, reviewed: true },
        })),
    }
    const valid = manualSessionSchema.safeParse(candidate)
    return valid.success ? valid.data : null
}
