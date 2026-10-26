import { MediaRejectedError } from './media-errors'

// The subset of a fetch Response needed to read bytes under a cap.
export type ByteResponse = {
    readonly ok: boolean
    readonly headers: { get(name: string): string | null }
    readonly body: ReadableStream<Uint8Array> | null
    arrayBuffer(): Promise<ArrayBuffer>
}

// Stops reading as soon as the cap is crossed, whether or not the platform declared a length.
export async function readCappedResponse(response: ByteResponse, limitBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!response.ok) {
        throw new MediaRejectedError('unreadable')
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limitBytes) {
        throw new MediaRejectedError('oversize')
    }
    const reader = response.body?.getReader()
    if (reader === undefined) {
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > limitBytes) {
            throw new MediaRejectedError('oversize')
        }
        return new Uint8Array(buffer)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) {
            break
        }
        total += value.byteLength
        if (total > limitBytes) {
            await reader.cancel()
            throw new MediaRejectedError('oversize')
        }
        chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return bytes
}
