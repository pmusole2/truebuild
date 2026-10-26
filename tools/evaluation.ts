import { captureBindingSchema } from '@truebuild/contracts'
import { z } from 'zod'

export const STANDARD_MODEL = 'muse-spark-1.3'
export const MAX_EVALUATION_SAMPLES = 10_000
export const QUALIFICATION = 'Dataset metadata gate only — not hardware, provenance or provider qualification'

const metadataIdSchema = z.string().trim().min(1).max(128)
const versionLabelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u)
const expectedSchema = z.enum(['correct', 'wrong', 'unclear'])
const decisionSchema = z.enum(['pass', 'refuse', 'cannot_verify', 'technical_error'])

export const evaluationSampleSchema = z.strictObject({
    requestId: metadataIdSchema,
    binding: captureBindingSchema,
    captureHash: z.string().regex(/^[a-f0-9]{64}$/u),
    sessionId: metadataIdSchema,
    mode: z.enum(['fixture', 'model']),
    source: z.enum(['real-capture', 'synthetic', 'manual-only']),
    expected: expectedSchema,
    decision: decisionSchema,
    latencyMs: z.number().finite().positive(),
    model: versionLabelSchema,
    promptVersion: versionLabelSchema,
    split: z.enum(['heldout', 'tuning']),
})

export const evaluationInputSchema = z.strictObject({
    version: z.literal(1),
    samples: z.array(evaluationSampleSchema).max(MAX_EVALUATION_SAMPLES),
})

export type EvaluationSample = z.infer<typeof evaluationSampleSchema>
type Expected = EvaluationSample['expected']
type Decision = EvaluationSample['decision']
type Matrix = Record<Expected, Record<Decision, number>>
export type GateStatus = 'pending' | 'fail' | 'pass'

export type EvaluationErrorCode = 'invalid_input' | 'duplicate_scored_sample'

export class EvaluationError extends Error {
    constructor(readonly code: EvaluationErrorCode) {
        super(code)
        this.name = 'EvaluationError'
    }
}

interface ClassMetrics {
    denominator: number
    successfulDecisionCount: number
    technicalErrorCount: number
    intendedDecision: 'pass' | 'refuse' | 'cannot_verify'
    usefulCount: number
    usefulRate: number | null
}

interface FalsePassMetrics {
    attempts: number
    successfulDecisions: number
    technicalErrors: number
    observedFalsePasses: number
    observedRateAmongSuccessful: number | null
    oneSided95UpperBound: number | null
    boundDenominator: 'successful decisions in this class only'
}

interface VersionCount {
    label: string
    count: number
    scoredCount: number
}

export interface EvaluationSummary {
    version: 1
    qualification: typeof QUALIFICATION
    evidence: 'Operator-supplied labels, source, independence and tap-to-display timing; not independently verified'
    counts: {
        total: number
        scored: number
        excluded: number
        byMode: Record<EvaluationSample['mode'], number>
        bySource: Record<EvaluationSample['source'], number>
        bySplit: Record<EvaluationSample['split'], number>
        exclusionReasonsMayOverlap: true
        exclusionReasons: { fixtureMode: number; nonRealCapture: number; tuningSplit: number; unsupportedModel: number }
        protocolFailures: number
    }
    confusionMatrix: Matrix
    excludedConfusionMatrix: Matrix
    technicalErrors: { total: number; scored: number; excluded: number }
    perClass: Record<Expected, ClassMetrics>
    falsePasses: {
        wrong: number
        unclear: number
        total: number
        classConditional: Record<'wrong' | 'unclear', FalsePassMetrics>
    }
    latency: {
        boundary: 'Operator-supplied tap-to-display; all scored attempts including technical errors'
        method: 'nearest-rank'
        count: number
        p50Ms: number | null
        p95Ms: number | null
    }
    sessions: { totalUnique: number; scoredUnique: number; excludedUnique: number }
    models: VersionCount[]
    promptVersions: VersionCount[]
    gate: {
        status: GateStatus
        label: 'Dataset metadata gate; physical qualification remains unverified'
        criteria: {
            protocol: GateStatus
            exactly30PerClass: GateStatus
            atLeastTwoScoredSessions: GateStatus
            zeroWrongOrUnclearPasses: GateStatus
            atLeast27UsefulPerClass: Record<Expected, GateStatus>
            p50AtMost3000Ms: GateStatus
            p95AtMost5000Ms: GateStatus
        }
    }
}

const CLASSES: readonly Expected[] = ['correct', 'wrong', 'unclear']

function emptyMatrix(): Matrix {
    return {
        correct: { pass: 0, refuse: 0, cannot_verify: 0, technical_error: 0 },
        wrong: { pass: 0, refuse: 0, cannot_verify: 0, technical_error: 0 },
        unclear: { pass: 0, refuse: 0, cannot_verify: 0, technical_error: 0 },
    }
}

