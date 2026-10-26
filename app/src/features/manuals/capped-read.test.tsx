import { readCappedResponse, type ByteResponse } from './capped-read'
import { ImportRejectedError } from './import-errors'

const LIMIT = 16

function responseWith(options: {
    contentLength?: string | null
    buffer?: ArrayBuffer
    chunks?: Uint8Array[]
    cancel?: jest.Mock
}): ByteResponse {
    const chunks = options.chunks ?? []
    const body =
        options.chunks === undefined
            ? null
            : new ReadableStream<Uint8Array>({
                  pull(controller): void {
                      const next = chunks.shift()
                      if (next === undefined) {
                          controller.close()
                          return
                      }
                      controller.enqueue(next)
                  },
                  cancel: options.cancel,
              })
    return {
        ok: true,
        headers: { get: (): string | null => options.contentLength ?? null },
        body,
        arrayBuffer: async (): Promise<ArrayBuffer> => options.buffer ?? new ArrayBuffer(0),
    }
}

async function failureOf(promise: Promise<unknown>): Promise<string | null> {
    try {
        await promise
        return null
    } catch (error: unknown) {
        return error instanceof ImportRejectedError ? error.failure : 'other'
    }
}

describe('readCappedResponse', () => {
    it('returns bytes at exactly the cap', async () => {
        const bytes = await readCappedResponse(responseWith({ buffer: new ArrayBuffer(LIMIT) }), LIMIT)
        expect(bytes.byteLength).toBe(LIMIT)
    })

    it('rejects a declared length above the cap without reading the body', async () => {
        const arrayBuffer = jest.fn(async (): Promise<ArrayBuffer> => new ArrayBuffer(0))
        const response = { ...responseWith({ contentLength: String(LIMIT + 1) }), arrayBuffer }
        expect(await failureOf(readCappedResponse(response, LIMIT))).toBe('oversize')
        expect(arrayBuffer).not.toHaveBeenCalled()
    })

    it('rejects an undeclared oversize body on the buffered path', async () => {
        const response = responseWith({ contentLength: null, buffer: new ArrayBuffer(LIMIT + 1) })
        expect(await failureOf(readCappedResponse(response, LIMIT))).toBe('oversize')
    })

    it('stops streaming as soon as the cap is crossed and cancels the reader', async () => {
        const cancel = jest.fn(async (): Promise<void> => undefined)
        const chunks = [new Uint8Array(10), new Uint8Array(10)]
        expect(await failureOf(readCappedResponse(responseWith({ chunks, cancel }), LIMIT))).toBe('oversize')
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('reassembles streamed chunks under the cap', async () => {
        const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])]
        const bytes = await readCappedResponse(responseWith({ chunks }), LIMIT)
        expect(Array.from(bytes)).toEqual([1, 2, 3])
    })

    it('treats a non-ok response as unreadable', async () => {
        const response = { ...responseWith({ buffer: new ArrayBuffer(1) }), ok: false }
        expect(await failureOf(readCappedResponse(response, LIMIT))).toBe('unreadable')
    })
})
