import { createHash, randomUUID } from 'node:crypto'
import type { CheckResult, StandardModel } from '@truebuild/contracts'
import type { CheckStepInput } from '../providers/meta-provider'

/** Hash all admitted intent and raw bytes, retaining no manual, photo, or credential. */
function fingerprint(input: CheckStepInput): string {
    const hash = createHash('sha256')
    hash.update(
        JSON.stringify({
            requestId: input.requestId,
            binding: input.binding,
            session: input.session,
            pages: input.sourceImages.map(({ page }) => page),
            observation: {
                mimeType: input.observation.mimeType,
                width: input.observation.width,
                height: input.observation.height,
            },
        }),
    )
    for (const bytes of [...input.sourceImages.map((source) => source.bytes), input.observation.bytes]) {
        hash.update(`:${bytes.byteLength}:`)
        hash.update(bytes)
    }
    return hash.digest('hex')
}

/** Owned by one authenticated runtime. Restart/config/auth replacement invalidates every ticket. */
export class SecondOpinionTickets {
    readonly #tickets = new Map<string, { expires: number; fingerprint: string; primary: CheckResult }>()
    constructor(private readonly now: () => number = () => performance.now()) {}

    issue(input: CheckStepInput, primary: CheckResult): string | null {
        this.prune()
        if (this.#tickets.size >= 64 || primary.decision !== 'cannot_verify' || primary.model !== 'muse-spark-1.3')
            return null
        const token = randomUUID()
        this.#tickets.set(token, {
            expires: this.now() + 120_000,
            fingerprint: fingerprint(input),
            primary: structuredClone(primary),
        })
        return token
    }

    consume(token: string, input: CheckStepInput): CheckResult | null {
        this.prune()
        const ticket = this.#tickets.get(token)
        // Synchronous deletion before comparison or any await: altered intent also burns the capability.
        this.#tickets.delete(token)
        return ticket && ticket.fingerprint === fingerprint(input) && this.now() < ticket.expires
            ? ticket.primary
            : null
    }

    revoke(token: string): void {
        this.#tickets.delete(token)
    }

    private prune(): void {
        const now = this.now()
        for (const [token, ticket] of this.#tickets) if (now >= ticket.expires) this.#tickets.delete(token)
    }
}

export function unavailableSecondOpinion(primary: CheckResult, model: StandardModel): CheckResult {
    return {
        ...primary,
        secondOpinion: { model, status: 'unavailable' },
        modelNotes: ['The second opinion was unavailable. The original Spark uncertainty remains.'],
    }
}

export function reconcileSecondOpinion(
    primary: CheckResult,
    secondary: CheckResult,
    model: StandardModel,
    input: CheckStepInput,
): CheckResult {
    const step = input.session.reviewedSteps.find((candidate) => candidate.stepId === input.binding.stepId)
    const sameRef = (a: CheckResult['sourceRefs'][number], b: CheckResult['sourceRefs'][number]): boolean =>
        a.pageId === b.pageId && JSON.stringify(a.region) === JSON.stringify(b.region)
    const orientationConflict =
        primary.orientationAssessment === 'correct' && secondary.orientationAssessment === 'reversed'
    const grounded =
        secondary.sourceRefs.length > 0 &&
        secondary.sourceRefs.every((ref) => input.sourceImages.some((source) => source.page.pageId === ref.pageId)) &&
        secondary.sourceRefs.some((ref) => step?.sourceRefs.some((expected) => sameRef(ref, expected)))
    const refusal =
        secondary.decision === 'refuse' &&
        secondary.model === model &&
        grounded &&
        secondary.observedRegion !== null &&
        secondary.missingEvidence.length === 0 &&
        !orientationConflict
    return {
        ...(refusal ? secondary : primary),
        secondOpinion: { model, status: 'completed' },
        modelNotes: [
            refusal
                ? 'A grounded second opinion identified a mismatch after the initial Spark uncertainty.'
                : 'The second opinion did not establish a coherent grounded refusal. The original Spark uncertainty remains; a second opinion cannot approve this step.',
        ],
    }
}