function eligible(sample: EvaluationSample): boolean {
    return sample.mode === 'model' && sample.source === 'real-capture' && sample.split === 'heldout'
}

function scored(sample: EvaluationSample): boolean {
    return eligible(sample) && sample.model === STANDARD_MODEL
}

function classMetrics(matrix: Matrix, expected: Expected): ClassMetrics {
    const row = matrix[expected]
    const denominator = row.pass + row.refuse + row.cannot_verify + row.technical_error
    const intendedDecision = expected === 'correct' ? 'pass' : expected === 'wrong' ? 'refuse' : 'cannot_verify'
    const usefulCount = row[intendedDecision]

    return {
        denominator,
        successfulDecisionCount: denominator - row.technical_error,
        technicalErrorCount: row.technical_error,
        intendedDecision,
        usefulCount,
        usefulRate: denominator === 0 ? null : usefulCount / denominator,
    }
}

function falsePassMetrics(metrics: ClassMetrics, observedFalsePasses: number): FalsePassMetrics {
    const n = metrics.successfulDecisionCount

    return {
        attempts: metrics.denominator,
        successfulDecisions: n,
        technicalErrors: metrics.technicalErrorCount,
        observedFalsePasses,
        observedRateAmongSuccessful: n === 0 ? null : observedFalsePasses / n,
        oneSided95UpperBound: observedFalsePasses === 0 && n > 0 ? 1 - 0.05 ** (1 / n) : null,
        boundDenominator: 'successful decisions in this class only',
    }
}

function nearestRank(sorted: readonly number[], fraction: number): number | null {
    return sorted.length === 0 ? null : (sorted[Math.ceil(sorted.length * fraction) - 1] ?? null)
}

