import { File, Paths } from 'expo-file-system'
import { randomUUID } from 'expo-crypto'
import type { ImageBytes } from './model-client'

const owned = new WeakMap<FormData, File[]>()
/** React Native multipart consumes local URI parts; it cannot construct Blob from typed-array bytes.
 * The platform-specific append extension is invoked here only; no wire/client contract changes.
 */
export function appendMultipartImage(form: FormData, name: string, image: ImageBytes, filename: string): void {
    const file = new File(Paths.cache, `truebuild-upload-${randomUUID()}-${filename}`)
    const files = owned.get(form) ?? []
    files.push(file)
    owned.set(form, files)
    file.writeSync(image.bytes)
    Reflect.apply(form.append, form, [name, { uri: file.uri, name: filename, type: image.mimeType }])
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
