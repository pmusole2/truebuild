import { removeTemporaryImage } from './temporary-image-storage'

const owned = new Set<string>()

/** Register only a URI just returned by our camera or saveAsync. Picking a user library photo never registers it. */
export function ownTemporaryImage(uri: string): void {
    if (uri.startsWith('file://') || uri.startsWith('blob:')) {
        owned.add(uri)
    }
}
export async function releaseTemporaryImage(uri: string): Promise<void> {
    if (!owned.has(uri)) {
        return
    }
    try {
        await removeTemporaryImage(uri)
        owned.delete(uri)
    } catch {
        /* Keep ownership for a later explicit cleanup attempt; never expose raw OS paths/errors. */
    }
}
