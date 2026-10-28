import * as Crypto from 'expo-crypto'
import { deviceStorage } from './device-storage'
import { API_BASE_URL, API_SECRET } from '../../config'
import { ModelApiClient } from '../../api/model-client'
import { normalizeImage } from '../../media/normalize-image'
import { CaptureController } from './controller'
import { LibraryStorage, type Digest } from './library'

export const imageDigest: Digest = async (bytes): Promise<string> => {
    const result = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes))
    return [...new Uint8Array(result)].map((n) => n.toString(16).padStart(2, '0')).join('')
}

/** Production wiring: the real model API client, device storage and image normalization. */
export function createController(): CaptureController {
    return new CaptureController({
        storage: new LibraryStorage(deviceStorage, imageDigest),
        client: new ModelApiClient({ baseUrl: API_BASE_URL, secret: API_SECRET }),
        normalize: normalizeImage,
        digest: imageDigest,
        id: (): string => Crypto.randomUUID(),
    })
}
