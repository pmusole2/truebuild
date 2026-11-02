import { z } from 'zod'

export const AI_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const aiEffortSchema = z.enum(AI_EFFORTS)
export type AiEffort = z.infer<typeof aiEffortSchema>

/**
 * Provenance of a public value that an isolated fixture runtime produced without any model call. It is stamped by the
 * server only (an injected trusted fixture provider under `runtimeMode: 'fixture'`), never read from a request, and
 * such a value carries no model, effort, timing or usage: what was not observed is absent, not zero.
 */
export const FIXTURE_EVIDENCE = 'synthetic-fixture' as const
export type FixtureEvidence = typeof FIXTURE_EVIDENCE
export const fixtureEvidenceSchema = z.literal(FIXTURE_EVIDENCE)

export const standardModelSchema = z.enum(['muse-spark-1.3', 'muse-wonder-1.0'])
export type StandardModel = z.infer<typeof standardModelSchema>

export const TELEMETRY_STAGES = [
    'parse',
    'screens',
    'step-pages',
    'verdict',
    'overlay',
    'second-opinion',
    'questions',
] as const

const ms = z.number().min(0).nullable()
const count = z.number().int().min(0).nullable()

/**
 * What the server observed for the one provider call that produced a public result. Every value is optional in the
 * sense that matters: `null` means the call did not report or observe it (never zero, never estimated), and a result
 * from a runtime that made no model call carries no telemetry at all.
 *
 * Timing stages (all server-observed, monotonic):
 * - `timeToProviderMs`: request admission to the moment the provider request was handed to the transport (input
 *   preparation, image validation, prompt assembly).
 * - `paceWaitMs`: time the transport spent waiting for its per-model pacing reservation and status-retry backoff.
 * - `networkMs`: time from dispatch to the response headers, summed over bounded status retries.
 * - `bodyMs`: time reading the response body bytes.
 * - `providerMs`: dispatch to the end of the body (pace + network + body).
 * - `parseValidateMs`: outer JSON parse, response-envelope, output-JSON and schema validation.
 * - `totalMs`: admission to the end of validation.
 * `usage.reasoningTokens` is a subset of `outputTokens`.
 */
export const callTelemetrySchema = z.strictObject({
    stage: z.enum(TELEMETRY_STAGES),
    model: standardModelSchema,
    effort: aiEffortSchema,
    timing: z.strictObject({
        timeToProviderMs: ms,
        paceWaitMs: ms,
        networkMs: ms,
        bodyMs: ms,
        providerMs: ms,
        parseValidateMs: ms,
        totalMs: ms,
    }),
    stream: z
        .strictObject({ timeToCreatedMs: ms, timeToFirstOutputMs: ms, eventCount: z.number().int().min(0) })
        .optional(),
    usage: z.strictObject({
        inputTokens: count,
        cachedTokens: count,
        outputTokens: count,
        reasoningTokens: count,
    }),
})
export type ObservedCallTelemetry = z.infer<typeof callTelemetrySchema>
