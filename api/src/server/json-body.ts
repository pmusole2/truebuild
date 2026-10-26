export const MAX_JSON_BYTES = 65_536

export class InvalidBodyError extends Error {
    constructor(readonly status: 400 | 413 | 415) {
        super('Invalid JSON request')
    }
}

/** Read the stream incrementally; Request.json() would buffer an unbounded body first. */
export async function readBoundedJson(request: Request): Promise<unknown> {
    const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()

    if (contentType !== 'application/json') {
        await request.body?.cancel().catch((): void => {})
        throw new InvalidBodyError(415)
    }

    const declaredLength = request.headers.get('content-length')

    if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength)) {
            await request.body?.cancel().catch((): void => {})
            throw new InvalidBodyError(400)
        }

        if (Number(declaredLength) > MAX_JSON_BYTES) {
            await request.body?.cancel().catch((): void => {})
            throw new InvalidBodyError(413)
        }
    }

    if (!request.body) {
        throw new InvalidBodyError(400)
    }

    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0

    try {
        while (true) {
            const chunk = await reader.read()

            if (chunk.done) {
                break
            }

            bytes += chunk.value.byteLength

            if (bytes > MAX_JSON_BYTES) {
                await reader.cancel().catch((): void => {})
                throw new InvalidBodyError(413)
            }

            chunks.push(chunk.value)
        }

        const body = new Uint8Array(bytes)
        let offset = 0

        for (const chunk of chunks) {
            body.set(chunk, offset)
            offset += chunk.byteLength
        }

        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))

        return parsed
    } catch (error: unknown) {
        if (error instanceof InvalidBodyError) {
            throw error
        }

        throw new InvalidBodyError(400)
    } finally {
        reader.releaseLock()
    }
}