function versionCounts(rows: EvaluationSample[], field: 'model' | 'promptVersion'): VersionCount[] {
    const counts = new Map<string, VersionCount>()

    for (const row of rows) {
        const label = row[field]
        const entry = counts.get(label) ?? { label, count: 0, scoredCount: 0 }
        entry.count += 1
        entry.scoredCount += scored(row) ? 1 : 0
        counts.set(label, entry)
    }

    return [...counts.values()].sort((a, b): number => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

function rejectScoredDuplicates(rows: EvaluationSample[]): void {
    const requests = new Set<string>()
    const bindings = new Set<string>()
    const hashes = new Set<string>()

    for (const row of rows) {
        const binding = JSON.stringify([
            row.binding.kind,
            row.binding.manualId,
            row.binding.revision,
            row.binding.stepId,
            row.binding.captureId,
        ])

        if (requests.has(row.requestId) || bindings.has(binding) || hashes.has(row.captureHash)) {
            throw new EvaluationError('duplicate_scored_sample')
        }

        requests.add(row.requestId)
        bindings.add(binding)
        hashes.add(row.captureHash)
    }
}

/** Pure aggregate calculation; source and labels are declarations, never hardware/provenance proof. */
export function evaluateDataset(input: unknown): EvaluationSummary {
    const validated = evaluationInputSchema.safeParse(input)

    if (!validated.success) {
        throw new EvaluationError('invalid_input')
    }

    const rows = validated.data.samples
    const scoredRows = rows.filter(scored)
    const excludedRows = rows.filter((row): boolean => !scored(row))
    rejectScoredDuplicates(scoredRows)
    const matrix = emptyMatrix()
    const excludedMatrix = emptyMatrix()
    const byMode = { fixture: 0, model: 0 }
    const bySource = { 'real-capture': 0, synthetic: 0, 'manual-only': 0 }
    const bySplit = { heldout: 0, tuning: 0 }
    const exclusionReasons = { fixtureMode: 0, nonRealCapture: 0, tuningSplit: 0, unsupportedModel: 0 }
    let protocolFailures = 0

    for (const row of rows) {
        byMode[row.mode] += 1
        bySource[row.source] += 1
        bySplit[row.split] += 1

        if (row.mode === 'fixture') {
            exclusionReasons.fixtureMode += 1
        }
        if (row.source !== 'real-capture') {
            exclusionReasons.nonRealCapture += 1
        }
        if (row.split === 'tuning') {
            exclusionReasons.tuningSplit += 1
        }
        if (row.model !== STANDARD_MODEL) {
            exclusionReasons.unsupportedModel += 1
        }
        if (eligible(row) && row.model !== STANDARD_MODEL) {
            protocolFailures += 1
        }

        const destination = scored(row) ? matrix : excludedMatrix
        destination[row.expected][row.decision] += 1
    }

    const perClass = {
        correct: classMetrics(matrix, 'correct'),
        wrong: classMetrics(matrix, 'wrong'),
        unclear: classMetrics(matrix, 'unclear'),
    }
    const classCounts = CLASSES.map((expected): number => perClass[expected].denominator)
    const latencies = scoredRows.map((row): number => row.latencyMs).sort((a, b): number => a - b)
    const p50Ms = nearestRank(latencies, 0.5)
    const p95Ms = nearestRank(latencies, 0.95)
    const scoredSessions = new Set(scoredRows.map((row): string => row.sessionId)).size
    const falsePasses = matrix.wrong.pass + matrix.unclear.pass
    const criteria: EvaluationSummary['gate']['criteria'] = {
        protocol: protocolFailures === 0 ? 'pass' : 'fail',
        exactly30PerClass: classCounts.some((count): boolean => count > 30)
            ? 'fail'
            : classCounts.every((count): boolean => count === 30)
              ? 'pass'
              : 'pending',
        atLeastTwoScoredSessions: scoredSessions >= 2 ? 'pass' : 'pending',
        zeroWrongOrUnclearPasses:
            falsePasses > 0
                ? 'fail'
                : perClass.wrong.denominator + perClass.unclear.denominator === 0
                  ? 'pending'
                  : 'pass',
        atLeast27UsefulPerClass: {
            correct:
                perClass.correct.denominator < 30 ? 'pending' : perClass.correct.usefulCount >= 27 ? 'pass' : 'fail',
            wrong: perClass.wrong.denominator < 30 ? 'pending' : perClass.wrong.usefulCount >= 27 ? 'pass' : 'fail',
            unclear:
                perClass.unclear.denominator < 30 ? 'pending' : perClass.unclear.usefulCount >= 27 ? 'pass' : 'fail',
        },
        p50AtMost3000Ms: p50Ms === null ? 'pending' : p50Ms <= 3000 ? 'pass' : 'fail',
        p95AtMost5000Ms: p95Ms === null ? 'pending' : p95Ms <= 5000 ? 'pass' : 'fail',
    }
    const statuses = [
        criteria.protocol,
        criteria.exactly30PerClass,
        criteria.atLeastTwoScoredSessions,
        criteria.zeroWrongOrUnclearPasses,
        ...Object.values(criteria.atLeast27UsefulPerClass),
        criteria.p50AtMost3000Ms,
        criteria.p95AtMost5000Ms,
    ]
    // Underfilled classes stay visibly pending; protocol violations and excess rows are explicit failures.
    const status: GateStatus =
        criteria.protocol === 'fail' || criteria.exactly30PerClass === 'fail'
            ? 'fail'
            : classCounts.some((count): boolean => count < 30)
              ? 'pending'
              : statuses.includes('fail')
                ? 'fail'
                : statuses.includes('pending')
                  ? 'pending'
                  : 'pass'
    const scoredErrors = CLASSES.reduce((sum, expected): number => sum + matrix[expected].technical_error, 0)
    const excludedErrors = CLASSES.reduce((sum, expected): number => sum + excludedMatrix[expected].technical_error, 0)

    return {
        version: 1,
        qualification: QUALIFICATION,
        evidence:
            'Operator-supplied labels, source, independence and tap-to-display timing; not independently verified',
        counts: {
            total: rows.length,
            scored: scoredRows.length,
            excluded: excludedRows.length,
            byMode,
            bySource,
            bySplit,
            exclusionReasonsMayOverlap: true,
            exclusionReasons,
            protocolFailures,
        },
        confusionMatrix: matrix,
        excludedConfusionMatrix: excludedMatrix,
        technicalErrors: { total: scoredErrors + excludedErrors, scored: scoredErrors, excluded: excludedErrors },
        perClass,
        falsePasses: {
            wrong: matrix.wrong.pass,
            unclear: matrix.unclear.pass,
            total: falsePasses,
            classConditional: {
                wrong: falsePassMetrics(perClass.wrong, matrix.wrong.pass),
                unclear: falsePassMetrics(perClass.unclear, matrix.unclear.pass),
            },
        },
        latency: {
            boundary: 'Operator-supplied tap-to-display; all scored attempts including technical errors',
            method: 'nearest-rank',
            count: latencies.length,
            p50Ms,
            p95Ms,
        },
        sessions: {
            totalUnique: new Set(rows.map((row): string => row.sessionId)).size,
            scoredUnique: scoredSessions,
            excludedUnique: new Set(excludedRows.map((row): string => row.sessionId)).size,
        },
        models: versionCounts(rows, 'model'),
        promptVersions: versionCounts(rows, 'promptVersion'),
        gate: { status, label: 'Dataset metadata gate; physical qualification remains unverified', criteria },
    }
}
