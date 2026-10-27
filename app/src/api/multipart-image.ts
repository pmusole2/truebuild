import type { ImageBytes } from './model-client'

export function appendMultipartImage(form: FormData, name: string, image: ImageBytes, filename: string): void {
    form.append(name, new Blob([Uint8Array.from(image.bytes)], { type: image.mimeType }), filename)
}
export function releaseMultipartImages(_form: FormData): void {
    /* Browser blobs are owned by FormData. */
}
