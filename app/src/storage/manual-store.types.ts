import type { ManualSession } from '@truebuild/contracts'

export interface StoredPageAsset {
    assetId: string
    mimeType: ManualSession['pages'][number]['mimeType']
    bytes: Uint8Array
}

export interface ManualSummary {
    manualId: string
    title: string
    updatedAt: string
    stepCount: number
    reviewStatus: 'unreviewed' | 'reviewed'
}

export interface ManualStore {
    saveManual(session: ManualSession, assets?: readonly StoredPageAsset[]): Promise<void>
    loadManual(manualId: string): Promise<ManualSession | null>
    listManuals(): Promise<ManualSummary[]>
    deleteManual(manualId: string): Promise<void>
    loadPageAsset(assetId: string): Promise<StoredPageAsset | null>
}
