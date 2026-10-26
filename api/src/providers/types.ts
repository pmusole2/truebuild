import {
    captureBindingSchema,
    manualBindingSchema,
    questionTargetSchema,
    segmentEventSchema,
    type CheckResult,
    type ParsedManual,
    type QuestionResult,
} from '@truebuild/contracts'
import { z } from 'zod'

export const DEMO_LABEL = 'Demo data — simulated results'

const common = {
    mode: z.enum(['fixture', 'model']),
    requestId: z.string().trim().min(1).max(128),
}

export const parseInputSchema = z.strictObject({ ...common, binding: manualBindingSchema })
export const checkInputSchema = z.strictObject({
    ...common,
    binding: captureBindingSchema,
    scenario: z.enum(['correct', 'wrong', 'unclear']),
})
export const questionInputSchema = z.strictObject({
    ...common,
    binding: captureBindingSchema,
    question: z.string().trim().min(1).max(500),
    target: questionTargetSchema,
})
export const segmentInputSchema = z.strictObject({
    ...common,
    binding: captureBindingSchema,
    stream: z.enum(['normal', 'empty', 'incomplete']).default('normal'),
})

export const segmentResultSchema = z
    .strictObject({
        label: z.literal(DEMO_LABEL),
        transport: z.literal('finite-json-precursor'),
        events: z.array(segmentEventSchema).min(1).max(2),
    })
    .superRefine((result, context): void => {
        const terminals = result.events.filter((event) => event.type !== 'snapshot')

        if (terminals.length !== 1 || result.events.at(-1)?.type === 'snapshot') {
            context.addIssue({ code: 'custom', message: 'A finite stream must end with exactly one terminal event' })
        }
    })

export type ParseInput = z.infer<typeof parseInputSchema>
export type CheckInput = z.infer<typeof checkInputSchema>
export type QuestionInput = z.infer<typeof questionInputSchema>
export type SegmentInput = z.infer<typeof segmentInputSchema>
export type SegmentResult = z.infer<typeof segmentResultSchema>

/** This wave intentionally exposes only a fixture implementation. No key or transport is accepted. */
export interface FixtureProvider {
    parse(input: ParseInput): Promise<ParsedManual>
    check(input: CheckInput): Promise<CheckResult>
    question(input: QuestionInput): Promise<QuestionResult>
    segment(input: SegmentInput): Promise<SegmentResult>
}
