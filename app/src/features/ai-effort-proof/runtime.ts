import type { CameraIntent } from '../capture/controller'
import type { Digest, KeyValueStorage } from '../capture/library'
import type { NormalizedImage, SourceImageAsset } from '../../media/normalize-image'
import type { ProofConfig } from './config'
import { PROOF_ASSETS, PROOF_MANUAL_STEP_IDS, type ProofAsset } from './assets'

export type ProofCaptureContext = Readonly<{ manualIndex: number; pageIndex: number }>
export type ProofPorts = {
    readonly storage: KeyValueStorage
    readonly normalize: (asset: SourceImageAsset) => Promise<NormalizedImage>
    readonly captureAsset: (intent: CameraIntent | null, context: ProofCaptureContext) => SourceImageAsset
}

const uriOf = (asset: ProofAsset): string => `data:image/png;base64,${asset.base64}`

/** The existing fixture witness a parsed manual contains, without any product-name rule. */
export function proofManualIndex(
    stepIds: readonly string[],
    otherParsedManuals: number,
    sourceUris: readonly string[] = [],
): number {
    // A captured source pins an unparsed draft even if another manual finishes parsing before its next page.
    const captured = PROOF_ASSETS.find((asset) => asset.kind === 'page' && sourceUris.includes(uriOf(asset)))
    if (captured !== undefined) return captured.manualIndex
    const known = PROOF_MANUAL_STEP_IDS.findIndex(
        (ids) => ids.length === stepIds.length && ids.every((id, index) => id === stepIds[index]),
    )
    return known >= 0 ? known : Math.max(0, otherParsedManuals) % PROOF_MANUAL_STEP_IDS.length
}

/** Only the source images bundled with this fixture are accepted; no device file or arbitrary URL is read. */
function fixtureImage(source: SourceImageAsset): NormalizedImage {
    const asset = PROOF_ASSETS.find((candidate) => uriOf(candidate) === source.uri)
    if (asset === undefined || source.width !== asset.width || source.height !== asset.height) {
        throw new Error('Unknown native proof source')
    }
    const binary = atob(asset.base64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return { bytes, mimeType: 'image/png', width: asset.width, height: asset.height, uri: source.uri }
}

export function proofCaptureAsset(intent: CameraIntent | null, context: ProofCaptureContext): SourceImageAsset {
    if (
        !Number.isSafeInteger(context.manualIndex) ||
        context.manualIndex < 0 ||
        !Number.isSafeInteger(context.pageIndex) ||
        context.pageIndex < 0
    )
        throw new Error('Invalid native proof source selection')
    const manualIndex = context.manualIndex % 2
    const kind = intent?.kind === 'page' ? 'page' : 'build'
    const choices = PROOF_ASSETS.filter((candidate) => candidate.manualIndex === manualIndex && candidate.kind === kind)
    const asset = choices[context.pageIndex % choices.length]
    if (asset === undefined) throw new Error('Native proof source unavailable')
    return { uri: uriOf(asset), width: asset.width, height: asset.height }
}

/** All library keys live in a new explicit namespace. Reading/saving this fixture cannot mutate the real library. */
export function createProofPorts({
    config,
    storage,
    digest: _digest,
}: {
    readonly config: ProofConfig
    readonly storage: KeyValueStorage
    readonly digest: Digest
}): ProofPorts {
    void _digest
    const prefix = `truebuild/ai-effort-proof/${config.runId}/`
    const scoped: KeyValueStorage = {
        getItem: (key) => storage.getItem(prefix + key),
        setItem: (key, value) => storage.setItem(prefix + key, value),
        removeItem: (key) => storage.removeItem(prefix + key),
        getAllKeys: async () =>
            (await storage.getAllKeys()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
    }
    return {
        storage: scoped,
        normalize: async (asset): Promise<NormalizedImage> => fixtureImage(asset),
        captureAsset: proofCaptureAsset,
    }
}
