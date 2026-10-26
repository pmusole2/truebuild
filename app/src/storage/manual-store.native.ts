import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import {
    EncodingType,
    deleteAsync,
    documentDirectory,
    getInfoAsync,
    makeDirectoryAsync,
    readAsStringAsync,
    writeAsStringAsync,
} from 'expo-file-system/legacy'
import { ManualStorageError, digestToHex, type ContentDigest } from './manual-store.core'
import { createNativeManualStore, type NativeStoragePort } from './manual-store.native-core'
import type { ManualStore } from './manual-store.types'

const MANIFEST_KEY = 'truebuild.manual-store.manifest.v1'
const ASSET_DIRECTORY = 'truebuild-manual-assets'
const ASSET_FILE_NAME = /^[a-f0-9]{32}\.bin$/u
const BASE64_CHUNK = 0x8000

function assetDirectoryPath(): string {
    if (documentDirectory === null) {
        throw new ManualStorageError('unavailable', 'Private document directory is unavailable')
    }

    return `${documentDirectory}${ASSET_DIRECTORY}/`
}

function assetFilePath(fileName: string): string {
    if (!ASSET_FILE_NAME.test(fileName)) {
        throw new ManualStorageError('io', 'Refusing an unsafe asset file name')
    }

    return `${assetDirectoryPath()}${fileName}`
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''

    for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
    }

    return btoa(binary)
}

function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index)
    }

    return bytes
}

function createExpoPort(): NativeStoragePort {
    return {
        async ensureDirectory(): Promise<void> {
            const directory = assetDirectoryPath()
            const info = await getInfoAsync(directory)

            if (info.exists) {
                if (!info.isDirectory) {
                    throw new ManualStorageError('unavailable', 'Asset storage path exists but is not a directory')
                }
                return
            }

            await makeDirectoryAsync(directory, { intermediates: true })

            const created = await getInfoAsync(directory)

            if (!created.exists || !created.isDirectory) {
                throw new ManualStorageError('unavailable', 'Could not create the private asset directory')
            }
        },

        readManifestText(): Promise<string | null> {
            return AsyncStorage.getItem(MANIFEST_KEY)
        },

        async writeManifestText(text: string): Promise<void> {
            await AsyncStorage.setItem(MANIFEST_KEY, text)
        },

        async fileExists(fileName: string): Promise<boolean> {
            return (await getInfoAsync(assetFilePath(fileName))).exists
        },

        async writeNewFile(fileName: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
            const path = assetFilePath(fileName)

            if ((await getInfoAsync(path)).exists) {
                throw new ManualStorageError('io', 'Asset file already exists and will not be overwritten')
            }

            await writeAsStringAsync(path, bytesToBase64(bytes), { encoding: EncodingType.Base64 })
        },

        async readFile(fileName: string): Promise<Uint8Array<ArrayBuffer> | null> {
            const path = assetFilePath(fileName)

            if (!(await getInfoAsync(path)).exists) {
                return null
            }

            return base64ToBytes(await readAsStringAsync(path, { encoding: EncodingType.Base64 }))
        },

        async deleteFile(fileName: string): Promise<void> {
            const path = assetFilePath(fileName)

            if (!(await getInfoAsync(path)).exists) {
                return
            }

            await deleteAsync(path, { idempotent: true })
        },

        randomId(): string {
            return Crypto.randomUUID().replaceAll('-', '')
        },
    }
}

const expoDigest: ContentDigest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
    return digestToHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes))
}

export const nativeManualStore: ManualStore = createNativeManualStore(createExpoPort(), expoDigest)
