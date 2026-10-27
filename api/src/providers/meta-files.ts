import { settleMetaResponse } from './meta-transport'
import { BudgetError, type ModelCallCounter } from '../server/budget'
/** Optional server-only Files adapter. Normal still calls stay inline, so no remote storage is implicit. */
import { z } from 'zod'
import { createDeadline } from '../server/deadline'
import { MetaProviderError, readMetaResponse } from './meta-provider'

const fileResponse = z.object({
    id: z.string().min(1).max(128),
    object: z.literal('file'),
    bytes: z.number().int().nonnegative(),
    created_at: z.number().int().nonnegative(),
    filename: z.string().max(1024),
    purpose: z.string().max(64),
    status: z.string().optional(),
    expires_at: z.number().int().nonnegative().nullable().optional(),
})

export async function uploadMetaFile(
    options: {
        apiKey?: string
        /** Use the runtime counter when explicitly composing this optional upload path. */
        counter: ModelCallCounter
        file: File
        expiresAfterSeconds?: number
        fetchImpl?: typeof fetch
    },
    signal: AbortSignal,
): Promise<z.infer<typeof fileResponse>> {
    if (!options.apiKey?.trim()) throw new MetaProviderError('unconfigured')
    const expiration = options.expiresAfterSeconds
    if (
        options.file.size <= 0 ||
        options.file.size > 1_073_741_824 ||
        (expiration !== undefined && (!Number.isSafeInteger(expiration) || expiration < 3600 || expiration > 2_592_000))
    ) {
        throw new MetaProviderError('invalid_input')
    }
    const deadline = createDeadline(30_000, signal)
    let response: Response | undefined
    try {
        const form = new FormData()
        form.append('purpose', 'user_data')
        if (expiration !== undefined) {
            form.append('expires_after[anchor]', 'created_at')
            form.append('expires_after[seconds]', String(expiration))
        }
        form.append('file', options.file)
        deadline.checkpoint()
        options.counter.claim()
        response = await settleMetaResponse(
            (options.fetchImpl ?? fetch)('https://api.meta.ai/v1/files', {
                method: 'POST',
                redirect: 'error',
                headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
                body: form,
                signal: deadline.signal,
            }),
            deadline,
        )
        deadline.checkpoint()
        if (!response.ok) throw new MetaProviderError('provider_error')
        const parsed = fileResponse.safeParse(await readMetaResponse(response, deadline))
        if (!parsed.success) throw new MetaProviderError('invalid_output')
        return parsed.data
    } catch (error) {
        if (error instanceof MetaProviderError || error instanceof BudgetError) throw error
        throw new MetaProviderError('provider_error')
    } finally {
        deadline.dispose()
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
    }
}
