import { checkResultSchema, parsedManualSchema, questionResultSchema } from '@truebuild/contracts'
import { z } from 'zod'

/** Shape hints only; shared Zod schemas and contextual source checks remain the acceptance boundary. */
export const metaOutputSchemas = {
    parse: z.toJSONSchema(parsedManualSchema, { target: 'draft-7' }),
    check: z.toJSONSchema(checkResultSchema, { target: 'draft-7' }),
    question: z.toJSONSchema(questionResultSchema, { target: 'draft-7' }),
}

// Extra service metadata is ignored; only one completed assistant text payload is accepted.
export const completedResponseSchema = z.object({
    status: z.literal('completed'),
    error: z.null().optional(),
    incomplete_details: z.null().optional(),
    output: z
        .array(
            z.object({
                type: z.literal('message'),
                role: z.literal('assistant'),
                status: z.literal('completed'),
                content: z
                    .array(
                        z.object({
                            type: z.literal('output_text'),
                            text: z.string().min(1).max(1_048_576),
                            annotations: z.array(z.unknown()).max(0).optional(),
                        }),
                    )
                    .length(1),
            }),
        )
        .length(1),
})
