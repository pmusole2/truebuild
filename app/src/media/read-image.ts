import { readCappedResponse } from './capped-read'

/** Web fetch reader; local native files use File size checks before allocating a byte buffer. */
export async function readImage(uri: string, cap: number): Promise<Uint8Array<ArrayBuffer>> {
    return readCappedResponse(await fetch(uri), cap)
}

/** Browsers provide a bounded stream rather than a trustworthy local filesystem stat. */
export async function probeImage(uri: string, cap: number): Promise<void> {
    await readImage(uri, cap)
}
