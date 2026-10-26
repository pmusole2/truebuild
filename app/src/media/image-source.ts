import type { ManualPage } from '@truebuild/contracts'

const BASE64_CHUNK_BYTES = 0x8000

// Builds a data URI from stored bytes. Nothing returned here is persisted, so no temporary URL becomes stored media.
export function bytesToDataUri(bytes: Uint8Array, mimeType: ManualPage['mimeType']): string {
    let binary = ''
    for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_BYTES) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
    }
    return `data:${mimeType};base64,${btoa(binary)}`
}
