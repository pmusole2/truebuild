import * as Crypto from 'expo-crypto'
import { deviceStorage } from './device-storage'
import { API_BASE_URL, API_SECRET, GENERATIVE_UI } from '../../config'
import { ModelApiClient } from '../../api/model-client'
import { normalizeImage } from '../../media/normalize-image'
import { locateInPhoto } from '../assembly/localize'
import { nativeProofConfig } from '../ai-effort-proof/config'
import type * as ProofRuntime from '../ai-effort-proof/runtime'
import { CaptureController } from './controller'
import { LibraryStorage, type Digest } from './library'
import { parseDevScenario, withDevScenario } from '../screens/dev-controls'
import { ScreenStore } from '../screens/screen-store'

export const imageDigest: Digest = async (bytes): Promise<string> => {
    const result = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes))
    return [...new Uint8Array(result)].map((n) => n.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 of a string as lowercase hex: the digest every screen document's context key is verified with. */
export const textDigest = async (text: string): Promise<string> =>
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX })

/**
 * The native proof's device IO, or null in every ordinary run. It exists only in a development bundle that sets the
 * explicit fixture flag against the isolated loopback fixture API (an invalid combination throws, so the app does not
 * start half-configured), and it replaces nothing but where the library is stored and which bundled images count as a
 * source. The model client, screen store, localizer and controller are the real ones. The require sits behind
 * `__DEV__` so a production bundle never contains the fixture images.
 */
export function proofPorts(): ProofRuntime.ProofPorts | null {
    // The whole branch sits inside `if (__DEV__)`: Metro folds that to nothing in a production bundle, which removes the
    // require (and with it the fixture images) before dependencies are collected. An early return would not.
    if (__DEV__) {
        const config = nativeProofConfig(API_BASE_URL)
        if (config !== null) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const runtime = require('../ai-effort-proof/runtime') as typeof ProofRuntime
            return runtime.createProofPorts({ config, storage: deviceStorage, digest: imageDigest })
        }
    }
    return null
}

/** Production wiring: the real model API client, device storage and image normalization. */
export function createController(screens: ScreenStore | null = null): CaptureController {
    const proof = proofPorts()
    return new CaptureController({
        screenContext: (session, stepId) => screens?.shownGuide(session.manualId, session.revision, stepId) ?? null,
        storage: new LibraryStorage(proof?.storage ?? deviceStorage, imageDigest),
        client: new ModelApiClient({ baseUrl: API_BASE_URL, secret: API_SECRET }),
        normalize: proof?.normalize ?? normalizeImage,
        digest: imageDigest,
        id: (): string => Crypto.randomUUID(),
        locate: locateInPhoto,
    })
}

/**
 * The session's screen store on its own stateless client, or null when generated screens are off (the original app,
 * with no screens request ever made). The controller keeps its own client; they share only configuration.
 */
export function createScreens(): ScreenStore | null {
    if (GENERATIVE_UI === 'off') return null
    const client = new ModelApiClient({ baseUrl: API_BASE_URL, secret: API_SECRET })
    // Development builds only: EXPO_PUBLIC_SCREENS_TEST_DELAY_MS and EXPO_PUBLIC_SCREENS_TEST_FAIL force the slow and
    // native-fallback scenarios for evidence. A production build never reads them.
    const scenario = __DEV__
        ? parseDevScenario(process.env.EXPO_PUBLIC_SCREENS_TEST_DELAY_MS, process.env.EXPO_PUBLIC_SCREENS_TEST_FAIL)
        : null
    return new ScreenStore({
        client: withDevScenario(client, scenario),
        mode: GENERATIVE_UI,
        id: (): string => Crypto.randomUUID(),
        digest: textDigest,
    })
}
