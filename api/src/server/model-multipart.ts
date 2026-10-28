import { MODEL_METADATA_MAX_BYTES } from '@truebuild/contracts/model'
import { LIMITS } from '@truebuild/contracts'
import type { z } from 'zod'

import type { Deadline } from './deadline'

export class ModelBodyError extends Error {
    constructor(readonly status: 400 | 413 | 415) {
        super('invalid_input')
    }
}

export async function withinModelDeadline<T>(promise: Promise<T>, deadline: Deadline): Promise<T> {
    void promise.catch((): void => {})
    deadline.checkpoint()
    let onAbort: (() => void) | undefined
    const stopped = new Promise<never>((_resolve, reject): void => {
        onAbort = (): void => {
            try {
                deadline.checkpoint()
            } catch (error) {
                reject(error)
            }
        }
        deadline.signal.addEventListener('abort', onAbort, { once: true })
        if (deadline.signal.aborted) {
            onAbort()
        }
    })
    try {
        const result = await Promise.race([promise, stopped])
        deadline.checkpoint()
        return result
    } finally {
        if (onAbort) {
            deadline.signal.removeEventListener('abort', onAbort)
        }
    }
}

export async function readModelMultipart<T>(
    request: Request,
    schema: z.ZodType<T>,
    maxBytes: number,
    deadline: Deadline,
): Promise<{ metadata: T; files: Map<string, File> }> {
    const reader = request.body?.getReader()
    let released = false
    const cancel = (): void => {
        if (reader && !released) {
            released = true
            void reader.cancel().catch((): void => {})
            reader.releaseLock()
        }
    }
    deadline.signal.addEventListener('abort', cancel, { once: true })
    try {
        deadline.checkpoint()
        const contentType = request.headers.get('content-type') ?? ''
        if (!/^multipart\/form-data\s*;/iu.test(contentType) || !/\bboundary=/iu.test(contentType)) {
            throw new ModelBodyError(415)
        }
        const length = request.headers.get('content-length')
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
            throw new ModelBodyError(413)
        }
        if (!reader) {
            throw new ModelBodyError(400)
        }
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
            const chunk = await withinModelDeadline(reader.read(), deadline)
            deadline.checkpoint()
            if (chunk.done) {
                break
            }
            size += chunk.value.length
            if (size > maxBytes) {
                throw new ModelBodyError(413)
            }
            chunks.push(new Uint8Array(chunk.value))
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.length
        }
        let form: FormData
        try {
            form = await withinModelDeadline(
                new Response(bytes, { headers: { 'content-type': contentType } }).formData(),
                deadline,
            )
        } catch (error) {
            deadline.checkpoint()
            if (error instanceof ModelBodyError) {
                throw error
            }
            throw new ModelBodyError(400)
        }
        deadline.checkpoint()
        const metadata = form.getAll('metadata')
        const raw = metadata[0]
        if (metadata.length !== 1 || typeof raw !== 'string' || Buffer.byteLength(raw) > MODEL_METADATA_MAX_BYTES) {
            throw new ModelBodyError(400)
        }
        let value: unknown
        try {
            value = JSON.parse(raw)
        } catch {
            throw new ModelBodyError(400)
        }
        // A parse-specific rejection may carry a safe split message before the generic file-count limit rejects it.
        // Body and metadata byte ceilings already hold; every accepted request still passes the entry checks below.
        const parsed = schema.safeParse(value)
        deadline.checkpoint()
        if (!parsed.success) {
            throw new ModelBodyError(400)
        }
        const names = new Set<string>()
        const files = new Map<string, File>()
        for (const [name, value] of form.entries()) {
            if (names.has(name) || names.size >= LIMITS.requestImages + 1) {
                throw new ModelBodyError(400)
            }
            names.add(name)
            if (name === 'metadata') {
                if (typeof value !== 'string' || Buffer.byteLength(value) > MODEL_METADATA_MAX_BYTES) {
                    throw new ModelBodyError(400)
                }
            } else {
                if (typeof value === 'string') {
                    throw new ModelBodyError(400)
                }
                files.set(name, value)
            }
        }
        return { metadata: parsed.data, files }
    } finally {
        deadline.signal.removeEventListener('abort', cancel)
        cancel()
    }
}

export async function modelFileBytes(
    files: Map<string, File>,
    name: string,
    mimeType: string,
    maximum: number,
    deadline: Deadline,
): Promise<Uint8Array> {
    const file = files.get(name)
    if (!file || file.type !== mimeType || file.size === 0 || file.size > maximum) {
        throw new ModelBodyError(file && file.size > maximum ? 413 : 400)
    }
    const bytes = await withinModelDeadline(file.arrayBuffer(), deadline)
    deadline.checkpoint()
    return new Uint8Array(bytes)
}

export function exactModelFiles(files: Map<string, File>, expected: readonly string[], imageRoute: boolean): void {
    if (files.size !== expected.length || expected.some((name) => !files.has(name))) {
        throw new ModelBodyError(400)
    }
    if (imageRoute && [...files.values()].reduce((total, file) => total + file.size, 0) > LIMITS.requestBytes) {
        throw new ModelBodyError(413)
    }
}
