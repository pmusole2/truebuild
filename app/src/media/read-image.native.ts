import { File, FileMode } from 'expo-file-system'
import { MediaRejectedError } from './media-errors'

function checkedFile(uri: string, cap: number): File {
    const file = new File(uri)
    if (!file.exists || file.size <= 0) {
        throw new MediaRejectedError('unreadable')
    }
    if (file.size > cap) {
        throw new MediaRejectedError('oversize')
    }
    return file
}
/** Raw normalization input needs only a size probe before Expo's bounded native decoder loads it. */
export async function probeImage(uri: string, cap: number): Promise<void> {
    checkedFile(uri, cap)
}

export async function readImage(uri: string, cap: number): Promise<Uint8Array<ArrayBuffer>> {
    const file = checkedFile(uri, cap)
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
