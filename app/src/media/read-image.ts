import { readCappedResponse } from './capped-read'

/** Web fetch reader; local native files use File size checks before allocating a byte buffer. */
export async function readImage(uri: string, cap: number): Promise<Uint8Array<ArrayBuffer>> {
    return readCappedResponse(await fetch(uri), cap)
}
