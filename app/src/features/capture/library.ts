import { captureBindingSchema, LIMITS, manualSessionSchema, type ManualPage } from '@truebuild/contracts'
import { z } from 'zod'

const PREFIX = 'truebuild/library/'
const MANIFEST = `${PREFIX}v1`
const CHUNK_CHARS = 65_536
const MAX_LIBRARY_BYTES = 24 * 1_048_576
const MAX_MANIFEST_BYTES = 1_048_576
const assetId = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/u)
const captureSchema = z.strictObject({
    binding: captureBindingSchema,
    page: manualSessionSchema.shape.pages.element,
    capturedAt: z.number().finite().nonnegative(),
})
export const libraryEntrySchema = z
    .strictObject({
        session: manualSessionSchema,
        stepIndex: z.number().int().nonnegative().max(199),
        completedStepIds: z.array(z.string().min(1).max(128)).max(200),
        capture: captureSchema.nullable(),
    })
    .superRefine((entry, ctx) => {
        const steps = new Set(entry.session.reviewedSteps.map((step) => step.stepId))
        if (
            entry.completedStepIds.some((id) => !steps.has(id)) ||
            new Set(entry.completedStepIds).size !== entry.completedStepIds.length ||
            (steps.size > 0 && entry.stepIndex >= steps.size)
        ) {
            ctx.addIssue({ code: 'custom', message: 'Invalid progress' })
        }
        const capture = entry.capture
        if (
            capture !== null &&
            (capture.binding.manualId !== entry.session.manualId ||
                capture.binding.revision !== entry.session.revision ||
                capture.binding.stepId !== entry.session.reviewedSteps[entry.stepIndex]?.stepId)
        ) {
            ctx.addIssue({ code: 'custom', message: 'Stale persisted capture' })
        }
    })
const manifestSchema = z
    .strictObject({
        version: z.literal(1),
        entries: z.array(libraryEntrySchema).max(10),
        assets: z
            .array(
                z.strictObject({
                    id: assetId,
                    hash: z.string().regex(/^[a-f0-9]{64}$/u),
                    size: z.number().int().positive().max(LIMITS.imageBytes),
                    chunks: z.number().int().positive().max(86),
                }),
            )
            .max(210),
    })
    .superRefine((manifest, ctx) => {
        if (
            new Set(manifest.entries.map((e) => e.session.manualId)).size !== manifest.entries.length ||
            new Set(manifest.assets.map((a) => a.id)).size !== manifest.assets.length ||
            manifest.assets.reduce((n, a) => n + a.size, 0) > MAX_LIBRARY_BYTES
        ) {
            ctx.addIssue({ code: 'custom', message: 'Library exceeds application storage limit' })
        }
    })
export type LibraryEntry = z.infer<typeof libraryEntrySchema>
type StoredAsset = z.infer<typeof manifestSchema>['assets'][number]
export interface KeyValueStorage {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
    removeItem(key: string): Promise<void>
    getAllKeys(): Promise<readonly string[]>
}
export type Digest = (bytes: Uint8Array) => Promise<string>
export type AssetWrite = { readonly assetId: string; readonly bytes: Uint8Array }

function encode(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
}
function keyOf(asset: StoredAsset, index: number): string {
    return `${PREFIX}bytes/${asset.id}/${asset.hash}/${index}`
}
function pagesOf(entry: LibraryEntry): ManualPage[] {
    return [...entry.session.pages, ...(entry.capture === null ? [] : [entry.capture.page])]
}

/** Manifest-last commits keep the previous library intact on write failure. All bytes are local; no picker URI is saved.
 * Chunked values stay below Android's per-entry cursor limit. Total content and metadata are bounded independently.
 * Only this namespace is cleaned, after a successful manifest commit.
 */
export class LibraryStorage {
    private assets: StoredAsset[] = []
    private restored = false
    private queue: Promise<void> = Promise.resolve()
    constructor(
        private readonly kv: KeyValueStorage,
        private readonly digest: Digest,
    ) {}

    async restore(): Promise<{ entries: LibraryEntry[]; warning: string | null }> {
        this.restored = false
        try {
            const raw = await this.kv.getItem(MANIFEST)
            this.restored = true
            if (raw === null) {
                return { entries: [], warning: null }
            }
            if (raw.length > MAX_MANIFEST_BYTES || new TextEncoder().encode(raw).length > MAX_MANIFEST_BYTES) {
                throw new Error('Metadata limit')
            }
            const manifest = manifestSchema.parse(JSON.parse(raw))
            this.assets = manifest.assets
            const entries: LibraryEntry[] = []
            for (const entry of manifest.entries) {
                try {
                    for (const page of pagesOf(entry)) {
                        await this.readAsset(page)
                    }
                    entries.push(entry)
                } catch {
                    /* One corrupt manual does not discard the others. */
                }
            }
            return {
                entries,
                warning:
                    entries.length === manifest.entries.length
                        ? null
                        : 'Some manuals could not be restored. Their local images are missing or damaged. Scan them again.',
            }
        } catch {
            return {
                entries: [],
                warning: 'The local library could not be restored. Storage may be unavailable or damaged.',
            }
        }
    }

