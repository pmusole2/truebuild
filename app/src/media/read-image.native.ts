import { File, FileMode } from 'expo-file-system'
import { MediaRejectedError } from './media-errors'

export async function readImage(uri: string, cap: number): Promise<Uint8Array<ArrayBuffer>> {
    const file = new File(uri)
    if (!file.exists || file.size <= 0) {
        throw new MediaRejectedError('unreadable')
    }
    if (file.size > cap) {
        throw new MediaRejectedError('oversize')
    }
    const handle = file.open(FileMode.ReadOnly)
    try {
        const bytes = await handle.readBytes(cap + 1)
        if (bytes.length > cap) {
            throw new MediaRejectedError('oversize')
        }
        return bytes
    } finally {
        handle.close()
    }
}
