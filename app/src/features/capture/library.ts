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
function assetKey(asset: StoredAsset): string {
    return `${asset.id}/${asset.hash}`
}
function containsChunk(asset: StoredAsset, key: string): boolean {
    const prefix = `${PREFIX}bytes/${assetKey(asset)}/`
    if (!key.startsWith(prefix)) return false
    const suffix = key.slice(prefix.length)
    const index = Number(suffix)
    return Number.isInteger(index) && index >= 0 && index < asset.chunks && String(index) === suffix
}
function pagesOf(entry: LibraryEntry): ManualPage[] {
    return [...entry.session.pages, ...(entry.capture === null ? [] : [entry.capture.page])]
}

/** Manifest-last commits keep the previous library intact on write failure. All bytes are local; no picker URI is saved.
 * Chunked values stay below Android's per-entry cursor limit. Total content and metadata are bounded independently.
 * Only this namespace is cleaned, after a successful manifest commit.
 */
export type LibraryRestore = { entries: LibraryEntry[]; warning: string | null; readOnly: boolean }
class DamagedLocalAssetError extends Error {}

export class LibraryStorage {
    private assets: StoredAsset[] = []
    private restoreAttempted = false
    private writable = false
    private retainedEntries: LibraryEntry[] = []
    private queue: Promise<void> = Promise.resolve()
    private readonly reads = new Map<string, { asset: StoredAsset; count: number }>()
    private cleanupQueued = false
    constructor(
        private readonly kv: KeyValueStorage,
        private readonly digest: Digest,
    ) {}

    async restore(): Promise<LibraryRestore> {
        this.restoreAttempted = true
        this.writable = false
        try {
            const raw = await this.kv.getItem(MANIFEST)
            if (raw === null) {
                if (
                    this.retainedEntries.length > 0 ||
                    this.assets.length > 0 ||
                    (await this.kv.getAllKeys()).some((key) => key.startsWith(`${PREFIX}bytes/`))
                ) {
                    throw new Error('Saved manifest is unavailable; retain original image chunks')
                }
                this.assets = []
                this.retainedEntries = []
                this.writable = true
                return { entries: [], warning: null, readOnly: false }
            }
            if (raw.length > MAX_MANIFEST_BYTES || new TextEncoder().encode(raw).length > MAX_MANIFEST_BYTES) {
                throw new Error('Metadata limit')
            }
            const manifest = manifestSchema.parse(JSON.parse(raw))
            this.assets = manifest.assets
            // Keep all validated facts and photo references if any asset IO subsequently fails.
            this.retainedEntries = manifest.entries
            for (const entry of manifest.entries) {
                for (const page of pagesOf(entry)) {
                    await this.readAsset(page)
                }
            }
            this.writable = true
            return {
                entries: this.retainedEntries,
                readOnly: false,
                warning: null,
            }
        } catch {
            return {
                entries: this.retainedEntries,
                readOnly: true,
                warning:
                    'Local library is read-only because it could not be restored. Original data is retained. Retry reading the library when storage is available.',
            }
        }
    }

    async readAsset(page: Pick<ManualPage, 'assetId' | 'contentHash'>): Promise<Uint8Array<ArrayBuffer>> {
        let leased: StoredAsset | undefined
        try {
            const asset = this.assets.find(
                (candidate) => candidate.id === page.assetId && candidate.hash === page.contentHash,
            )
            if (asset === undefined) throw new DamagedLocalAssetError('Missing local image')
            const key = assetKey(asset)
            const read = this.reads.get(key)
            if (read === undefined) this.reads.set(key, { asset, count: 1 })
            else read.count++
            leased = asset
            return await this.readVerifiedAsset(asset)
        } catch (error: unknown) {
            this.writable = false
            throw error
        } finally {
            if (leased !== undefined) {
                const key = assetKey(leased)
                const read = this.reads.get(key)!
                if (--read.count === 0) {
                    this.reads.delete(key)
                    if (!this.assets.some((asset) => assetKey(asset) === key)) this.deferCleanup()
                }
            }
        }
    }

    private async readVerifiedAsset(asset: StoredAsset): Promise<Uint8Array<ArrayBuffer>> {
        let encoded = ''
        for (let i = 0; i < asset.chunks; i++) {
            const chunk = await this.kv.getItem(keyOf(asset, i))
            if (chunk === null || chunk.length > CHUNK_CHARS) {
                throw new DamagedLocalAssetError('Missing image chunk')
            }
            encoded += chunk
        }
        if (encoded.length !== 4 * Math.ceil(asset.size / 3)) {
            throw new DamagedLocalAssetError('Image length mismatch')
        }
        let binary: string
        try {
            binary = atob(encoded)
        } catch {
            throw new DamagedLocalAssetError('Invalid local image encoding')
        }
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        if (bytes.byteLength !== asset.size || (await this.digest(bytes)) !== asset.hash) {
            throw new DamagedLocalAssetError('Damaged image')
        }
        return bytes
    }

    save(entries: readonly LibraryEntry[], writes: readonly AssetWrite[] = []): Promise<void> {
        const save = this.queue
            .then(() => this.commit(entries, writes))
            .catch((error: unknown): never => {
                this.writable = false
                throw error
            })
        this.queue = save.catch((): void => undefined)
        return save
    }

    private async commit(entries: readonly LibraryEntry[], writes: readonly AssetWrite[]): Promise<void> {
        if (!this.restoreAttempted) {
            await this.restore()
        }
        if (!this.writable) {
            throw new Error('Local library is read-only. Storage unavailable; explicitly retry restoration.')
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
                encodedWrites.push({ asset, encoded })
            }
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
        this.retainedEntries = manifest.entries
        // A cleanup failure cannot roll back an already durable manifest.
        await this.cleanup(referenced).catch((): void => undefined)
    }

    private async cleanup(assets: readonly StoredAsset[]): Promise<void> {
        const keep = new Set(assets.flatMap((a) => Array.from({ length: a.chunks }, (_, i) => keyOf(a, i))))
        for (const key of await this.kv.getAllKeys()) {
            if (!this.writable) return
            // Recheck current registry and read leases at removal, including leases acquired during KV awaits.
            const protectedChunk =
                this.assets.some((asset) => containsChunk(asset, key)) ||
                [...this.reads.values()].some((read) => containsChunk(read.asset, key))
            if (key.startsWith(`${PREFIX}bytes/`) && !keep.has(key) && !protectedChunk) {
                await this.kv.removeItem(key)
            }
        }
    }

    private deferCleanup(): void {
        if (this.cleanupQueued) return
        this.cleanupQueued = true
        // Never await this from a read: restore/commit can await that read while already owning the save queue.
        const cleanup = this.queue.then(async (): Promise<void> => {
            this.cleanupQueued = false
            if (this.writable) await this.cleanup(this.assets)
        })
        // Cleanup is best effort after a durable manifest; future commits also reclaim abandoned chunks.
        this.queue = cleanup.catch((): void => undefined)
    }
}
