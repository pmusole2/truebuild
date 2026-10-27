import AsyncStorage from '@react-native-async-storage/async-storage'
import { Directory, File, Paths } from 'expo-file-system'
import type { KeyValueStorage } from './library'

const PREFIX = 'truebuild/library/bytes/'
const directory = new Directory(Paths.document, 'truebuild-library-v1')
function assetFile(key: string): File | null {
    if (!key.startsWith(PREFIX)) {
        return null
    }
    const suffix = key.slice(PREFIX.length)
    if (!/^[a-zA-Z0-9-]{1,128}\/[a-f0-9]{64}\/[0-9]{1,2}$/u.test(suffix)) {
        throw new Error('Invalid local asset key')
    }
    return new File(directory, encodeURIComponent(suffix))
}
/** Metadata stays in AsyncStorage; image chunks live in durable documents storage. This avoids Android's default
 * AsyncStorage database ceiling for a 20-page manual. The shared library owns schema, hashes, chunk and aggregate limits.
 */
export const deviceStorage: KeyValueStorage = {
    async getItem(key): Promise<string | null> {
        const file = assetFile(key)
        if (file === null) {
            return AsyncStorage.getItem(key)
        }
        if (!file.exists) {
            return null
        }
        if (file.size > 65_536) {
            throw new Error('Local image chunk exceeds limit')
        }
        return file.text()
    },
    async setItem(key, value): Promise<void> {
        const file = assetFile(key)
        if (file === null) {
            await AsyncStorage.setItem(key, value)
            return
        }
        if (value.length > 65_536) {
            throw new Error('Local image chunk exceeds limit')
        }
        await directory.create({ idempotent: true, intermediates: true })
        await file.write(value)
    },
    async removeItem(key): Promise<void> {
        const file = assetFile(key)
        if (file === null) {
            await AsyncStorage.removeItem(key)
            return
        }
        if (file.exists) {
            file.delete()
        }
    },
    async getAllKeys(): Promise<readonly string[]> {
        const keys = [...(await AsyncStorage.getAllKeys())]
        for (const file of directory.exists ? directory.list() : []) {
            if (file instanceof File) {
                keys.push(`${PREFIX}${decodeURIComponent(file.name)}`)
            }
        }
        return keys
    },
}
