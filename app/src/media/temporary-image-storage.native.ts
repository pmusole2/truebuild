import { File } from 'expo-file-system'

/** Called only for exact URIs registered as app-owned camera or normalization outputs, never by path scanning. */
export async function removeTemporaryImage(uri: string): Promise<void> {
    if (!uri.startsWith('file://')) {
        return
    }
    const file = new File(uri)
    if (file.exists) {
        file.delete()
    }
}
