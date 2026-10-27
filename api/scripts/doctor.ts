import { settleMetaResponse } from '../src/providers/meta-transport'
/** Explicit operator-only read. Importing this module never dispatches or reads credentials. */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
    sparkModel,
    parseModel,
    secondOpinionModel,
    readMetaResponse,
    checkContextMode,
} from '../src/providers/meta-provider'
import { createDeadline } from '../src/server/deadline'

const models = z.object({ data: z.array(z.object({ id: z.string().min(1).max(128) })).max(10_000) })
const PRICING = {
    kind: 'pricing_assumptions',
    asOf: '2026-10-27',
    currency: 'USD',
    perMillionTokens: {
        'muse-spark-1.3': { input: 1.25, cachedInput: 0.15, outputIncludingReasoning: 4.25 },
        'muse-wonder-1.0': { input: 4, cachedInput: 0.2, outputIncludingReasoning: 20 },
    },
    samImage: 0.0025,
    samVideoPerFrame: 0.0002,
    samVideoMinimumFrames: 50,
    parseOutputTokenCap: 24000,
    checkOutputTokenCap: 1500,
    callLimitIsNotDollarBudget: true,
}

export async function doctor(
    environment: Readonly<Record<string, string | undefined>>,
    transport: typeof fetch = fetch,
    print: (line: string) => void = console.log,
): Promise<number> {
    print(JSON.stringify(PRICING))
    if (!environment.MODEL_API_KEY?.trim()) {
        print('local_key_required')
        return 2
    }
    let response: Response | undefined
    const deadline = createDeadline(15_000)
    try {
        const spark = sparkModel(environment.MODEL_SPARK)
        const parse = parseModel(environment.MODEL_PARSE)
        const secondary = secondOpinionModel(environment.MODEL_SECOND_OPINION)
        const checkContext = checkContextMode(environment.MODEL_CHECK_CONTEXT)
        if (environment.MODEL_SAM !== undefined && environment.MODEL_SAM !== 'sam-3.1') throw new Error('invalid_model')
        // Exactly one GET; there is deliberately no retry, inference, file or token-count operation.
        response = await settleMetaResponse(
            transport('https://api.meta.ai/v1/models', {
                method: 'GET',
                redirect: 'error',
                signal: deadline.signal,
                headers: { authorization: `Bearer ${environment.MODEL_API_KEY}`, accept: 'application/json' },
            }),
            deadline,
        )
        deadline.checkpoint()
        if (!response.ok) {
            print(JSON.stringify({ kind: 'models', status: response.status, available: 'unverified' }))
            return 2
        }
        const available = new Set(
            models.parse(await readMetaResponse(response, deadline)).data.map((model) => model.id),
        )
        deadline.checkpoint()
        const valid = [spark, parse, ...(secondary ? [secondary] : []), 'sam-3.1'].every((model) =>
            available.has(model),
        )
        print(
            JSON.stringify({
                kind: 'models',
                spark,
                parse,
                secondOpinion: secondary ?? 'disabled',
                sam: 'sam-3.1',
                checkContext,
                available: valid ? 'listed' : 'required_model_not_listed',
                inferenceVerified: false,
            }),
        )
        return valid ? 0 : 2
    } catch {
        print('models_unverified')
        return 2
    } finally {
        deadline.dispose()
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    doctor(process.env)
        .then((code) => {
            process.exitCode = code
        })
        .catch(() => {
            console.log('models_unverified')
            process.exitCode = 2
        })
}