    async readAsset(page: Pick<ManualPage, 'assetId' | 'contentHash'>): Promise<Uint8Array<ArrayBuffer>> {
        const asset = this.assets.find((a) => a.id === page.assetId && a.hash === page.contentHash)
        if (asset === undefined) {
            throw new Error('Missing local image')
        }
        let encoded = ''
        for (let i = 0; i < asset.chunks; i++) {
            const chunk = await this.kv.getItem(keyOf(asset, i))
            if (chunk === null || chunk.length > CHUNK_CHARS) {
                throw new Error('Missing image chunk')
            }
            encoded += chunk
        }
        if (encoded.length !== 4 * Math.ceil(asset.size / 3)) {
            throw new Error('Image length mismatch')
        }
        const binary = atob(encoded)
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        if (bytes.byteLength !== asset.size || (await this.digest(bytes)) !== asset.hash) {
            throw new Error('Damaged image')
        }
        return bytes
    }

    save(entries: readonly LibraryEntry[], writes: readonly AssetWrite[] = []): Promise<void> {
        const save = this.queue.then(() => this.commit(entries, writes))
        this.queue = save.catch((): void => undefined)
        return save
    }

    private async commit(entries: readonly LibraryEntry[], writes: readonly AssetWrite[]): Promise<void> {
        if (!this.restored) {
            await this.restore()
            if (!this.restored) {
                throw new Error('Storage unavailable')
            }
        }
        if (
            entries.length > 10 ||
            writes.length > 210 ||
            writes.reduce((sum, write) => sum + write.bytes.length, 0) > MAX_LIBRARY_BYTES
        ) {
            throw new Error('Library staging limit')
        }
        const referencedIds = new Set(entries.flatMap(pagesOf).map((page) => page.assetId))
        if (writes.some((write) => !referencedIds.has(write.assetId))) {
            throw new Error('Unreferenced local image')
        }
        const assets = [...this.assets]
        const encodedWrites: { asset: StoredAsset; encoded: string }[] = []
        for (const write of writes) {
            assetId.parse(write.assetId)
            if (write.bytes.length === 0 || write.bytes.length > LIMITS.imageBytes) {
                throw new Error('Image limit')
            }
            const hash = await this.digest(write.bytes)
            const encoded = encode(write.bytes)
            const asset = {
                id: write.assetId,
                hash,
                size: write.bytes.length,
                chunks: Math.ceil(encoded.length / CHUNK_CHARS),
            }
            const existing = assets.find((a) => a.id === asset.id)
            if (existing !== undefined && existing.hash !== hash) {
                throw new Error('Immutable asset identity')
            }
            if (existing === undefined) {
                assets.push(asset)
            }
            encodedWrites.push({ asset, encoded })
        }
        const pages = entries.flatMap(pagesOf)
        const referenced = assets.filter((a) => pages.some((p) => p.assetId === a.id && p.contentHash === a.hash))
        if (pages.some((p) => !referenced.some((a) => a.id === p.assetId && a.hash === p.contentHash))) {
            throw new Error('Missing local image')
        }
        const manifest = manifestSchema.parse({ version: 1, entries, assets: referenced })
        const json = JSON.stringify(manifest)
        if (json.length > MAX_MANIFEST_BYTES || new TextEncoder().encode(json).length > MAX_MANIFEST_BYTES) {
            throw new Error('Library metadata limit')
        }
        // Reclaim abandoned writes from a prior crash before allocating more bounded storage.
        await this.cleanup(assets.filter((a) => this.assets.some((old) => old.id === a.id && old.hash === a.hash)))
        for (const { asset, encoded } of encodedWrites) {
            for (let i = 0; i < asset.chunks; i++) {
                await this.kv.setItem(keyOf(asset, i), encoded.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS))
            }
        }
        await this.kv.setItem(MANIFEST, json)
        this.assets = referenced
        // A cleanup failure cannot roll back an already durable manifest.
        await this.cleanup(referenced).catch((): void => undefined)
    }

    private async cleanup(assets: readonly StoredAsset[]): Promise<void> {
        const keep = new Set(assets.flatMap((a) => Array.from({ length: a.chunks }, (_, i) => keyOf(a, i))))
        for (const key of await this.kv.getAllKeys()) {
            if (key.startsWith(`${PREFIX}bytes/`) && !keep.has(key)) {
                await this.kv.removeItem(key)
            }
        }
    }
}
