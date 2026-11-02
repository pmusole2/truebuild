/** One nativeID can carry distinct trusted ownership/attribution markers without one shadowing the other. */
export const NATIVE_CAPABILITY_TYPES = [
    'CameraView',
    'ManualPage',
    'PieceTile',
    'PieceViewer',
    'PiecesGrid',
    'VerdictCard',
    'JudgePanel',
    'CompareColumns',
    'CoachMark',
] as const
export type NativeCapabilityType = (typeof NATIVE_CAPABILITY_TYPES)[number]
export type NativeMeterOrigin = 'generated' | 'fallback' | 'shell'

export interface NativeMeterMarkers {
    readonly origin: NativeMeterOrigin | null
    readonly capability: NativeCapabilityType | null
    readonly development: boolean
    readonly documentRoot: string | null
    readonly documentNavigation: string | null
    readonly documentContentBoundary: string | null
}

export class InvalidNativeMeterMarker extends Error {
    constructor() {
        super('invalid_native_meter_marker')
    }
}

const OWNERSHIP_FIELDS = {
    'truebuild-document-root': 'documentRoot',
    'truebuild-document-navigation': 'documentNavigation',
    'truebuild-document-content-boundary': 'documentContentBoundary',
} as const

/** Parse every segment before returning any trusted value; a valid origin cannot hide a bad ownership marker. */
export function parseNativeMeterMarkers(nativeID: unknown): NativeMeterMarkers {
    const result: {
        origin: NativeMeterOrigin | null
        capability: NativeCapabilityType | null
        development: boolean
        documentRoot: string | null
        documentNavigation: string | null
        documentContentBoundary: string | null
    } = {
        origin: null,
        capability: null,
        development: false,
        documentRoot: null,
        documentNavigation: null,
        documentContentBoundary: null,
    }
    if (typeof nativeID !== 'string') return result
    for (const segment of nativeID.split('|')) {
        const separator = segment.indexOf(':')
        const namespace = separator < 0 ? segment : segment.slice(0, separator)
        const value = separator < 0 ? '' : segment.slice(separator + 1)
        if (namespace === 'truebuild-render-origin') {
            if (value !== 'generated' && value !== 'fallback' && value !== 'shell') throw new InvalidNativeMeterMarker()
            if (result.origin !== null && result.origin !== value) throw new InvalidNativeMeterMarker()
            result.origin = value
        } else if (namespace === 'truebuild-capability-internals') {
            const capability = NATIVE_CAPABILITY_TYPES.find((type) => type === value)
            if (capability === undefined || (result.capability !== null && result.capability !== capability))
                throw new InvalidNativeMeterMarker()
            result.capability = capability
        } else if (namespace === 'truebuild-meter-exclude') {
            if (value !== 'development') throw new InvalidNativeMeterMarker()
            result.development = true
        } else if (Object.hasOwn(OWNERSHIP_FIELDS, namespace)) {
            const field = OWNERSHIP_FIELDS[namespace as keyof typeof OWNERSHIP_FIELDS]
            if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value) || (result[field] !== null && result[field] !== value))
                throw new InvalidNativeMeterMarker()
            result[field] = value
        } else if (namespace.startsWith('truebuild-')) throw new InvalidNativeMeterMarker()
    }
    return result
}

/** Ownership wrappers may attribute their own host, never their framework or unrelated document descendants. */
export function nativeMeterOriginInheritance(
    markers: NativeMeterMarkers,
    inherited: NativeMeterOrigin,
): { readonly origin: NativeMeterOrigin; readonly childOrigin: NativeMeterOrigin } {
    const boundary = markers.documentNavigation !== null || markers.documentContentBoundary !== null
    const origin = markers.origin ?? (boundary ? 'shell' : inherited)
    return { origin, childOrigin: boundary ? 'shell' : origin }
}

export function composeNativeMeterMarkers(...ids: readonly (string | null | undefined)[]): string {
    const combined = ids.filter((id): id is string => typeof id === 'string' && id !== '').join('|')
    parseNativeMeterMarkers(combined)
    return [...new Set(combined.split('|'))].join('|')
}
