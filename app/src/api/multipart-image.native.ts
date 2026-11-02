import { File, Paths } from 'expo-file-system'
import { randomUUID } from 'expo-crypto'
import type { ImageBytes } from './model-client'

const owned = new WeakMap<FormData, File[]>()
/** Expo's native multipart converter reads cached files through bytes().
 * Keep explicit wire filenames/MIME types and temp-file ownership until fetch settles.
 */
export function appendMultipartImage(form: FormData, name: string, image: ImageBytes, filename: string): void {
    const file = new File(Paths.cache, `truebuild-upload-${randomUUID()}-${filename}`)
    const files = owned.get(form) ?? []
    files.push(file)
    owned.set(form, files)
    file.writeSync(image.bytes)
    Reflect.apply(form.append, form, [
        name,
        { uri: file.uri, name: filename, type: image.mimeType, bytes: file.bytes.bind(file) },
    ])
}
export function releaseMultipartImages(form: FormData): void {
    for (const file of owned.get(form) ?? []) {
        try {
            file.delete()
        } catch {
            /* OS cache eviction may already have removed it. */
        }
    }
    owned.delete(form)
}
